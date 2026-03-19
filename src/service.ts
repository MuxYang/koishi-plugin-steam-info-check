import { Context, Service, Logger } from 'koishi'
import { Config } from './index'
import * as cheerio from 'cheerio'
import * as crypto from 'crypto'

const logger = new Logger('steam-info')
const STEAM_ID_OFFSET = BigInt('76561197960265728')

export interface PlayerSummary {
  steamid: string
  personaname: string
  profileurl: string
  avatar: string
  avatarmedium: string
  avatarfull: string
  personastate: number
  gameextrainfo?: string
  gameid?: string
  lastlogoff?: number
}

export interface SteamProfile {
  steamid: string
  player_name: string
  avatar: string | Buffer
  background: string | Buffer
  description: string
  recent_2_week_play_time: string
  game_data: GameData[]
}

export interface GameData {
  game_name: string
  game_image: string | Buffer
  play_time: string
  last_played: string
  achievements: Achievement[]
  completed_achievement_number?: number
  total_achievement_number?: number
}

export interface Achievement {
  name: string
  image: string | Buffer
}

export class SteamService extends Service {
  private http: any
  private dispatcher: any
  private proxyFetch: any
  private gameNameCache = new Map<string, string>()
  private readonly useSpeed: boolean

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'steam', true)
    this.useSpeed = !!(config.enableSteamSpeed && config.steamSpeedDomain && config.steamSpeedKey)

    this.http = ctx.http.extend({
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    })

    if (config.enableProxy && config.proxy) {
      try {
        const undici = require('undici')
        this.dispatcher = new undici.ProxyAgent(config.proxy)
        this.proxyFetch = undici.fetch
        logger.info(`Proxy enabled: ${config.proxy}`)
      } catch (e) {
        logger.warn(`Failed to init proxy: ${e}`)
      }
    }

    if (this.useSpeed) {
      logger.info(`Speed service enabled: ${config.steamSpeedDomain}`)
    }
  }

  private generateSpeedUserAgent(): string {
    const timestamp = Date.now()
    const requestId = `${timestamp.toString(36)}-${crypto.randomBytes(8).toString('hex')}`
    const token = `0.0.0.0:${timestamp}:${requestId}`
    const encrypted = this.encryptToken(token)
    return `SteamSpeedService/${encrypted}`
  }

  private encryptToken(plaintext: string): string {
    const key = Buffer.from(this.config.steamSpeedKey!, 'hex')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, encrypted, cipher.getAuthTag()])
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
  }

  private async speedGet<T = any>(path: string, timeout?: number): Promise<T> {
    const url = `${this.config.steamSpeedDomain}${path}`
    const startTime = Date.now()
    try {
      const response = await this.http.get(url, {
        headers: { 'User-Agent': this.generateSpeedUserAgent() },
        timeout: timeout || this.config.requestTimeout,
      })
      logger.debug(`speedGet: ${path} completed in ${Date.now() - startTime}ms`)
      return response
    } catch (e: any) {
      logger.error(`speedGet: ${path} failed after ${Date.now() - startTime}ms: ${e.message}`)
      throw e
    }
  }

  private async proxyGet<T = any>(url: string, options?: { headers?: Record<string, string>, timeout?: number, responseType?: string }): Promise<T> {
    if (!this.dispatcher || !this.proxyFetch) return this.http.get(url, options)

    const fetchOptions: any = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...options?.headers },
      dispatcher: this.dispatcher,
      redirect: 'follow',
      signal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined
    }

    const response = await this.proxyFetch(url, fetchOptions)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)

    if (options?.responseType === 'text') return await response.text() as T
    if (options?.responseType === 'arraybuffer') return await response.arrayBuffer() as unknown as T

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('text/')) return await response.text() as T
    return await response.json() as T
  }

  async getLocalizedGameName(inputAppid: string | number): Promise<string> {
    const appid = String(inputAppid)
    if (this.gameNameCache.has(appid)) return this.gameNameCache.get(appid)!

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const data = this.useSpeed
          ? await this.speedGet(`/api/appdetails?appids=${appid}&l=schinese`)
          : await this.proxyGet(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese`, { timeout: this.config.requestTimeout })

        if (data?.[appid]?.success) {
          const name = data[appid].data.name
          this.gameNameCache.set(appid, name)
          logger.info(`getLocalizedGameName: ${appid} = ${name}`)
          return name
        }
        break
      } catch {
        if (attempt < 3) await new Promise(res => setTimeout(res, attempt * 1000))
      }
    }
    return ''
  }

  async getSteamId(input: string): Promise<string | null> {
    if (!/^\d+$/.test(input)) return null
    const id = BigInt(input)
    return id < STEAM_ID_OFFSET ? (id + STEAM_ID_OFFSET).toString() : input
  }

  async getPlayerSummaries(steamIds: string[]): Promise<PlayerSummary[]> {
    if (!steamIds.length) return []

    const players: PlayerSummary[] = []
    const chunks = Math.ceil(steamIds.length / 100)
    logger.info(`getPlayerSummaries: ${steamIds.length} players in ${chunks} chunk(s)`)

    for (let i = 0; i < steamIds.length; i += 100) {
      const chunk = steamIds.slice(i, i + 100)
      let success = false

      for (let keyIdx = 0; keyIdx < this.config.steamApiKey.length && !success; keyIdx++) {
        try {
          const url = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${this.config.steamApiKey[keyIdx]}&steamids=${chunk.join(',')}`
          const data = await this.proxyGet(url)
          if (data?.response?.players) {
            players.push(...data.response.players)
            success = true
          }
        } catch (e: any) {
          logger.warn(`API key #${keyIdx + 1} failed: ${e.message}`)
        }
      }

      if (!success && this.config.enableIpCheck) {
        try {
          const ip = await this.proxyGet('http://4.ipw.cn', { responseType: 'text' })
          const parts = String(ip).trim().split('.')
          logger.warn(`Steam API failed, IP: ${parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : ip}`)
        } catch { }
      }
    }

    logger.info(`getPlayerSummaries: fetched ${players.length} players`)
    return players
  }

  async getUserData(steamId: string): Promise<SteamProfile> {
    const domain = this.useSpeed ? this.config.steamSpeedDomain!.replace(/\/$/, '') : 'https://steamcommunity.com'
    const url = `${domain}/profiles/${steamId}`

    if (this.useSpeed && !domain.startsWith('http')) {
      throw new Error(`加速服务域名配置错误: "${domain}" - 必须以 https:// 或 http:// 开头`)
    }

    logger.info(`getUserData: ${steamId} via ${this.useSpeed ? 'Speed' : 'Direct'}`)

    let html = ''
    let page: any

    try {
      page = await this.ctx.puppeteer.page()

      if (typeof page.setRequestInterception === 'function') {
        await page.setRequestInterception(true)
        page.on('request', (req: any) => {
          try {
            const type = req.resourceType()
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
              req.abort()
            } else if (this.useSpeed) {
              req.continue({ headers: { ...req.headers(), 'user-agent': this.generateSpeedUserAgent() } })
            } else {
              req.continue()
            }
          } catch { }
        })
      }

      let mainRequestFailed = false
      let mainRequestStatus = 0

      page.on('response', (response: any) => {
        if (response.url() === url && response.status() >= 400) {
          mainRequestFailed = true
          mainRequestStatus = response.status()
        }
      })

      const startTime = Date.now()
      await page.goto(url, { waitUntil: 'load', timeout: this.config.requestTimeout })
      logger.info(`getUserData: page loaded in ${Date.now() - startTime}ms`)

      if (mainRequestFailed) {
        const source = this.useSpeed ? '加速服务' : 'Steam 社区'
        throw new Error(this.useSpeed
          ? `${source} 返回 HTTP ${mainRequestStatus}: 可能是 token 验证失败或时间戳过期`
          : `${source} 返回 HTTP ${mainRequestStatus}: 请检查 Steam ID 是否有效`)
      }

      html = await page.content()
    } catch (e: any) {
      const source = this.useSpeed ? '加速服务' : 'Steam 社区'
      const msg = e?.message || String(e)
      logger.error(`getUserData: ${steamId} failed - ${msg}`)

      if (msg.includes('Navigation timeout')) {
        throw new Error(`无法连接到 ${source} 或加载超时: 请检查网络配置`)
      } else if (msg.includes('net::ERR_')) {
        throw new Error(`${source} 连接失败: ${msg}`)
      }
      throw e
    } finally {
      if (page) await page.close().catch(() => { })
    }

    if (!html) throw new Error('无法获取 Steam 资料，账户不存在或为私密')

    return this.parseProfile(html, steamId)
  }

  private parseProfile(html: string, steamId: string): SteamProfile {
    const loadFn = typeof cheerio.load === 'function' ? cheerio.load : (cheerio as any).default?.load
    const $ = loadFn(html)

    const player_name = $('.actual_persona_name').text().trim() || $('title').text().replace('Steam 社区 :: ', '')
    const description = $('.profile_summary').text().trim().replace(/\t/g, '')

    let background = ''
    const bgMatch = ($('.no_header.profile_page').attr('style') || '').match(/background-image:\s*url\(\s*['"]?([^'" ]+)['"]?\s*\)/)
    if (bgMatch) background = bgMatch[1]

    const game_data: GameData[] = []
    $('.recent_game').each((_: number, el: any) => {
      const $el = $(el)
      const details = $el.find('.game_info_details').text()
      const playTimeMatch = details.match(/总时数\s*([\d\.]+)\s*小时/)
      const lastPlayedMatch = details.match(/最后运行日期：(.*?) 日/)

      const achievements: Achievement[] = []
      $el.find('.game_info_achievement:not(.plus_more)').each((__: number, achEl: any) => {
        achievements.push({
          name: $(achEl).attr('data-tooltip-text') || '',
          image: $(achEl).find('img').attr('src') || ''
        })
      })

      const summary = $el.find('.game_info_achievement_summary .ellipsis').text().split('/')
      game_data.push({
        game_name: $el.find('.game_name').text().trim(),
        game_image: $el.find('.game_capsule').attr('src') || '',
        play_time: playTimeMatch ? playTimeMatch[1] : '',
        last_played: lastPlayedMatch ? `最后运行日期：${lastPlayedMatch[1]} 日` : '当前正在游戏',
        achievements,
        completed_achievement_number: summary.length === 2 ? parseInt(summary[0]) : 0,
        total_achievement_number: summary.length === 2 ? parseInt(summary[1]) : 0
      })
    })

    return {
      steamid: steamId,
      player_name,
      avatar: $('.playerAvatarAutoSizeInner > img').attr('src') || '',
      background,
      description,
      recent_2_week_play_time: $('.recentgame_quicklinks.recentgame_recentplaytime > div').text().trim(),
      game_data
    }
  }
}
