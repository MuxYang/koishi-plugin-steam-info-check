// steam-speed: authenticated reverse proxy for the Steam acceleration protocol.
//
// The process listens with plain HTTP so an edge service (ESA, nginx, etc.) can
// terminate TLS. Only outbound connections to Steam use TLS.

#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cctype>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <list>
#include <mutex>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET socket_t;
#define INVALID_SOCK INVALID_SOCKET
#define close_socket closesocket
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
typedef int socket_t;
#define INVALID_SOCK (-1)
#define close_socket ::close
#endif

namespace {

constexpr size_t kIvLength = 12;
constexpr size_t kTagLength = 16;
constexpr long long kMaxClockSkewMs = 10000;
constexpr long long kReplayWindowMs = 30000;
constexpr size_t kMaxRequestHead = 16384;
constexpr size_t kMaxResponseHead = 131072;
constexpr long long kMaxBodyLength = 64LL * 1024 * 1024;
constexpr size_t kResourceCacheLimit = 512ULL * 1024 * 1024;
constexpr size_t kMaxCachedResource = 16ULL * 1024 * 1024;
constexpr size_t kMaxAssetsPerPage = 256;

struct Config {
  std::vector<unsigned char> key;
  std::string bindHost = "0.0.0.0";
  int port = 8467;
  std::string publicScheme = "https";
  std::string publicHost;
  int upstreamTimeoutMs = 20000;
  bool trustProxy = true;
  bool logRequests = true;
  int maxConnections = 128;
  int ratePerMinute = 240;
  int rateGlobalPerMinute = 2400;
};

Config g_cfg;
SSL_CTX* g_clientCtx = nullptr;
std::atomic<int> g_active{0};
std::atomic<bool> g_stop{false};
socket_t g_listenFd = INVALID_SOCK;

struct CachedResource {
  std::string body;
  std::string contentType;
};

struct CacheEntry {
  std::shared_ptr<const CachedResource> resource;
  std::list<std::string>::iterator lru;
};

class ResourceCache {
 public:
  bool get(const std::string& hash, std::shared_ptr<const CachedResource>& resource) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = entries_.find(hash);
    if (it == entries_.end()) return false;
    lru_.splice(lru_.begin(), lru_, it->second.lru);
    resource = it->second.resource;
    return true;
  }

  void put(const std::string& hash, std::string body, std::string contentType) {
    if (body.empty() || body.size() > kMaxCachedResource || body.size() > kResourceCacheLimit) return;
    std::lock_guard<std::mutex> lock(mutex_);
    auto old = entries_.find(hash);
    if (old != entries_.end()) {
      used_ -= old->second.resource->body.size();
      lru_.erase(old->second.lru);
      entries_.erase(old);
    }
    while (used_ + body.size() > kResourceCacheLimit && !lru_.empty()) {
      auto victim = entries_.find(lru_.back());
      if (victim != entries_.end()) {
        used_ -= victim->second.resource->body.size();
        entries_.erase(victim);
      }
      lru_.pop_back();
    }
    lru_.push_front(hash);
    entries_.emplace(hash, CacheEntry{std::make_shared<CachedResource>(CachedResource{std::move(body), std::move(contentType)}), lru_.begin()});
    used_ += body.size();
  }

  bool lookup_url(const std::string& url, std::string& hash) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = urlToHash_.find(url);
    if (it == urlToHash_.end()) return false;
    hash = it->second;
    return true;
  }

  void remember_url(const std::string& url, const std::string& hash) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (urlToHash_.find(url) == urlToHash_.end()) {
      urlOrder_.push_back(url);
      if (urlOrder_.size() > 8192) {
        urlToHash_.erase(urlOrder_.front());
        urlOrder_.pop_front();
      }
    }
    urlToHash_[url] = hash;
  }

 private:
  std::mutex mutex_;
  std::unordered_map<std::string, CacheEntry> entries_;
  std::list<std::string> lru_;
  std::unordered_map<std::string, std::string> urlToHash_;
  std::list<std::string> urlOrder_;
  size_t used_ = 0;
};

ResourceCache g_resourceCache;

long long now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

std::string env_string(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  return value ? std::string(value) : fallback;
}

bool parse_int(const std::string& text, int& value) {
  if (text.empty()) return false;
  char* end = nullptr;
  errno = 0;
  long parsed = std::strtol(text.c_str(), &end, 10);
  if (errno != 0 || !end || *end != '\0' || parsed < 1 || parsed > 65535) return false;
  value = static_cast<int>(parsed);
  return true;
}

bool hex_value(char c, unsigned char& value) {
  if (c >= '0' && c <= '9') { value = static_cast<unsigned char>(c - '0'); return true; }
  if (c >= 'a' && c <= 'f') { value = static_cast<unsigned char>(c - 'a' + 10); return true; }
  if (c >= 'A' && c <= 'F') { value = static_cast<unsigned char>(c - 'A' + 10); return true; }
  return false;
}

bool decode_hex(const std::string& text, std::vector<unsigned char>& out) {
  if (text.size() % 2 != 0) return false;
  out.clear();
  out.reserve(text.size() / 2);
  for (size_t i = 0; i < text.size(); i += 2) {
    unsigned char hi = 0, lo = 0;
    if (!hex_value(text[i], hi) || !hex_value(text[i + 1], lo)) return false;
    out.push_back(static_cast<unsigned char>((hi << 4) | lo));
  }
  return true;
}

std::string lower_ascii(const std::string& text) {
  std::string out = text;
  for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

std::string sha256_hex(const std::string& data) {
  unsigned char digest[EVP_MAX_MD_SIZE]{};
  unsigned int length = 0;
  if (EVP_Digest(data.data(), data.size(), digest, &length, EVP_sha256(), nullptr) != 1 || length != 32) return "";
  static const char hex[] = "0123456789abcdef";
  std::string result(64, '0');
  for (size_t i = 0; i < length; ++i) {
    result[i * 2] = hex[digest[i] >> 4];
    result[i * 2 + 1] = hex[digest[i] & 15];
  }
  return result;
}

std::string trim(const std::string& text) {
  size_t begin = 0, end = text.size();
  while (begin < end && (text[begin] == ' ' || text[begin] == '\t')) ++begin;
  while (end > begin && (text[end - 1] == ' ' || text[end - 1] == '\t')) --end;
  return text.substr(begin, end - begin);
}

bool starts_with(const std::string& text, const std::string& prefix) {
  return text.size() >= prefix.size() && text.compare(0, prefix.size(), prefix) == 0;
}

bool ends_with(const std::string& text, const std::string& suffix) {
  return text.size() >= suffix.size() && text.compare(text.size() - suffix.size(), suffix.size(), suffix) == 0;
}

int base64url_value(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}

bool base64url_decode(const std::string& text, std::vector<unsigned char>& out) {
  if (text.empty() || text.size() > 8192) return false;
  out.clear();
  out.reserve(text.size() * 3 / 4 + 3);
  uint32_t buffer = 0;
  int bits = -8;
  for (unsigned char c : text) {
    int value = base64url_value(c);
    if (value < 0) return false;
    buffer = (buffer << 6) | static_cast<uint32_t>(value);
    bits += 6;
    if (bits >= 0) {
      out.push_back(static_cast<unsigned char>((buffer >> bits) & 0xff));
      bits -= 8;
    }
  }
  return out.size() >= kIvLength + kTagLength + 1;
}

std::string base64url_encode(const unsigned char* data, size_t length) {
  static const char table[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  out.reserve((length + 2) / 3 * 4);
  size_t i = 0;
  while (i + 3 <= length) {
    uint32_t value = (static_cast<uint32_t>(data[i]) << 16) |
                     (static_cast<uint32_t>(data[i + 1]) << 8) |
                     static_cast<uint32_t>(data[i + 2]);
    out.push_back(table[(value >> 18) & 63]);
    out.push_back(table[(value >> 12) & 63]);
    out.push_back(table[(value >> 6) & 63]);
    out.push_back(table[value & 63]);
    i += 3;
  }
  if (i < length) {
    uint32_t value = static_cast<uint32_t>(data[i]) << 16;
    out.push_back(table[(value >> 18) & 63]);
    if (i + 1 < length) {
      value |= static_cast<uint32_t>(data[i + 1]) << 8;
      out.push_back(table[(value >> 12) & 63]);
      out.push_back(table[(value >> 6) & 63]);
    } else {
      out.push_back(table[(value >> 12) & 63]);
    }
  }
  return out;
}

bool aes_gcm_decrypt(const std::vector<unsigned char>& raw,
                     const std::vector<unsigned char>& key,
                     std::string& plaintext) {
  if (key.size() != 32 || raw.size() < kIvLength + kTagLength + 1) return false;
  const unsigned char* iv = raw.data();
  const unsigned char* ciphertext = raw.data() + kIvLength;
  int ciphertextLength = static_cast<int>(raw.size() - kIvLength - kTagLength);
  const unsigned char* tag = raw.data() + raw.size() - kTagLength;

  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (!ctx) return false;
  std::vector<unsigned char> output(static_cast<size_t>(ciphertextLength) + kTagLength);
  int written = 0;
  int finalWritten = 0;
  bool ok = EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1 &&
            EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, static_cast<int>(kIvLength), nullptr) == 1 &&
            EVP_DecryptInit_ex(ctx, nullptr, nullptr, key.data(), iv) == 1 &&
            EVP_DecryptUpdate(ctx, output.data(), &written, ciphertext, ciphertextLength) == 1 &&
            EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, static_cast<int>(kTagLength),
                                const_cast<unsigned char*>(tag)) == 1 &&
            EVP_DecryptFinal_ex(ctx, output.data() + written, &finalWritten) == 1;
  EVP_CIPHER_CTX_free(ctx);
  if (!ok) return false;
  plaintext.assign(reinterpret_cast<const char*>(output.data()),
                   static_cast<size_t>(written + finalWritten));
  return true;
}

bool aes_gcm_encrypt_for_test(const std::string& plaintext,
                              const std::vector<unsigned char>& key,
                              std::vector<unsigned char>& output) {
  if (key.size() != 32) return false;
  std::vector<unsigned char> iv(kIvLength);
  if (RAND_bytes(iv.data(), static_cast<int>(iv.size())) != 1) return false;
  std::vector<unsigned char> ciphertext(plaintext.size() + 16);
  std::vector<unsigned char> tag(kTagLength);
  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (!ctx) return false;
  int written = 0;
  int finalWritten = 0;
  bool ok = EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1 &&
            EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, static_cast<int>(kIvLength), nullptr) == 1 &&
            EVP_EncryptInit_ex(ctx, nullptr, nullptr, key.data(), iv.data()) == 1 &&
            EVP_EncryptUpdate(ctx, ciphertext.data(), &written,
                              reinterpret_cast<const unsigned char*>(plaintext.data()),
                              static_cast<int>(plaintext.size())) == 1 &&
            EVP_EncryptFinal_ex(ctx, ciphertext.data() + written, &finalWritten) == 1 &&
            EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, static_cast<int>(kTagLength), tag.data()) == 1;
  EVP_CIPHER_CTX_free(ctx);
  if (!ok) return false;
  output.clear();
  output.insert(output.end(), iv.begin(), iv.end());
  output.insert(output.end(), ciphertext.begin(), ciphertext.begin() + written + finalWritten);
  output.insert(output.end(), tag.begin(), tag.end());
  return true;
}

void log_message(const char* level, const char* format, ...) {
  std::time_t timestamp = std::time(nullptr);
  std::tm broken{};
#ifdef _WIN32
  gmtime_s(&broken, &timestamp);
#else
  gmtime_r(&timestamp, &broken);
#endif
  char stamp[32]{};
  std::strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%SZ", &broken);
  std::fprintf(stderr, "%s %s ", stamp, level);
  va_list args;
  va_start(args, format);
  std::vfprintf(stderr, format, args);
  va_end(args);
  std::fputc('\n', stderr);
  std::fflush(stderr);
}

bool load_config(Config& config, std::string& error) {
  std::string keyHex = env_string("SECRET_KEY", "");
  if (!decode_hex(keyHex, config.key) || config.key.size() != 32) {
    error = "SECRET_KEY must be exactly 64 hexadecimal characters";
    return false;
  }
  config.bindHost = env_string("BIND_HOST", "0.0.0.0");
  if (!parse_int(env_string("PORT", "8467"), config.port)) {
    error = "PORT is not a valid TCP port";
    return false;
  }
  config.publicScheme = lower_ascii(env_string("PUBLIC_SCHEME", "https"));
  if (config.publicScheme != "http" && config.publicScheme != "https") {
    error = "PUBLIC_SCHEME must be http or https";
    return false;
  }
  config.publicHost = trim(env_string("PUBLIC_HOST", ""));
  if (config.publicHost.find_first_of(" \t\r\n/\\") != std::string::npos) {
    error = "PUBLIC_HOST contains invalid characters";
    return false;
  }
  int timeout = 0;
  if (!parse_int(env_string("UPSTREAM_TIMEOUT_MS", "20000"), timeout) || timeout < 1000 || timeout > 120000) {
    error = "UPSTREAM_TIMEOUT_MS must be between 1000 and 120000";
    return false;
  }
  config.upstreamTimeoutMs = timeout;
  config.trustProxy = env_string("TRUST_PROXY", "1") != "0";
  config.logRequests = env_string("LOG_REQUESTS", "1") != "0";
  int value = 0;
  if (parse_int(env_string("MAX_CONNECTIONS", "128"), value) && value >= 1 && value <= 4096) {
    config.maxConnections = value;
  }
  if (parse_int(env_string("RATE_LIMIT_PER_MINUTE", "240"), value) && value >= 1) {
    config.ratePerMinute = value;
  }
  if (parse_int(env_string("RATE_LIMIT_GLOBAL_PER_MINUTE", "2400"), value) && value >= 1) {
    config.rateGlobalPerMinute = value;
  }
  return true;
}

struct TokenInfo {
  std::string clientIp;
  long long timestamp = 0;
  std::string requestId;
};

bool extract_token(const std::string& userAgent, std::string& token) {
  const std::string marker = "SteamSpeedService/";
  size_t start = userAgent.find(marker);
  if (start == std::string::npos) return false;
  start += marker.size();
  size_t end = start;
  while (end < userAgent.size()) {
    unsigned char c = static_cast<unsigned char>(userAgent[end]);
    if (!(std::isalnum(c) || c == '-' || c == '_')) break;
    ++end;
  }
  if (end == start || end - start > 4096) return false;
  token = userAgent.substr(start, end - start);
  return true;
}

bool parse_unsigned(const std::string& text, long long& value) {
  if (text.empty() || text.size() > 18) return false;
  long long parsed = 0;
  for (char c : text) {
    if (c < '0' || c > '9') return false;
    parsed = parsed * 10 + (c - '0');
  }
  value = parsed;
  return true;
}

bool parse_payload(const std::string& plaintext, TokenInfo& info) {
  size_t last = plaintext.rfind(':');
  if (last == std::string::npos || last == 0) return false;
  size_t previous = plaintext.rfind(':', last - 1);
  if (previous == std::string::npos || previous == 0) return false;

  info.clientIp = plaintext.substr(0, previous);
  std::string timestamp = plaintext.substr(previous + 1, last - previous - 1);
  info.requestId = plaintext.substr(last + 1);

  if (info.clientIp.size() < 3 || info.clientIp.size() > 45) return false;
  for (char c : info.clientIp) {
    if (!(std::isxdigit(static_cast<unsigned char>(c)) || c == ':' || c == '.')) return false;
  }
  if (!parse_unsigned(timestamp, info.timestamp)) return false;
  if (info.requestId.size() < 8 || info.requestId.size() > 128) return false;
  for (char c : info.requestId) {
    unsigned char u = static_cast<unsigned char>(c);
    if (!(std::isalnum(u) || c == '.' || c == '_' || c == '-')) return false;
  }
  return true;
}

class ReplayGuard {
 public:
  bool accept(const std::string& requestId, long long now) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (now - lastSweep_ > 5000) {
      sweep(now);
      lastSweep_ = now;
    }
    auto it = seen_.find(requestId);
    if (it != seen_.end() && it->second > now) return false;
    if (seen_.size() >= kMaxEntries) return false;
    seen_[requestId] = now + kReplayWindowMs;
    return true;
  }

 private:
  static constexpr size_t kMaxEntries = 50000;

  void sweep(long long now) {
    for (auto it = seen_.begin(); it != seen_.end();) {
      if (it->second <= now) {
        it = seen_.erase(it);
      } else {
        ++it;
      }
    }
  }

  std::mutex mutex_;
  std::unordered_map<std::string, long long> seen_;
  long long lastSweep_ = 0;
};

class RateLimiter {
 public:
  bool allow(const std::string& ip, long long now, int perMinute, int globalPerMinute) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (now >= globalReset_) {
      globalReset_ = now + 60000;
      globalCount_ = 0;
    }
    if (globalCount_ >= globalPerMinute) return false;

    auto it = buckets_.find(ip);
    if (it == buckets_.end() || now >= it->second.reset) {
      it = buckets_.emplace(ip, Bucket{0, now + 60000}).first;
    }
    if (it->second.count >= perMinute) return false;
    ++it->second.count;
    ++globalCount_;

    if (buckets_.size() > 20000) {
      for (auto current = buckets_.begin(); current != buckets_.end();) {
        if (current->second.reset <= now) {
          current = buckets_.erase(current);
        } else {
          ++current;
        }
      }
    }
    return true;
  }

 private:
  struct Bucket {
    int count = 0;
    long long reset = 0;
  };
  std::mutex mutex_;
  std::unordered_map<std::string, Bucket> buckets_;
  int globalCount_ = 0;
  long long globalReset_ = 0;
};

bool authenticate(const Config& config, ReplayGuard& replay,
                  const std::string& userAgent, TokenInfo& info, std::string& error) {
  std::string token;
  if (!extract_token(userAgent, token)) {
    error = "missing token";
    return false;
  }
  std::vector<unsigned char> raw;
  if (!base64url_decode(token, raw)) {
    error = "invalid token encoding";
    return false;
  }
  std::string plaintext;
  if (!aes_gcm_decrypt(raw, config.key, plaintext)) {
    error = "token authentication failed";
    return false;
  }
  if (!parse_payload(plaintext, info)) {
    error = "invalid token payload";
    return false;
  }
  long long now = now_ms();
  long long delta = now - info.timestamp;
  if (delta < 0) delta = -delta;
  if (delta > kMaxClockSkewMs) {
    error = "token timestamp outside allowed window";
    return false;
  }
  if (!replay.accept(info.requestId, now)) {
    error = "replay detected";
    return false;
  }
  return true;
}

struct Route {
  std::string host;
  std::string path;
};

bool static_asset_route(const std::string& source, Route& route) {
  std::string url = source;
  for (size_t pos = 0; (pos = url.find("&amp;", pos)) != std::string::npos;) url.replace(pos, 5, "&");
  if (!starts_with(lower_ascii(url), "https://")) return false;
  size_t hostStart = 8;
  size_t pathStart = url.find_first_of("/?#", hostStart);
  std::string host = lower_ascii(url.substr(hostStart, pathStart == std::string::npos ? std::string::npos : pathStart - hostStart));
  if (host.empty() || host.find_first_of("@: \t\r\n\\") != std::string::npos ||
      (host != "steamstatic.com" && !ends_with(host, ".steamstatic.com"))) return false;
  std::string path = pathStart == std::string::npos ? "/" : url.substr(pathStart);
  size_t fragment = path.find('#');
  if (fragment != std::string::npos) path.resize(fragment);
  if (path.empty() || path[0] != '/') path.insert(path.begin(), '/');
  route.host = host;
  route.path = path;
  return true;
}

bool next_static_asset(const std::string& text, size_t& cursor, size_t& begin, size_t& end, Route& route) {
  for (;;) {
    size_t plain = text.find("https://", cursor);
    size_t escaped = text.find("https:\\/\\/", cursor);
    if (plain == std::string::npos && escaped == std::string::npos) return false;
    begin = escaped != std::string::npos && (plain == std::string::npos || escaped < plain) ? escaped : plain;
    end = begin;
    while (end < text.size() && text[end] != ' ' && text[end] != '\t' && text[end] != '\r' &&
           text[end] != '\n' && text[end] != '"' && text[end] != '\'' && text[end] != '<' &&
           text[end] != '>' && text[end] != ')' && text[end] != '(' &&
           text.compare(end, 6, "&quot;") != 0) ++end;
    std::string source = text.substr(begin, end - begin);
    if (!source.empty() && source.back() == '\\') source.pop_back();
    for (size_t pos = 0; (pos = source.find("\\/", pos)) != std::string::npos;) source.replace(pos, 2, "/");
    cursor = end;
    if (!static_asset_route(source, route)) continue;
    size_t query = route.path.find('?');
    size_t pathEnd = query == std::string::npos ? route.path.size() : query;
    size_t slash = route.path.rfind('/', pathEnd);
    size_t dot = route.path.rfind('.', pathEnd);
    if (dot == std::string::npos || dot < slash || dot + 1 == pathEnd) continue;
    return true;
  }
}

bool resolve_route(const std::string& target, Route& route) {
  if (target.size() < 4 || target.size() > 4096 || target[0] != '/') return false;
  if (target.find('\r') != std::string::npos || target.find('\n') != std::string::npos) return false;
  if (target.find(' ') != std::string::npos || target.find('\t') != std::string::npos) return false;
  if (starts_with(target, "//")) return false;

  size_t query = target.find('?');
  std::string path = target.substr(0, query);
  if (starts_with(path, "/id/") && path.size() > 4) {
    route.host = "steamcommunity.com";
    route.path = target;
    return true;
  }
  if (starts_with(path, "/profiles/") && path.size() > 10) {
    route.host = "steamcommunity.com";
    route.path = target;
    return true;
  }
  if (starts_with(path, "/api/") && path.size() > 5) {
    route.host = "store.steampowered.com";
    route.path = target;
    return true;
  }
  return false;
}

struct Header {
  std::string name;
  std::string value;
};

struct HttpRequest {
  std::string method;
  std::string target;
  std::string version;
  std::vector<Header> headers;
  std::string remoteIp;
};

struct HttpResponse {
  int status = 0;
  std::string reason;
  std::vector<Header> headers;
};

std::string header_value(const std::vector<Header>& headers, const std::string& name) {
  std::string wanted = lower_ascii(name);
  for (const Header& header : headers) {
    if (lower_ascii(header.name) == wanted) return header.value;
  }
  return "";
}

std::string public_origin(const HttpRequest& request, const Config& config) {
  std::string host = config.publicHost;
  if (host.empty() && config.trustProxy) host = header_value(request.headers, "x-forwarded-host");
  if (host.empty()) host = header_value(request.headers, "host");
  if (host.empty() || host.find_first_of(" \t\r\n/\\") != std::string::npos) return "";
  return config.publicScheme + "://" + host;
}

bool parse_request_head(const std::string& head, HttpRequest& request) {
  size_t firstEnd = head.find("\r\n");
  if (firstEnd == std::string::npos) return false;
  std::string requestLine = head.substr(0, firstEnd);
  size_t firstSpace = requestLine.find(' ');
  size_t secondSpace = requestLine.find(' ', firstSpace + 1);
  if (firstSpace == std::string::npos || secondSpace == std::string::npos) return false;

  request.method = requestLine.substr(0, firstSpace);
  request.target = requestLine.substr(firstSpace + 1, secondSpace - firstSpace - 1);
  request.version = requestLine.substr(secondSpace + 1);
  if (request.method.empty() || request.target.empty()) return false;
  if (!starts_with(request.version, "HTTP/1.")) return false;

  size_t position = firstEnd + 2;
  while (position < head.size()) {
    size_t end = head.find("\r\n", position);
    if (end == std::string::npos) return false;
    if (end == position) break;
    if (request.headers.size() >= 200) return false;
    std::string line = head.substr(position, end - position);
    size_t colon = line.find(':');
    if (colon == std::string::npos || colon == 0) return false;
    request.headers.push_back(Header{lower_ascii(trim(line.substr(0, colon))), trim(line.substr(colon + 1))});
    position = end + 2;
  }
  return true;
}

bool parse_response_head(const std::string& head, HttpResponse& response) {
  size_t firstEnd = head.find("\r\n");
  if (firstEnd == std::string::npos) return false;
  std::string statusLine = head.substr(0, firstEnd);
  size_t firstSpace = statusLine.find(' ');
  size_t secondSpace = statusLine.find(' ', firstSpace + 1);
  if (firstSpace == std::string::npos) return false;
  std::string code = statusLine.substr(firstSpace + 1, secondSpace == std::string::npos
                                                           ? std::string::npos
                                                           : secondSpace - firstSpace - 1);
  if (code.size() != 3) return false;
  int status = 0;
  for (char c : code) {
    if (c < '0' || c > '9') return false;
    status = status * 10 + (c - '0');
  }
  if (status < 100 || status > 599) return false;
  response.status = status;
  response.reason = secondSpace == std::string::npos ? "" : statusLine.substr(secondSpace + 1);

  size_t position = firstEnd + 2;
  while (position < head.size()) {
    size_t end = head.find("\r\n", position);
    if (end == std::string::npos) return false;
    if (end == position) break;
    if (response.headers.size() >= 200) return false;
    std::string line = head.substr(position, end - position);
    size_t colon = line.find(':');
    if (colon == std::string::npos || colon == 0) return false;
    response.headers.push_back(Header{lower_ascii(trim(line.substr(0, colon))), trim(line.substr(colon + 1))});
    position = end + 2;
  }
  return true;
}

bool is_stripped_header(const std::string& name) {
  return name == "connection" || name == "keep-alive" || name == "proxy-authenticate" ||
         name == "proxy-authorization" || name == "te" || name == "trailer" ||
         name == "upgrade" || name == "set-cookie" || name == "set-cookie2" ||
         name == "alt-svc" || name == "public-key-pins" || name == "strict-transport-security";
}

std::string rewrite_location(const std::string& location, const HttpRequest& request, const Config& config) {
  static const char* origins[] = {
      "https://steamcommunity.com", "http://steamcommunity.com",
      "https://store.steampowered.com", "http://store.steampowered.com"};
  std::string suffix;
  bool matched = false;
  for (const char* origin : origins) {
    size_t originLength = std::strlen(origin);
    if (location == origin) {
      matched = true;
      suffix.clear();
      break;
    }
    if (starts_with(location, origin) && location.size() > originLength) {
      char next = location[originLength];
      if (next != '/' && next != '?' && next != '#') continue;
      matched = true;
      suffix = location.substr(originLength);
      break;
    }
  }
  if (!matched) return location;

  std::string host = config.publicHost;
  if (host.empty() && config.trustProxy) {
    std::string forwardedHost = header_value(request.headers, "x-forwarded-host");
    if (!forwardedHost.empty()) host = forwardedHost;
  }
  if (host.empty()) host = header_value(request.headers, "host");
  if (host.empty()) return location;
  if (starts_with(host, "127.") || starts_with(host, "localhost") || starts_with(host, "[::1]")) {
    return location;
  }
  return config.publicScheme + "://" + host + suffix;
}

enum class BodyMode { None, Length, Chunked, UntilClose };

bool response_body_mode(const HttpResponse& response, const HttpRequest& request,
                        BodyMode& mode, long long& contentLength) {
  contentLength = 0;
  if (request.method == "HEAD" || response.status == 204 || response.status == 304 ||
      (response.status >= 100 && response.status < 200)) {
    mode = BodyMode::None;
    return true;
  }
  std::string transferEncoding = lower_ascii(header_value(response.headers, "transfer-encoding"));
  if (transferEncoding.find("chunked") != std::string::npos) {
    mode = BodyMode::Chunked;
    return true;
  }
  std::string lengthText = header_value(response.headers, "content-length");
  if (!lengthText.empty()) {
    if (!parse_unsigned(lengthText, contentLength) || contentLength < 0 || contentLength > kMaxBodyLength) {
      return false;
    }
    mode = BodyMode::Length;
    return true;
  }
  mode = BodyMode::UntilClose;
  return true;
}

std::string build_downstream_head(const HttpResponse& response, const HttpRequest& request,
                                  const Config& config) {
  bool chunked = lower_ascii(header_value(response.headers, "transfer-encoding"))
                     .find("chunked") != std::string::npos;
  std::string output = "HTTP/1.1 " + std::to_string(response.status) + " " +
                       (response.reason.empty() ? "OK" : response.reason) + "\r\n";
  for (const Header& header : response.headers) {
    std::string name = lower_ascii(header.name);
    if (is_stripped_header(name)) continue;
    if (chunked && name == "content-length") continue;
    std::string value = header.value;
    if (name == "location") value = rewrite_location(value, request, config);
    output += header.name + ": " + value + "\r\n";
  }
  output += "Connection: close\r\n\r\n";
  return output;
}

#ifdef _WIN32
int last_socket_error() { return WSAGetLastError(); }
bool in_progress() {
  int error = last_socket_error();
  return error == WSAEWOULDBLOCK || error == WSAEINPROGRESS;
}
bool interrupted() { return last_socket_error() == WSAEINTR; }
#else
int last_socket_error() { return errno; }
bool in_progress() { return last_socket_error() == EINPROGRESS || last_socket_error() == EAGAIN; }
bool interrupted() { return last_socket_error() == EINTR; }
#endif

void set_socket_timeout(socket_t fd, int milliseconds) {
#ifdef _WIN32
  DWORD timeout = static_cast<DWORD>(milliseconds);
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
#else
  timeval tv{};
  tv.tv_sec = milliseconds / 1000;
  tv.tv_usec = (milliseconds % 1000) * 1000;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&tv), sizeof(tv));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&tv), sizeof(tv));
#endif
}

void set_nonblocking(socket_t fd, bool enabled) {
#ifdef _WIN32
  u_long mode = enabled ? 1 : 0;
  ioctlsocket(fd, FIONBIO, &mode);
#else
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return;
  fcntl(fd, F_SETFL, enabled ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK));
#endif
}

bool wait_writable(socket_t fd, int timeoutMs) {
#ifdef _WIN32
  fd_set writeSet;
  FD_ZERO(&writeSet);
  FD_SET(fd, &writeSet);
  timeval tv{};
  tv.tv_sec = timeoutMs / 1000;
  tv.tv_usec = (timeoutMs % 1000) * 1000;
  return select(0, nullptr, &writeSet, nullptr, &tv) > 0;
#else
  pollfd descriptor{};
  descriptor.fd = fd;
  descriptor.events = POLLOUT;
  int result = poll(&descriptor, 1, timeoutMs);
  return result > 0 && (descriptor.revents & POLLOUT);
#endif
}

bool connect_with_timeout(socket_t fd, const sockaddr* address, socklen_t length, int timeoutMs) {
  set_nonblocking(fd, true);
  int result = connect(fd, address, length);
  if (result == 0) {
    set_nonblocking(fd, false);
    return true;
  }
  if (!in_progress()) {
    set_nonblocking(fd, false);
    return false;
  }
  if (!wait_writable(fd, timeoutMs)) {
    set_nonblocking(fd, false);
    return false;
  }
  int error = 0;
  socklen_t errorLength = sizeof(error);
  if (getsockopt(fd, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &errorLength) != 0) {
    set_nonblocking(fd, false);
    return false;
  }
  set_nonblocking(fd, false);
  return error == 0;
}

socket_t tcp_connect(const std::string& host, int port, int timeoutMs, std::string& error) {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_ADDRCONFIG;
  addrinfo* result = nullptr;
  std::string service = std::to_string(port);
  int status = getaddrinfo(host.c_str(), service.c_str(), &hints, &result);
  if (status != 0 || !result) {
    error = "DNS lookup failed for " + host;
    return INVALID_SOCK;
  }
  socket_t connected = INVALID_SOCK;
  for (addrinfo* current = result; current; current = current->ai_next) {
    socket_t fd = socket(current->ai_family, current->ai_socktype, current->ai_protocol);
    if (fd == INVALID_SOCK) continue;
    set_socket_timeout(fd, timeoutMs);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof(one));
    if (connect_with_timeout(fd, current->ai_addr, static_cast<socklen_t>(current->ai_addrlen), timeoutMs)) {
      connected = fd;
      break;
    }
    close_socket(fd);
  }
  freeaddrinfo(result);
  if (connected == INVALID_SOCK) error = "TCP connection failed for " + host;
  return connected;
}

socket_t bind_listen(const std::string& host, int port, std::string& error) {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_PASSIVE;
  addrinfo* result = nullptr;
  std::string service = std::to_string(port);
  int status = getaddrinfo(host.empty() ? nullptr : host.c_str(), service.c_str(), &hints, &result);
  if (status != 0 || !result) {
    error = "cannot resolve bind address " + host;
    return INVALID_SOCK;
  }
  socket_t listener = INVALID_SOCK;
  for (addrinfo* current = result; current; current = current->ai_next) {
    socket_t fd = socket(current->ai_family, current->ai_socktype, current->ai_protocol);
    if (fd == INVALID_SOCK) continue;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&one), sizeof(one));
    if (current->ai_family == AF_INET6) {
      int disabled = 0;
      setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, reinterpret_cast<const char*>(&disabled), sizeof(disabled));
    }
    if (bind(fd, current->ai_addr, static_cast<socklen_t>(current->ai_addrlen)) == 0 &&
        listen(fd, 128) == 0) {
      listener = fd;
      break;
    }
    close_socket(fd);
  }
  freeaddrinfo(result);
  if (listener == INVALID_SOCK) error = "cannot bind " + host + ":" + service;
  return listener;
}

std::string sockaddr_ip(const sockaddr_storage& address) {
  char text[INET6_ADDRSTRLEN]{};
  if (address.ss_family == AF_INET) {
    const auto* ipv4 = reinterpret_cast<const sockaddr_in*>(&address);
    if (inet_ntop(AF_INET, &ipv4->sin_addr, text, sizeof(text))) return text;
  } else if (address.ss_family == AF_INET6) {
    const auto* ipv6 = reinterpret_cast<const sockaddr_in6*>(&address);
    if (inet_ntop(AF_INET6, &ipv6->sin6_addr, text, sizeof(text))) {
      std::string ip = text;
      if (starts_with(ip, "::ffff:")) ip = ip.substr(7);
      return ip;
    }
  }
  return "unknown";
}

struct Conn {
  socket_t fd = INVALID_SOCK;
  SSL* ssl = nullptr;
  bool tls = false;
  std::string pending;

  ~Conn() {
    if (ssl) {
      SSL_free(ssl);
      ssl = nullptr;
    }
    if (fd != INVALID_SOCK) {
      close_socket(fd);
      fd = INVALID_SOCK;
    }
  }

  int read_some(char* buffer, size_t capacity) {
    if (!pending.empty()) {
      size_t count = std::min(capacity, pending.size());
      std::memcpy(buffer, pending.data(), count);
      pending.erase(0, count);
      return static_cast<int>(count);
    }
    if (capacity == 0) return 0;
    int request = static_cast<int>(std::min<size_t>(capacity, 1 << 20));
    if (tls) {
      int result = SSL_read(ssl, buffer, request);
      if (result > 0) return result;
      int error = SSL_get_error(ssl, result);
      if (error == SSL_ERROR_ZERO_RETURN) return 0;
      return -1;
    }
    for (;;) {
      int result = recv(fd, buffer, request, 0);
      if (result > 0) return result;
      if (result == 0) return 0;
      if (interrupted()) continue;
      return -1;
    }
  }

  bool write_all(const char* data, size_t length) {
    size_t offset = 0;
    while (offset < length) {
      int chunk = static_cast<int>(std::min<size_t>(length - offset, 1 << 20));
      int result = 0;
      if (tls) {
        result = SSL_write(ssl, data + offset, chunk);
      } else {
        int flags = 0;
#ifdef MSG_NOSIGNAL
        flags = MSG_NOSIGNAL;
#endif
        result = send(fd, data + offset, chunk, flags);
      }
      if (result > 0) {
        offset += static_cast<size_t>(result);
        continue;
      }
      if (!tls && interrupted()) continue;
      return false;
    }
    return true;
  }
};

bool read_head(Conn& connection, std::string& head, size_t maximum, int timeoutMs) {
  char buffer[8192];
  long long deadline = now_ms() + timeoutMs;
  for (;;) {
    size_t end = head.find("\r\n\r\n");
    if (end != std::string::npos) {
      if (end + 4 > maximum) return false;
      connection.pending = head.substr(end + 4);
      head.resize(end + 4);
      return true;
    }
    if (head.size() > maximum || now_ms() > deadline) return false;
    int count = connection.read_some(buffer, sizeof(buffer));
    if (count <= 0) return false;
    head.append(buffer, static_cast<size_t>(count));
  }
}

void send_error(Conn& connection) {
  static const char response[] =
      "HTTP/1.1 500 Internal Server Error\r\n"
      "Content-Length: 0\r\n"
      "Cache-Control: no-store\r\n"
      "Connection: close\r\n\r\n";
  connection.write_all(response, sizeof(response) - 1);
}

bool init_client_tls(std::string& error) {
  g_clientCtx = SSL_CTX_new(TLS_client_method());
  if (!g_clientCtx) {
    error = "cannot create TLS client context";
    return false;
  }
  SSL_CTX_set_min_proto_version(g_clientCtx, TLS1_2_VERSION);
  SSL_CTX_set_mode(g_clientCtx, SSL_MODE_RELEASE_BUFFERS);
  SSL_CTX_set_verify(g_clientCtx, SSL_VERIFY_PEER, nullptr);
  if (SSL_CTX_set_default_verify_paths(g_clientCtx) != 1) {
    log_message("WARN", "cannot load system CA certificates; Steam TLS verification may fail");
  }
  return true;
}

bool upstream_open(const Route& route, Conn& upstream, std::string& error) {
  socket_t fd = tcp_connect(route.host, 443, 10000, error);
  if (fd == INVALID_SOCK) return false;
  upstream.fd = fd;
  set_socket_timeout(fd, g_cfg.upstreamTimeoutMs);

  SSL* ssl = SSL_new(g_clientCtx);
  if (!ssl) {
    error = "cannot create TLS connection";
    return false;
  }
  if (SSL_set_fd(ssl, static_cast<int>(fd)) != 1) {
    error = "SSL_set_fd failed";
    SSL_free(ssl);
    return false;
  }
  if (SSL_set_tlsext_host_name(ssl, route.host.c_str()) != 1 ||
      SSL_set1_host(ssl, route.host.c_str()) != 1) {
    error = "cannot configure upstream TLS hostname";
    SSL_free(ssl);
    return false;
  }
  int handshake = SSL_connect(ssl);
  if (handshake != 1) {
    int sslError = SSL_get_error(ssl, handshake);
    unsigned long code = ERR_get_error();
    char detail[256]{};
    if (code) ERR_error_string_n(code, detail, sizeof(detail));
    error = "TLS handshake failed (ssl_error=" + std::to_string(sslError) +
            ", socket_error=" + std::to_string(last_socket_error()) + ")" +
            (detail[0] ? std::string(": ") + detail : "");
    SSL_free(ssl);
    return false;
  }
  if (SSL_get_verify_result(ssl) != X509_V_OK) {
    error = "upstream certificate verification failed";
    SSL_free(ssl);
    return false;
  }
  upstream.ssl = ssl;
  upstream.tls = true;
  return true;
}

std::string build_upstream_request(const Route& route, const HttpRequest& request) {
  std::string accept = header_value(request.headers, "accept");
  if (accept.empty() || accept.size() > 512 || accept.find('\r') != std::string::npos ||
      accept.find('\n') != std::string::npos) {
    accept = "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7";
  }
  std::string output = request.method + " " + route.path + " HTTP/1.1\r\n";
  output += "Host: " + route.host + "\r\n";
  output += "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36\r\n";
  output += "Accept: " + accept + "\r\n";
  output += "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8\r\n";
  output += "Accept-Encoding: identity\r\n";
  output += "Connection: close\r\n\r\n";
  return output;
}

bool read_crlf_line(Conn& connection, std::string& line, size_t maximum) {
  line.clear();
  char character = 0;
  while (line.size() <= maximum) {
    int count = connection.read_some(&character, 1);
    if (count <= 0) return false;
    if (character == '\n') {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      return true;
    }
    line.push_back(character);
  }
  return false;
}

bool read_exact(Conn& connection, char* buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    int count = connection.read_some(buffer + offset, length - offset);
    if (count <= 0) return false;
    offset += static_cast<size_t>(count);
  }
  return true;
}

bool relay_chunked(Conn& upstream, Conn& downstream) {
  long long deadline = now_ms() + std::max<long long>(60000, g_cfg.upstreamTimeoutMs * 3LL);
  char buffer[65536];
  while (now_ms() <= deadline) {
    std::string line;
    if (!read_crlf_line(upstream, line, 1024)) return false;
    size_t position = 0;
    unsigned long long chunkSize = 0;
    bool hasDigit = false;
    while (position < line.size()) {
      char c = line[position];
      int digit = -1;
      if (c >= '0' && c <= '9') digit = c - '0';
      else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
      else break;
      hasDigit = true;
      chunkSize = chunkSize * 16 + static_cast<unsigned long long>(digit);
      if (chunkSize > static_cast<unsigned long long>(kMaxBodyLength)) return false;
      ++position;
    }
    if (!hasDigit) return false;

    std::string framed = line + "\r\n";
    if (!downstream.write_all(framed.data(), framed.size())) return false;
    if (chunkSize == 0) {
      for (int trailerCount = 0; trailerCount < 100; ++trailerCount) {
        std::string trailer;
        if (!read_crlf_line(upstream, trailer, 8192)) return false;
        if (trailer.empty()) {
          return downstream.write_all("\r\n", 2);
        }
        std::string trailerLine = trailer + "\r\n";
        if (!downstream.write_all(trailerLine.data(), trailerLine.size())) return false;
      }
      return false;
    }

    unsigned long long remaining = chunkSize;
    while (remaining > 0) {
      size_t wanted = static_cast<size_t>(std::min<unsigned long long>(remaining, sizeof(buffer)));
      int count = upstream.read_some(buffer, wanted);
      if (count <= 0) return false;
      if (!downstream.write_all(buffer, static_cast<size_t>(count))) return false;
      remaining -= static_cast<unsigned long long>(count);
      if (now_ms() > deadline) return false;
    }

    char ending[2]{};
    if (!read_exact(upstream, ending, 2) || ending[0] != '\r' || ending[1] != '\n') return false;
    if (!downstream.write_all(ending, 2)) return false;
  }
  return false;
}

bool relay_body(Conn& upstream, Conn& downstream, BodyMode mode, long long contentLength) {
  if (mode == BodyMode::None) return true;
  if (mode == BodyMode::Chunked) return relay_chunked(upstream, downstream);
  char buffer[65536];
  long long deadline = now_ms() + std::max<long long>(60000, g_cfg.upstreamTimeoutMs * 3LL);
  if (mode == BodyMode::Length) {
    long long remaining = contentLength;
    while (remaining > 0) {
      size_t wanted = static_cast<size_t>(std::min<long long>(remaining, sizeof(buffer)));
      int count = upstream.read_some(buffer, wanted);
      if (count <= 0) return false;
      if (!downstream.write_all(buffer, static_cast<size_t>(count))) return false;
      remaining -= count;
      if (now_ms() > deadline) return false;
    }
    return true;
  }
  for (;;) {
    int count = upstream.read_some(buffer, sizeof(buffer));
    if (count == 0) return true;
    if (count < 0) return false;
    if (!downstream.write_all(buffer, static_cast<size_t>(count))) return false;
    if (now_ms() > deadline) return false;
  }
}

bool read_full_body(Conn& upstream, BodyMode mode, long long contentLength,
                    size_t maximum, std::string& body) {
  body.clear();
  char buffer[65536];
  auto append = [&](const char* data, size_t size) {
    if (size > maximum - std::min(maximum, body.size())) return false;
    body.append(data, size);
    return true;
  };
  if (mode == BodyMode::None) return true;
  if (mode == BodyMode::Length) {
    if (contentLength < 0 || static_cast<unsigned long long>(contentLength) > maximum) return false;
    size_t remaining = static_cast<size_t>(contentLength);
    while (remaining) {
      int count = upstream.read_some(buffer, std::min(remaining, sizeof(buffer)));
      if (count <= 0 || !append(buffer, static_cast<size_t>(count))) return false;
      remaining -= static_cast<size_t>(count);
    }
    return true;
  }
  if (mode == BodyMode::Chunked) {
    for (;;) {
      std::string line;
      if (!read_crlf_line(upstream, line, 1024)) return false;
      size_t semicolon = line.find(';');
      std::string sizeText = line.substr(0, semicolon);
      if (sizeText.empty()) return false;
      char* end = nullptr;
      unsigned long long size = std::strtoull(sizeText.c_str(), &end, 16);
      if (!end || *end != '\0' || size > maximum - std::min(maximum, body.size())) return false;
      if (size == 0) {
        for (int i = 0; i < 100; ++i) {
          if (!read_crlf_line(upstream, line, 8192)) return false;
          if (line.empty()) return true;
        }
        return false;
      }
      size_t remaining = static_cast<size_t>(size);
      while (remaining) {
        int count = upstream.read_some(buffer, std::min(remaining, sizeof(buffer)));
        if (count <= 0 || !append(buffer, static_cast<size_t>(count))) return false;
        remaining -= static_cast<size_t>(count);
      }
      char ending[2]{};
      if (!read_exact(upstream, ending, sizeof(ending)) || ending[0] != '\r' || ending[1] != '\n') return false;
    }
  }
  for (;;) {
    int count = upstream.read_some(buffer, sizeof(buffer));
    if (count == 0) return true;
    if (count < 0 || !append(buffer, static_cast<size_t>(count))) return false;
  }
}

std::string rewrite_static_assets(const std::string& html, int depth, const std::string& origin);

bool fetch_static_asset(const Route& route, std::string& body, std::string& contentType,
                        int depth, const std::string& origin) {
  Conn upstream;
  std::string error;
  if (!upstream_open(route, upstream, error)) return false;
  HttpRequest request;
  request.method = "GET";
  request.target = route.path;
  request.headers.push_back(Header{"accept", "*/*"});
  std::string rawRequest = build_upstream_request(route, request);
  if (!upstream.write_all(rawRequest.data(), rawRequest.size())) return false;
  std::string rawHead;
  if (!read_head(upstream, rawHead, kMaxResponseHead, g_cfg.upstreamTimeoutMs)) return false;
  HttpResponse response;
  if (!parse_response_head(rawHead, response) || response.status < 200 || response.status >= 300) return false;
  BodyMode mode = BodyMode::None;
  long long length = 0;
  if (!response_body_mode(response, request, mode, length) ||
      !read_full_body(upstream, mode, length, kMaxCachedResource, body)) return false;
  contentType = header_value(response.headers, "content-type");
  if (contentType.empty()) contentType = "application/octet-stream";
  if (depth < 1 && starts_with(lower_ascii(contentType), "text/css")) {
    body = rewrite_static_assets(body, depth + 1, origin);
  }
  return !body.empty();
}

std::string asset_key(const Route& route) { return route.host + route.path; }

std::string rewrite_static_assets(const std::string& html, int depth, const std::string& origin) {
  std::unordered_map<std::string, Route> assets;
  size_t cursor = 0, begin = 0, end = 0;
  Route route;
  while (next_static_asset(html, cursor, begin, end, route)) {
    std::string key = asset_key(route);
    assets.emplace(key, route);
    if (assets.size() >= kMaxAssetsPerPage) break;
  }

  std::unordered_map<std::string, std::string> hashes;
  std::vector<Route> missing;
  for (const auto& asset : assets) {
    std::string hash;
    if (g_resourceCache.lookup_url(asset.first, hash)) {
      std::shared_ptr<const CachedResource> cached;
      if (g_resourceCache.get(hash, cached)) {
        hashes[asset.first] = hash;
        continue;
      }
    }
    missing.push_back(asset.second);
  }

  std::atomic<size_t> next{0};
  std::mutex resultMutex;
  size_t workerCount = depth == 0 ? std::min<size_t>(8, missing.size()) : std::min<size_t>(4, missing.size());
  std::vector<std::thread> workers;
  workers.reserve(workerCount);
  for (size_t i = 0; i < workerCount; ++i) {
    workers.emplace_back([&]() {
      for (;;) {
        size_t index = next.fetch_add(1);
        if (index >= missing.size()) break;
        const Route& route = missing[index];
        std::string body, contentType;
        if (!fetch_static_asset(route, body, contentType, depth, origin)) continue;
        std::string hash = sha256_hex(body);
        if (hash.empty()) continue;
        g_resourceCache.put(hash, std::move(body), std::move(contentType));
        std::string key = asset_key(route);
        g_resourceCache.remember_url(key, hash);
        std::lock_guard<std::mutex> lock(resultMutex);
        hashes[key] = hash;
      }
    });
  }
  for (std::thread& worker : workers) worker.join();

  std::string rewritten;
  rewritten.reserve(html.size());
  size_t copied = 0;
  cursor = 0;
  while (next_static_asset(html, cursor, begin, end, route)) {
    auto hash = hashes.find(asset_key(route));
    if (hash != hashes.end()) {
      rewritten.append(html, copied, begin - copied);
      rewritten += (origin.empty() ? "" : origin) + "/res/" + hash->second;
      copied = end;
    }
  }
  rewritten.append(html, copied, std::string::npos);
  return rewritten;
}

void log_request(const std::string& ip, const HttpRequest& request, int status, long long elapsed) {
  if (!g_cfg.logRequests) return;
  std::string path = request.target;
  if (path.size() > 180) path = path.substr(0, 180) + "...";
  log_message("INFO", "%s %s %s -> %d (%lldms)", ip.c_str(), request.method.c_str(),
              path.c_str(), status, elapsed);
}

void serve_cached_resource(Conn& client, const HttpRequest& request) {
  size_t query = request.target.find('?');
  std::string path = request.target.substr(0, query);
  std::string hash = path.substr(5);
  bool valid = hash.size() == 64;
  for (char c : hash) valid = valid && ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
  std::shared_ptr<const CachedResource> resource;
  if (!valid || !g_resourceCache.get(hash, resource)) {
    send_error(client);
    return;
  }
  std::string head = "HTTP/1.1 200 OK\r\nContent-Type: " + resource->contentType +
      "\r\nContent-Length: " + std::to_string(resource->body.size()) +
      "\r\nCache-Control: public, max-age=31536000, immutable\r\n"
      "X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
  if (!client.write_all(head.data(), head.size())) return;
  if (request.method == "GET") client.write_all(resource->body.data(), resource->body.size());
}

void handle_client(socket_t fd, const std::string& peerIp) {
  struct ActiveGuard {
    ActiveGuard() { ++g_active; }
    ~ActiveGuard() { --g_active; }
  } active;

  long long started = now_ms();
  Conn client;
  client.fd = fd;
  set_socket_timeout(fd, 15000);

  std::string head;
  if (!read_head(client, head, kMaxRequestHead, 10000)) {
    if (!head.empty()) send_error(client);
    return;
  }

  HttpRequest request;
  request.remoteIp = peerIp;
  if (!parse_request_head(head, request)) {
    send_error(client);
    return;
  }
  if (request.method != "GET" && request.method != "HEAD") {
    send_error(client);
    return;
  }
  if (!header_value(request.headers, "transfer-encoding").empty()) {
    send_error(client);
    return;
  }
  std::string requestLength = header_value(request.headers, "content-length");
  if (!requestLength.empty()) {
    long long parsed = 0;
    if (!parse_unsigned(requestLength, parsed) || parsed != 0) {
      send_error(client);
      return;
    }
  }

  if (starts_with(request.target, "/res/")) {
    serve_cached_resource(client, request);
    return;
  }

  static ReplayGuard replay;
  static RateLimiter limiter;
  TokenInfo token;
  std::string authError;
  if (!authenticate(g_cfg, replay, header_value(request.headers, "user-agent"), token, authError)) {
    log_message("WARN", "auth rejected from %s: %s", peerIp.c_str(), authError.c_str());
    send_error(client);
    return;
  }

  std::string clientIp = peerIp;
  if (g_cfg.trustProxy) {
    std::string forwarded = header_value(request.headers, "x-forwarded-for");
    if (!forwarded.empty()) {
      size_t comma = forwarded.find(',');
      std::string candidate = trim(forwarded.substr(0, comma));
      if (!candidate.empty() && candidate.size() <= 64 &&
          candidate.find_first_of(" \t\r\n") == std::string::npos) {
        clientIp = candidate;
      }
    }
  }
  if (!limiter.allow(clientIp, now_ms(), g_cfg.ratePerMinute, g_cfg.rateGlobalPerMinute)) {
    log_message("WARN", "rate limit exceeded for %s", clientIp.c_str());
    send_error(client);
    return;
  }

  Route route;
  if (!resolve_route(request.target, route)) {
    log_message("WARN", "rejected path from %s: %s", clientIp.c_str(), request.target.c_str());
    send_error(client);
    return;
  }

  Conn upstream;
  std::string upstreamError;
  if (!upstream_open(route, upstream, upstreamError)) {
    log_message("ERROR", "upstream open failed: %s", upstreamError.c_str());
    send_error(client);
    return;
  }
  std::string upstreamRequest = build_upstream_request(route, request);
  if (!upstream.write_all(upstreamRequest.data(), upstreamRequest.size())) {
    send_error(client);
    return;
  }

  std::string responseHead;
  if (!read_head(upstream, responseHead, kMaxResponseHead, g_cfg.upstreamTimeoutMs)) {
    log_message("ERROR", "invalid or incomplete upstream response for %s", request.target.c_str());
    send_error(client);
    return;
  }
  HttpResponse response;
  if (!parse_response_head(responseHead, response)) {
    send_error(client);
    return;
  }

  BodyMode mode = BodyMode::None;
  long long contentLength = 0;
  if (!response_body_mode(response, request, mode, contentLength)) {
    send_error(client);
    return;
  }

  std::string contentType = lower_ascii(header_value(response.headers, "content-type"));
  if (request.method == "GET" && response.status >= 200 && response.status < 300 &&
      starts_with(contentType, "text/html")) {
    std::string html;
    if (!read_full_body(upstream, mode, contentLength, static_cast<size_t>(kMaxBodyLength), html)) {
      log_message("ERROR", "failed to buffer HTML response for %s", request.target.c_str());
      send_error(client);
      return;
    }
    html = rewrite_static_assets(html, 0, public_origin(request, g_cfg));
    response.headers.erase(std::remove_if(response.headers.begin(), response.headers.end(), [](const Header& h) {
      std::string name = lower_ascii(h.name);
      return name == "content-length" || name == "transfer-encoding" || name == "content-encoding" ||
             name == "etag" || name == "content-md5" || name == "content-range";
    }), response.headers.end());
    response.headers.push_back(Header{"Content-Length", std::to_string(html.size())});
    std::string downstreamHead = build_downstream_head(response, request, g_cfg);
    if (!client.write_all(downstreamHead.data(), downstreamHead.size())) return;
    client.write_all(html.data(), html.size());
    log_request(clientIp, request, response.status, now_ms() - started);
    return;
  }
  std::string downstreamHead = build_downstream_head(response, request, g_cfg);
  if (!client.write_all(downstreamHead.data(), downstreamHead.size())) return;
  relay_body(upstream, client, mode, contentLength);
  log_request(clientIp, request, response.status, now_ms() - started);
}

#ifndef _WIN32
struct ClientThreadArgs {
  socket_t fd;
  std::string ip;
};

void* client_thread_main(void* data) {
  auto* args = static_cast<ClientThreadArgs*>(data);
  handle_client(args->fd, args->ip);
  delete args;
  return nullptr;
}
#endif

void spawn_client(socket_t client, const std::string& ip) {
#ifndef _WIN32
  pthread_attr_t attributes;
  if (pthread_attr_init(&attributes) == 0) {
    pthread_attr_setstacksize(&attributes, 1024 * 1024);
    auto* args = new ClientThreadArgs{client, ip};
    pthread_t thread;
    int result = pthread_create(&thread, &attributes, client_thread_main, args);
    pthread_attr_destroy(&attributes);
    if (result == 0) {
      pthread_detach(thread);
      return;
    }
    delete args;
    close_socket(client);
    return;
  }
#endif
  try {
    std::thread([client, ip]() { handle_client(client, ip); }).detach();
  } catch (...) {
    close_socket(client);
  }
}

void signal_handler(int) {
  g_stop.store(true);
  if (g_listenFd != INVALID_SOCK) {
    close_socket(g_listenFd);
    g_listenFd = INVALID_SOCK;
  }
}

int run_self_tests() {
  int checks = 0;
  int failures = 0;
  auto check = [&](bool condition, const char* name) {
    ++checks;
    if (!condition) {
      ++failures;
      std::fprintf(stderr, "self-test FAILED: %s\n", name);
    }
  };

  Route staticRoute;
  check(static_asset_route("https://shared.fastly.steamstatic.com/a.png", staticRoute) &&
            staticRoute.host == "shared.fastly.steamstatic.com" && staticRoute.path == "/a.png",
        "Steam static asset URL accepted");
  check(!static_asset_route("https://steamstatic.com.evil.example/a.png", staticRoute),
        "lookalike static host rejected");
  std::string escapedAsset = R"URL(src=\"https:\/\/community.fastly.steamstatic.com\/public\/javascript\/economy.js?v=1&amp;l=schinese&quot;)URL";
  size_t scan = 0, assetBegin = 0, assetEnd = 0;
  check(next_static_asset(escapedAsset, scan, assetBegin, assetEnd, staticRoute) &&
            staticRoute.path == "/public/javascript/economy.js?v=1&l=schinese",
        "escaped JavaScript static URL detected");
  std::string escapedBase = R"URL(\"https:\/\/community.fastly.steamstatic.com\/public\/&quot;)URL";
  scan = 0;
  check(!next_static_asset(escapedBase, scan, assetBegin, assetEnd, staticRoute),
        "escaped CDN base URL is not fetched as a file");
  check(sha256_hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "SHA-256 content key");
  ResourceCache cache;
  std::string sampleHash = sha256_hex("image");
  cache.put(sampleHash, "image", "image/png");
  std::shared_ptr<const CachedResource> cached;
  check(cache.get(sampleHash, cached) && cached->body == "image" && cached->contentType == "image/png",
        "resource cache stores and retrieves content");

  Config config;
  config.key.resize(32);
  for (size_t i = 0; i < config.key.size(); ++i) config.key[i] = static_cast<unsigned char>(i);
  config.publicScheme = "https";
  config.trustProxy = true;
  Config originConfig = config;
  originConfig.publicHost = "steam.example.com";
  HttpRequest publicRequest;
  check(public_origin(publicRequest, originConfig) == "https://steam.example.com",
        "absolute asset origin uses configured public domain");

  auto make_token = [&](long long timestamp, const std::string& requestId) {
    std::string plaintext = "0.0.0.0:" + std::to_string(timestamp) + ":" + requestId;
    std::vector<unsigned char> encrypted;
    if (!aes_gcm_encrypt_for_test(plaintext, config.key, encrypted)) return std::string();
    return std::string("SteamSpeedService/") + base64url_encode(encrypted.data(), encrypted.size());
  };

  long long current = now_ms();
  std::string valid = make_token(current, "abc12345-deadbeef");
  ReplayGuard replay;
  TokenInfo token;
  std::string error;
  check(!valid.empty(), "token generation");
  check(authenticate(config, replay, valid, token, error), "valid token accepted");
  check(token.requestId == "abc12345-deadbeef", "request id parsed");
  check(!authenticate(config, replay, valid, token, error), "replay rejected");

  ReplayGuard replay2;
  std::vector<unsigned char> tamperedRaw;
  base64url_decode(valid.substr(std::string("SteamSpeedService/").size()), tamperedRaw);
  if (tamperedRaw.size() > kIvLength) tamperedRaw[kIvLength] ^= 1;
  std::string tampered = std::string("SteamSpeedService/") +
                         base64url_encode(tamperedRaw.data(), tamperedRaw.size());
  check(!authenticate(config, replay2, tampered, token, error), "tampered token rejected");

  ReplayGuard replay3;
  check(!authenticate(config, replay3, make_token(current - 11000, "old12345-deadbeef"), token, error),
        "expired timestamp rejected");
  ReplayGuard replay4;
  check(!authenticate(config, replay4, make_token(current + 11000, "new12345-deadbeef"), token, error),
        "future timestamp rejected");
  ReplayGuard replay5;
  check(authenticate(config, replay5, "prefix " + valid + " suffix", token, error),
        "token found inside user agent");

  Route route;
  check(resolve_route("/profiles/76561198000000000", route) &&
            route.host == "steamcommunity.com" && route.path == "/profiles/76561198000000000",
        "profile route");
  check(resolve_route("/id/gabe", route) && route.host == "steamcommunity.com", "vanity route");
  check(resolve_route("/api/appdetails?appids=10&l=schinese", route) &&
            route.host == "store.steampowered.com", "store api route");
  check(!resolve_route("/", route), "root rejected");
  check(!resolve_route("/api/", route), "empty api rejected");
  check(!resolve_route("//evil.example/profiles/1", route), "scheme relative path rejected");
  check(!resolve_route("/appdetails", route), "unlisted path rejected");

  HttpResponse response;
  response.status = 302;
  response.reason = "Found";
  response.headers.push_back(Header{"Location", "https://steamcommunity.com/profiles/123"});
  response.headers.push_back(Header{"Set-Cookie", "secret=1"});
  response.headers.push_back(Header{"Connection", "keep-alive"});
  response.headers.push_back(Header{"Content-Type", "text/html"});
  HttpRequest request;
  request.method = "GET";
  request.target = "/profiles/123";
  request.headers.push_back(Header{"host", "speed.example.com"});
  std::string downstream = build_downstream_head(response, request, config);
  check(downstream.find("Location: https://speed.example.com/profiles/123") != std::string::npos,
        "redirect rewritten to public host");
  check(downstream.find("Set-Cookie") == std::string::npos, "cookies stripped");
  check(downstream.find("Connection: close") != std::string::npos, "connection close added");

  BodyMode mode = BodyMode::None;
  long long length = -1;
  response.headers.push_back(Header{"Content-Length", "42"});
  check(response_body_mode(response, request, mode, length) && mode == BodyMode::Length && length == 42,
        "content length body mode");

  std::string rawRequest = "GET /profiles/123 HTTP/1.1\r\nHost: speed.example.com\r\nUser-Agent: " +
                           valid + "\r\n\r\n";
  HttpRequest parsedRequest;
  check(parse_request_head(rawRequest, parsedRequest) && parsedRequest.method == "GET" &&
            parsedRequest.target == "/profiles/123",
        "request head parsed");
  Route parsedRoute;
  resolve_route(parsedRequest.target, parsedRoute);
  std::string upstreamRequest = build_upstream_request(parsedRoute, parsedRequest);
  check(upstreamRequest.find("SteamSpeedService") == std::string::npos, "token not forwarded upstream");
  check(upstreamRequest.find("Host: steamcommunity.com") != std::string::npos, "upstream host fixed");
  check(upstreamRequest.find("Cookie:") == std::string::npos, "cookies not forwarded upstream");

  HttpResponse chunked;
  chunked.status = 200;
  chunked.headers.push_back(Header{"Transfer-Encoding", "chunked"});
  chunked.headers.push_back(Header{"Content-Length", "999"});
  check(response_body_mode(chunked, parsedRequest, mode, length) && mode == BodyMode::Chunked,
        "chunked response mode");
  std::string chunkedHead = build_downstream_head(chunked, parsedRequest, config);
  check(chunkedHead.find("Content-Length") == std::string::npos,
        "content length removed for chunked response");

  std::string lookalike = rewrite_location("https://steamcommunity.com.evil.example/profiles/1",
                                            parsedRequest, config);
  check(lookalike == "https://steamcommunity.com.evil.example/profiles/1",
        "lookalike redirect host not rewritten");

  std::printf("self-test: %s (%d checks)\n", failures == 0 ? "OK" : "FAILED", checks);
  return failures == 0 ? 0 : 1;
}

void print_usage() {
  std::printf(
      "steam-speed - authenticated Steam reverse proxy (plain HTTP origin)\n\n"
      "Usage:\n"
      "  steam-speed                 run the proxy\n"
      "  steam-speed --self-test     verify token, routing, and header logic\n"
      "  steam-speed --version       print version\n\n"
      "Environment:\n"
      "  SECRET_KEY                   64 hexadecimal characters (required)\n"
      "  BIND_HOST                    default 0.0.0.0\n"
      "  PORT                         default 8467\n"
      "  PUBLIC_SCHEME                default https\n"
      "  PUBLIC_HOST                  optional public host for redirects\n"
      "  TRUST_PROXY                  default 1 (uses X-Forwarded-*)\n"
      "  UPSTREAM_TIMEOUT_MS          default 20000\n"
      "  LOG_REQUESTS                 default 1\n");
}

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
  WSADATA winsock{};
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) {
    std::fprintf(stderr, "WSAStartup failed\n");
    return 1;
  }
#else
  signal(SIGPIPE, SIG_IGN);
#endif
  OPENSSL_init_ssl(OPENSSL_INIT_LOAD_SSL_STRINGS | OPENSSL_INIT_LOAD_CRYPTO_STRINGS, nullptr);

  if (argc > 1) {
    std::string argument = argv[1];
    if (argument == "--self-test") return run_self_tests();
    if (argument == "--version") {
      std::printf("steam-speed 1.0.0\n");
      return 0;
    }
    if (argument == "--help" || argument == "-h") {
      print_usage();
      return 0;
    }
    std::fprintf(stderr, "unknown argument: %s\n", argument.c_str());
    print_usage();
    return 2;
  }

  std::string error;
  if (!load_config(g_cfg, error)) {
    log_message("ERROR", "%s", error.c_str());
    return 2;
  }
  if (!init_client_tls(error)) {
    log_message("ERROR", "%s", error.c_str());
    return 3;
  }

  g_listenFd = bind_listen(g_cfg.bindHost, g_cfg.port, error);
  if (g_listenFd == INVALID_SOCK) {
    log_message("ERROR", "%s", error.c_str());
    return 4;
  }
  signal(SIGINT, signal_handler);
  signal(SIGTERM, signal_handler);

  log_message("INFO", "steam-speed 1.0.0 listening on %s:%d (plain HTTP origin)",
              g_cfg.bindHost.c_str(), g_cfg.port);
  log_message("INFO", "public scheme=%s host=%s trust_proxy=%d",
              g_cfg.publicScheme.c_str(),
              g_cfg.publicHost.empty() ? "(from Host header)" : g_cfg.publicHost.c_str(),
              g_cfg.trustProxy ? 1 : 0);

  while (!g_stop.load()) {
    sockaddr_storage address{};
    socklen_t length = sizeof(address);
    socket_t client = accept(g_listenFd, reinterpret_cast<sockaddr*>(&address), &length);
    if (client == INVALID_SOCK) {
      if (g_stop.load()) break;
      if (interrupted()) continue;
      log_message("WARN", "accept failed: %d", last_socket_error());
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      continue;
    }
    if (g_active.load() >= g_cfg.maxConnections) {
      close_socket(client);
      continue;
    }
    std::string ip = sockaddr_ip(address);
    spawn_client(client, ip);
  }

  if (g_listenFd != INVALID_SOCK) {
    close_socket(g_listenFd);
    g_listenFd = INVALID_SOCK;
  }
  return 0;
}
