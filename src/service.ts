import { Context, Service } from 'koishi'
import { Config } from './index'
import * as cheerio from 'cheerio'

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

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'steam', true)
    this.http = ctx.http.extend({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })

    if (config.enableProxy && config.proxy) {
      try {
        const undici = require('undici')
        this.dispatcher = new undici.ProxyAgent(config.proxy)
        this.proxyFetch = undici.fetch
        ctx.logger('steam').info(`Proxy is enabled: ${config.proxy}`)
      } catch (e) {
        ctx.logger('steam').warn(`Failed to init proxy: ${e}`)
      }
    }
  }

  private async proxyGet<T = any>(url: string, options?: { headers?: Record<string, string>, timeout?: number, responseType?: string, maxRedirects?: number }): Promise<T> {
    if (!this.dispatcher || !this.proxyFetch) return this.http.get(url, options)

    const fetchOptions: any = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...options?.headers,
      },
      dispatcher: this.dispatcher,
      redirect: 'follow',
      signal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined
    }

    const response = await this.proxyFetch(url, fetchOptions)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)

    if (options?.responseType === 'text') return await response.text() as T
    if (options?.responseType === 'arraybuffer') return await response.arrayBuffer() as unknown as T

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('text/html') || contentType.includes('text/plain')) {
      return await response.text() as T
    }
    return await response.json() as T
  }

  async getLocalizedGameName(inputAppid: string | number): Promise<string> {
    const appid = String(inputAppid)
    if (this.gameNameCache.has(appid)) return this.gameNameCache.get(appid)!

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const data = await this.proxyGet(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese`, { timeout: 10000 })
        if (data?.[appid]?.success) {
          const name = data[appid].data.name
          this.gameNameCache.set(appid, name)
          return name
        }
        break
      } catch (e) {
        if (attempt === 3) {
          this.ctx.logger('steam').warn(`Game name fetch failed for ${appid}: ${e}`)
        } else {
          await new Promise(res => setTimeout(res, attempt * 1000))
        }
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
    if (steamIds.length === 0) return []
    const players: PlayerSummary[] = []

    for (let i = 0; i < steamIds.length; i += 100) {
      const chunk = steamIds.slice(i, i + 100)
      let success = false

      for (const key of this.config.steamApiKey) {
        try {
          const url = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${chunk.join(',')}`
          const data = await this.proxyGet(url)
          if (data?.response?.players) {
            players.push(...data.response.players)
            success = true
            break
          }
        } catch (e: any) {
          this.ctx.logger('steam').error(`API key ${key} failed: ${e.message || e}`)
        }
      }

      if (!success && this.config.enableIpCheck) {
        await this.checkAndLogIp()
      }
    }
    return players
  }

  private async checkAndLogIp(): Promise<void> {
    try {
      const ip = await this.proxyGet('http://4.ipw.cn', { responseType: 'text' })
      const parts = String(ip).trim().split('.')
      const ipStr = parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : String(ip).trim()
      this.ctx.logger('steam').warn(`Steam API failed, current IP: ${ipStr}`)
    } catch (e: any) {
      this.ctx.logger('steam').error(`IP check failed: ${e.message || e}`)
    }
  }

  async getUserData(steamId: string): Promise<SteamProfile> {
    const url = `https://steamcommunity.com/profiles/${steamId}`
    let html: string = ''
    let page: any

    try {
      page = await this.ctx.puppeteer.page()
      if (typeof page.setRequestInterception === 'function') {
        await page.setRequestInterception(true)
        page.on('request', (req: any) => {
          if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) {
            req.abort()
          } else {
            req.continue()
          }
        })
      }
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 })
      html = await page.content()
    } catch (e) {
      throw new Error(`无法连接到 Steam 社区或加载超时: ${e}`)
    } finally {
      if (page) await page.close().catch(() => { })
    }

    if (!html || typeof html !== 'string') {
      throw new Error('无法获取 Steam 资料，账户不存在或为私密')
    }

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
      const play_time_match = details.match(/总时数\s*([\d\.]+)\s*小时/)
      const last_played_match = details.match(/最后运行日期：(.*?) 日/)

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
        play_time: play_time_match ? play_time_match[1] : '',
        last_played: last_played_match ? `最后运行日期：${last_played_match[1]} 日` : '当前正在游戏',
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

