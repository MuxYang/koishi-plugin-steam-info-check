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
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'steam', true)
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
      for (const key of this.config.steamApiKey) {
        try {
          const url = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${chunk.join(',')}`
          const data = await this.ctx.http.get(url)
          if (data?.response?.players) {
            players.push(...data.response.players)
            break
          }
        } catch (e) {
          this.ctx.logger('steam').error(`API key ${key} failed: ${e}`)
        }
      }
    }
    return players
  }

  async getUserData(steamId: string): Promise<SteamProfile> {
    const url = `https://steamcommunity.com/profiles/${steamId}`
    const headers = {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cookie': 'timezoneOffset=28800,0'
    }

    const html = await this.ctx.http.get(url, { headers })
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
