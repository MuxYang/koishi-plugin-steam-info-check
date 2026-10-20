#!/usr/bin/env node
'use strict'

const https = require('node:https')
const http = require('node:http')
const dns = require('node:dns')
const crypto = require('node:crypto')
const readline = require('node:readline')
const zlib = require('node:zlib')
const { performance } = require('node:perf_hooks')

function question(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function questionSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new Error('密钥输入需要在本地终端运行，不能通过管道传入。'))
      return
    }

    const stdin = process.stdin
    const stdout = process.stdout
    stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''

    const finish = (error) => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      error ? reject(error) : resolve(value)
    }

    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') return finish(new Error('已取消。'))
        if (char === '\r' || char === '\n') return finish()
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else if (/[0-9a-fA-F]/.test(char) && value.length < 64) value += char
      }
    }

    stdin.on('data', onData)
  })
}

function makeUserAgent(key) {
  const timestamp = Date.now()
  const requestId = `${timestamp.toString(36)}-${crypto.randomBytes(8).toString('hex')}`
  const plaintext = `0.0.0.0:${timestamp}:${requestId}`
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `SteamSpeedService/${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')}`
}

function selfTest() {
  const key = crypto.randomBytes(32)
  const userAgent = makeUserAgent(key)
  const token = userAgent.slice('SteamSpeedService/'.length)
  const raw = Buffer.from(token, 'base64url')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(-16))
  const plaintext = Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString()
  const [ip, timestamp, requestId] = plaintext.split(':')
  if (ip !== '0.0.0.0' || Math.abs(Date.now() - Number(timestamp)) > 1000 || !/^[a-z0-9]+-[0-9a-f]{16}$/.test(requestId)) {
    throw new Error('generated token does not match the plugin protocol')
  }
  key.fill(0)
  console.log('diagnose self-test: OK (AES-256-GCM token matches plugin protocol)')
}

function allowedPath(path) {
  return path.startsWith('/profiles/') || path.startsWith('/id/') || path.startsWith('/api/')
}

function probe(url, key, hop = 0, originalHost = url.host) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const marks = {}
    const client = url.protocol === 'https:' ? https : http
    const request = client.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': makeUserAgent(key),
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection': 'close',
      },
    }, response => {
      marks.ttfb = performance.now() - started
      let bytes = 0
      const chunks = []
      response.on('data', chunk => { bytes += chunk.length; chunks.push(chunk) })
      response.on('end', async () => {
        const elapsed = performance.now() - started
        const status = response.statusCode || 0
        const location = response.headers.location
        const body = Buffer.concat(chunks)
        const encoding = response.headers['content-encoding'] || 'identity'
        let decoded = body
        try {
          if (encoding === 'gzip') decoded = zlib.gunzipSync(body)
          else if (encoding === 'deflate') decoded = zlib.inflateSync(body)
          else if (encoding === 'br') decoded = zlib.brotliDecompressSync(body)
          else if (encoding !== 'identity') decoded = null
        } catch { decoded = null }
        console.log(`\n第 ${hop + 1} 跳: ${url.origin}${url.pathname}${url.search}`)
        if (marks.dns !== undefined) console.log(`  DNS:       ${marks.dns.toFixed(0)} ms`)
        if (marks.tcp !== undefined) console.log(`  TCP:       ${marks.tcp.toFixed(0)} ms`)
        if (marks.tls !== undefined) console.log(`  TLS:       ${marks.tls.toFixed(0)} ms`)
        console.log(`  首字节:    ${marks.ttfb.toFixed(0)} ms`)
        console.log(`  总耗时:    ${elapsed.toFixed(0)} ms`)
        console.log(`  HTTP:      ${status} ${response.statusMessage || ''}`.trimEnd())
        console.log(`  内容类型:  ${response.headers['content-type'] || '(无)'}`)
        console.log(`  响应大小:  ${bytes} bytes${decoded && decoded.length !== bytes ? `（解压后 ${decoded.length} bytes）` : ''}`)
        console.log(`  Content-Length: ${response.headers['content-length'] || '(未提供)'}`)
        console.log(`  Content-Encoding: ${encoding}`)
        if (decoded && /text\/html/i.test(response.headers['content-type'] || '')) {
          const title = decoded.toString('utf8').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim()
          if (title) console.log(`  HTML 标题: ${title}`)
          console.log('\n--- 完整 HTML 正文 ---\n')
          process.stdout.write(decoded.toString('utf8'))
          if (decoded.length && decoded[decoded.length - 1] !== 0x0a) process.stdout.write('\n')
          console.log('\n--- HTML 正文结束 ---')
        }
        if (location) console.log(`  Location:  ${location}`)
        if (response.headers['server']) console.log(`  Server:    ${response.headers['server']}`)

        if (status >= 300 && status < 400 && location && hop < 5) {
          let next
          try { next = new URL(location, url) } catch { return reject(new Error('服务返回了无法解析的跳转地址。')) }
          if (next.host !== originalHost || !allowedPath(next.pathname)) {
            console.log('  跳转未跟随：目标不在同一加速域名的允许路径内。')
            return resolve({ status, bytes, redirected: false })
          }
          return resolve(probe(next, key, hop + 1, originalHost))
        }
        resolve({ status, bytes, redirected: hop > 0 })
      })
    })

    request.on('socket', socket => {
      const socketStarted = performance.now()
      let lookupEnded = socketStarted
      let tcpEnded = socketStarted
      if (socket.connecting) {
        socket.once('lookup', (error, address, family) => {
          marks.dns = performance.now() - socketStarted
          lookupEnded = performance.now()
          if (!error) console.log(`DNS 解析到 ${address} (IPv${family})`)
          else console.log(`DNS 解析失败: ${error.message}`)
        })
        socket.once('connect', () => {
          tcpEnded = performance.now()
          marks.tcp = tcpEnded - lookupEnded
        })
        socket.once('secureConnect', () => { marks.tls = performance.now() - tcpEnded })
      } else {
        marks.tcp = 0
        if (url.protocol === 'https:') marks.tls = 0
      }
    })
    request.setTimeout(45000, () => request.destroy(new Error('等待响应超过 45 秒。')))
    request.on('error', error => {
      const elapsed = performance.now() - started
      console.error(`\n连接失败，${elapsed.toFixed(0)} ms 后报错: ${error.code || error.name}: ${error.message}`)
      reject(error)
    })
    request.end()
  })
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  console.log('Steam 加速服务本地诊断（密钥不回显、不写入文件）\n')
  const domain = await question('加速服务域名，例如 https://steam.example.com: ')
  let base
  try { base = new URL(domain) } catch { throw new Error('域名格式不正确。') }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('请输入完整的 http:// 或 https:// 服务域名，不能含账号、查询参数或片段。')
  }
  if (base.pathname !== '/') throw new Error('服务域名不要带路径前缀；插件直接请求 /profiles、/id 和 /api。')
  base.pathname = ''

  let target = await question('测试路径（回车默认 /api/appdetails?appids=10&l=schinese）: ')
  if (!target) target = '/api/appdetails?appids=10&l=schinese'
  if (!target.startsWith('/') || target.startsWith('//') || !allowedPath(target.split('?')[0])) {
    throw new Error('路径必须以 /profiles/、/id/ 或 /api/ 开头。')
  }
  const url = new URL(target, base)

  const keyHex = await questionSecret('输入插件中的 64 位加速密钥（输入不显示）: ')
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('密钥必须是 64 位十六进制字符串。')
  const key = Buffer.from(keyHex, 'hex')

  console.log(`\n开始诊断 ${url.origin}${url.pathname}${url.search}`)
  console.log('每次请求会生成新的时间戳、request_id 和 AES-GCM User-Agent。')
  try {
    const result = await probe(url, key)
    if (result.status === 500) {
      console.log('\n结果：服务返回 500 空响应符合协议的统一错误格式，单凭客户端无法区分鉴权、重放、路径或上游故障。')
      console.log('请在服务器同时运行：journalctl -u steam-speed -f')
      console.log('再按日志里的 auth rejected / rejected path / upstream open failed 定位具体阶段。')
    } else if (result.status >= 200 && result.status < 300) {
      console.log('\n结果：加速服务已接受请求并拿到 Steam 响应。')
    } else if (result.status >= 300 && result.status < 400) {
      console.log('\n结果：服务已响应跳转；检查 ESA 是否保留 Host 或 X-Forwarded-Host。')
    } else {
      console.log('\n结果：请求已到达 HTTP 服务，检查上方状态码、响应头和服务器日志。')
    }
  } finally {
    key.fill(0)
  }
}

main().catch(error => {
  console.error(`\n诊断未完成: ${error.message}`)
  process.exitCode = 1
})
