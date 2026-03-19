import { Context, Service } from 'koishi'
import { Config } from './index'
import { SteamBind } from './database'
import { PlayerSummary, SteamProfile } from './service'
import { resolve } from 'path'
import { readFileSync } from 'fs'

declare module 'koishi' {
  interface Context { puppeteer: any }
}

const PERSONA_STATES = ['离线', '在线', '忙碌', '离开', '打盹', '寻求交易', '寻求游戏']

export class DrawService extends Service {
  private fontCss: string | null = null

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'drawer')
  }

  private getFontCss(): string {
    if (this.fontCss) return this.fontCss

    let css = `body { font-family: 'MiSans', sans-serif; margin: 0; padding: 0; background-color: #1e2024; color: #fff; }`
    const loadFont = (path: string, weight: string) => {
      try {
        const base64 = readFileSync(resolve(this.ctx.baseDir, path)).toString('base64')
        css += `@font-face { font-family: 'MiSans'; src: url(data:font/ttf;base64,${base64}) format('truetype'); font-weight: ${weight}; font-style: normal; }`
      } catch { }
    }

    loadFont(this.config.fonts.regular, 'normal')
    loadFont(this.config.fonts.light, '300')
    loadFont(this.config.fonts.bold, 'bold')

    this.fontCss = css
    return css
  }

  private toBase64(img: string | Buffer): string {
    if (Buffer.isBuffer(img)) return `data:image/png;base64,${img.toString('base64')}`
    if (typeof img === 'string' && img.length > 200 && !img.startsWith('http') && !img.startsWith('data:')) {
      return `data:image/png;base64,${img}`
    }
    return img
  }

  private escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
  }

  private async render(html: string, selector = 'body'): Promise<Buffer> {
    const page = await this.ctx.puppeteer.page()
    try {
      await page.setContent(html)
      const element = await page.$(selector)
      if (!element) throw new Error('渲染失败：找不到目标元素')
      return await element.screenshot({ type: 'png' })
    } finally {
      await page.close().catch(() => { })
    }
  }

  async drawStartGaming(player: PlayerSummary, nickname?: string): Promise<Buffer | string> {
    const name = nickname || player.personaname
    let game = player.gameextrainfo || 'Unknown Game'
    let status = '正在玩'

    if (this.config.replaceWallpaperEmoji && (game === 'Wallpaper Engine' || String(player.gameid) === '431960')) {
      status = '正在🛫'
      game = '(Wallpaper Engine)'
    }

    return this.render(`
      <html><head><style>
        ${this.getFontCss()}
        .container { width: 400px; height: 100px; display: flex; align-items: center; background-color: #1e2024; padding: 15px; box-sizing: border-box; }
        .avatar { width: 66px; height: 66px; margin-right: 20px; border-radius: 4px; }
        .info { display: flex; flex-direction: column; justify-content: center; }
        .name { font-size: 19px; color: #e3ffc2; margin-bottom: 4px; }
        .status { font-size: 17px; color: #969696; margin-bottom: 4px; }
        .game { font-size: 14px; font-weight: bold; color: #91c257; }
      </style></head><body>
        <div class="container">
          <img class="avatar" src="${player.avatarfull}" />
          <div class="info">
            <div class="name">${this.escape(name)}</div>
            <div class="status">${this.escape(status)}</div>
            <div class="game">${this.escape(game)}</div>
          </div>
        </div>
      </body></html>
    `, '.container')
  }

  async drawFriendsStatus(parentAvatar: Buffer | string, parentName: string, players: PlayerSummary[], binds: SteamBind[]): Promise<Buffer | string> {
    const sorted = [...players].sort((a, b) => this.getOrder(a) - this.getOrder(b))

    const groups = [
      { title: '游戏中', items: sorted.filter(p => p.gameextrainfo) },
      { title: '在线好友', items: sorted.filter(p => !p.gameextrainfo && p.personastate !== 0) },
      { title: '离线', items: sorted.filter(p => p.personastate === 0) }
    ].filter(g => g.items.length)

    let listHtml = ''
    for (const { title, items } of groups) {
      listHtml += `<div class="group-title">${title} (${items.length})</div>`
      for (const player of items) {
        const bind = binds.find(b => b.steamId === player.steamid)
        const name = this.escape(bind?.nickname || player.personaname)
        const avatar = player.avatarmedium || player.avatar

        let statusText: string, color: string
        if (player.gameextrainfo) {
          statusText = this.escape(player.gameextrainfo)
          color = '#91c257'
        } else if (player.personastate !== 0) {
          statusText = PERSONA_STATES[player.personastate] || '未知'
          color = '#6dcff6'
        } else {
          statusText = '离线'
          color = '#656565'
        }

        listHtml += `
          <div class="friend-item">
            <img class="friend-avatar" src="${avatar}" />
            <div class="friend-info">
              <div class="friend-name" style="color: ${color}">${name}</div>
              <div class="friend-status" style="color: ${color}">${statusText}</div>
            </div>
          </div>
        `
      }
    }

    return this.render(`
      <html><head><style>
        ${this.getFontCss()}
        body { width: 400px; background-color: #1e2024; }
        .main { background-color: #1e2024; }
        .header { padding: 16px; display: flex; align-items: center; height: 120px; box-sizing: border-box; background: linear-gradient(to bottom, #2b2e34 0%, #1e2024 100%); }
        .parent-avatar { width: 72px; height: 72px; border-radius: 4px; margin-right: 16px; }
        .parent-info { display: flex; flex-direction: column; }
        .parent-name { font-size: 20px; font-weight: bold; color: #6dcff6; margin-bottom: 4px; }
        .parent-status { font-size: 18px; color: #4c91ac; }
        .search-bar { height: 50px; background-color: #434953; display: flex; align-items: center; padding-left: 24px; color: #b7ccd5; font-size: 20px; }
        .list-container { padding: 16px 0; }
        .group-title { color: #c5d6d4; font-size: 22px; margin: 10px 22px; }
        .friend-item { display: flex; align-items: center; height: 64px; padding: 0 22px; }
        .friend-item:hover { background-color: #3d4450; }
        .friend-avatar { width: 50px; height: 50px; border-radius: 4px; margin-right: 16px; }
        .friend-info { display: flex; flex-direction: column; }
        .friend-name { font-size: 18px; font-weight: bold; margin-bottom: 4px; }
        .friend-status { font-size: 16px; }
      </style></head><body>
        <div class="main">
          <div class="header">
            <img class="parent-avatar" src="${this.toBase64(parentAvatar)}" />
            <div class="parent-info">
              <div class="parent-name">${this.escape(parentName)}</div>
              <div class="parent-status">在线</div>
            </div>
          </div>
          <div class="search-bar">好友</div>
          <div class="list-container">${listHtml}</div>
        </div>
      </body></html>
    `, 'body')
  }

  async drawPlayerStatus(profile: SteamProfile, steamId: string): Promise<Buffer | string> {
    const gamesHtml = profile.game_data.map(game => `
      <div class="game-row">
        <img class="game-img" src="${this.toBase64(game.game_image)}" />
        <div class="game-info">
          <div class="game-name">${this.escape(game.game_name)}</div>
          <div class="game-stats">
            <span class="play-time">${game.play_time ? `总时数 ${game.play_time} 小时` : ''}</span>
            <span class="last-played">${this.escape(game.last_played)}</span>
          </div>
        </div>
      </div>
    `).join('')

    return this.render(`
      <html><head><style>
        ${this.getFontCss()}
        body { width: 960px; background-color: #1b2838; position: relative; }
        .bg-container { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; background-image: url('${this.toBase64(profile.background)}'); background-size: cover; background-position: center; }
        .bg-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; background-color: rgba(0, 0, 0, 0.7); }
        .content { padding: 40px; z-index: 1; }
        .header { display: flex; align-items: flex-start; margin-bottom: 40px; }
        .profile-avatar { width: 200px; height: 200px; border: 3px solid #53a4c4; margin-right: 40px; }
        .profile-info { flex: 1; }
        .profile-name { font-size: 40px; color: white; margin-bottom: 10px; }
        .profile-id { font-size: 20px; color: #bfbfbf; margin-bottom: 20px; }
        .profile-desc { font-size: 22px; color: #bfbfbf; white-space: pre-wrap; max-width: 640px; }
        .games-section { margin-top: 20px; }
        .recent-header { background-color: rgba(0, 0, 0, 0.5); padding: 10px 20px; display: flex; justify-content: space-between; color: white; font-size: 26px; margin-bottom: 10px; }
        .game-row { background-color: rgba(0, 0, 0, 0.3); height: 100px; display: flex; align-items: center; padding: 10px 20px; margin-bottom: 10px; }
        .game-img { width: 184px; height: 69px; margin-right: 20px; }
        .game-info { flex: 1; display: flex; flex-direction: column; justify-content: center; }
        .game-name { font-size: 26px; color: white; margin-bottom: 8px; }
        .game-stats { font-size: 20px; color: #969696; display: flex; gap: 20px; }
      </style></head><body>
        <div class="bg-container"></div>
        <div class="bg-overlay"></div>
        <div class="content">
          <div class="header">
            <img class="profile-avatar" src="${this.toBase64(profile.avatar)}" />
            <div class="profile-info">
              <div class="profile-name">${this.escape(profile.player_name)}</div>
              <div class="profile-id">ID: ${steamId}</div>
              <div class="profile-desc">${this.escape(profile.description)}</div>
            </div>
          </div>
          <div class="games-section">
            <div class="recent-header">
              <span>最近游戏</span>
              <span>${profile.recent_2_week_play_time || ''}</span>
            </div>
            ${gamesHtml}
          </div>
        </div>
      </body></html>
    `, 'body')
  }

  async getDefaultAvatar(): Promise<Buffer | string> {
    return this.render(`<html><body style="margin:0;padding:0;"><div style="width:100px;height:100px;background-color:#ccc;"></div></body></html>`, 'div')
  }

  private getOrder(p: PlayerSummary): number {
    if (p.gameextrainfo) return 0
    if (p.personastate !== 0) return 1
    return 2
  }
}
