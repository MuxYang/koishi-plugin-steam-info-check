import { Context, Service } from 'koishi'
import { Config } from './index'
import cheerio from 'cheerio'

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

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'steam', true)
    this.http = ctx.http.extend({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    })
    
    if (config.proxy) {
      this.http = this.http.extend({ proxy: config.proxy })
    }
  }

  private gameNameCache = new Map<string, string>()

  async getLocalizedGameName(inputAppid: string | number): Promise<string> {
    const appid = String(inputAppid)
    if (this.gameNameCache.has(appid)) {
      return this.gameNameCache.get(appid)!
    }

    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const data = await this.http.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese`, { timeout: 10000 })
        if (data?.[appid]?.success) {
          const name = data[appid].data.name
          this.gameNameCache.set(appid, name)
          return name
        }
        break
      } catch (e) {
        if (attempt === maxRetries) {
          this.ctx.logger('steam').warn(`Failed to get game name for ${appid} after ${maxRetries} retries: ${e}`)
        } else {
          await new Promise(res => setTimeout(res, Math.min(1000 * attempt, 5000)))
        }
      }
    }
    
    return ''
  }

  async getSteamId(input: string): Promise<string | null> {
    if (!/^\d+$/.test(input)) return null
    const id = BigInt(input)
    if (id < STEAM_ID_OFFSET) {
      return (id + STEAM_ID_OFFSET).toString()
    }
    return input
  }

  async getPlayerSummaries(steamIds: string[]): Promise<PlayerSummary[]> {
    if (steamIds.length === 0) return []
    
    const chunks: string[][] = []
    for (let i = 0; i < steamIds.length; i += 100) {
      chunks.push(steamIds.slice(i, i + 100))
    }

    const players: PlayerSummary[] = []
    for (const chunk of chunks) {
      let success = false
      for (const key of this.config.steamApiKey) {
        try {
          const url = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${chunk.join(',')}`
          const data = await this.http.get(url)
          if (data?.response?.players) {
            players.push(...data.response.players)
            success = true
            break
          }
        } catch (e) {
          this.ctx.logger('steam').error(`API key ${key} failed: ${e}`)
        }
      }
      
      // 如果所有key都失败且启用IP检测，执行IP检测
      if (!success && this.config.enableIpCheck) {
        await this.checkAndLogIp()
      }
    }
    return players
  }

  private async checkAndLogIp(): Promise<void> {
    try {
      const ip = await this.http.get('http://4.ipw.cn', { responseType: 'text' })
      const ipStr = String(ip).trim()
      const parts = ipStr.split('.')
      if (parts.length === 4) {
        const maskedIp = `${parts[0]}.${parts[1]}.*.*`
        this.ctx.logger('steam').warn(`Steam API连接失败，当前IP: ${maskedIp}`)
      } else {
        this.ctx.logger('steam').warn(`Steam API连接失败，IP检测返回: ${ipStr}`)
      }
    } catch (e) {
      this.ctx.logger('steam').error(`IP检测失败: ${e}`)
    }
  }

  async getUserData(steamId: string): Promise<SteamProfile> {
    const url = `https://steamcommunity.com/profiles/${steamId}`
    const headers = {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cookie': 'timezoneOffset=28800,0'
    }

    let html: any
    try {
      html = await this.http.get(url, { headers, timeout: 30000, maxRedirects: 5 })
    } catch (e) {
      this.ctx.logger('steam').error(`获取Steam资料失败 (网络错误): ${e}`)
      throw new Error(`无法连接到Steam社区: ${e}`)
    }

    if (!html) {
      this.ctx.logger('steam').error(`获取Steam资料失败: HTML为空，steamId=${steamId}`)
      throw new Error('无法获取Steam资料，可能是账户不存在或为私密')
    }

    const $ = cheerio.load(html)

    const player_name = $('.actual_persona_name').text().trim() || $('title').text().replace('Steam 社区 :: ', '')
    const description = $('.profile_summary').text().trim().replace(/\t/g, '')
    
    let background = ''
    const bgStyle = $('.no_header.profile_page').attr('style') || ''
    const bgMatch = bgStyle.match(/background-image:\s*url\(\s*['"]?([^'" ]+)['"]?\s*\)/)
    if (bgMatch) background = bgMatch[1]

    const avatar = $('.playerAvatarAutoSizeInner > img').attr('src') || ''
    const recent_2_week_play_time = $('.recentgame_quicklinks.recentgame_recentplaytime > div').text().trim()

    const game_data: GameData[] = []
    $('.recent_game').each((i: number, el: any) => {
      const game_name = $(el).find('.game_name').text().trim()
      const game_image = $(el).find('.game_capsule').attr('src') || ''
      const details = $(el).find('.game_info_details').text()
      
      const play_time_match = details.match(/总时数\s*([\d\.]+)\s*小时/)
      const play_time = play_time_match ? play_time_match[1] : ''
      
      const last_played_match = details.match(/最后运行日期：(.*) 日/)
      const last_played = last_played_match ? `最后运行日期：${last_played_match[1]} 日` : '当前正在游戏'

      const achievements: Achievement[] = []
      $(el).find('.game_info_achievement').each((j: number, achEl: any) => {
        if ($(achEl).hasClass('plus_more')) return
        achievements.push({
          name: $(achEl).attr('data-tooltip-text') || '',
          image: $(achEl).find('img').attr('src') || ''
        })
      })

      const summary = $(el).find('.game_info_achievement_summary').find('.ellipsis').text()
      let completed_achievement_number = 0
      let total_achievement_number = 0
      if (summary) {
        const parts = summary.split('/')
        if (parts.length === 2) {
          completed_achievement_number = parseInt(parts[0])
          total_achievement_number = parseInt(parts[1])
        }
      }

      game_data.push({
        game_name,
        game_image,
        play_time,
        last_played,
        achievements,
        completed_achievement_number,
        total_achievement_number
      })
    })

    return {
      steamid: steamId,
      player_name,
      avatar,
      background,
      description,
      recent_2_week_play_time,
      game_data
    }
  }
}
