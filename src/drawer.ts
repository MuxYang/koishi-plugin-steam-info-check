import { Context, Service } from 'koishi'
import { Config } from './index'
import { SteamBind } from './database'
import { PlayerSummary, SteamProfile } from './service'
import { resolve } from 'path'
import { readFileSync } from 'fs'

declare module 'koishi' {
  interface Context {
    puppeteer: any
  }
}

export class DrawService extends Service {
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'drawer')
  }

  private getFontCss(): string {

    let css = `
      body { font-family: 'MiSans', sans-serif; margin: 0; padding: 0; background-color: #1e2024; color: #fff; }
    `

    const loadFont = (name: string, path: string, weight: string) => {
      try {
        const fullPath = resolve(this.ctx.baseDir, path)
        const buffer = readFileSync(fullPath)
        const base64 = buffer.toString('base64')
        css += `
          @font-face {
            font-family: '${name}';
            src: url(data:font/ttf;base64,${base64}) format('truetype');
            font-weight: ${weight};
            font-style: normal;
          }
        `
      } catch (e) {
        // Font not found, ignore
      }
    }

    loadFont('MiSans', this.config.fonts.regular, 'normal')
    loadFont('MiSans', this.config.fonts.light, '300')
    loadFont('MiSans', this.config.fonts.bold, 'bold')

    return css
  }

  private imageToBase64(img: string | Buffer): string {
    if (Buffer.isBuffer(img)) {
      return `data:image/png;base64,${img.toString('base64')}`
    }
    return img
  }

  /** HTML 转义，防止渲染问题 */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  async drawStartGaming(player: PlayerSummary, nickname?: string): Promise<Buffer | string> {
    const avatarUrl = player.avatarfull
    const name = nickname || player.personaname
    let game = player.gameextrainfo || 'Unknown Game'
    let status = '正在玩'

    if (game === 'Wallpaper Engine' || String(player.gameid) === '431960') {
      status = '正在🛫'
      game = '(Wallpaper Engine)'
    }

    const html = `
    <html>
      <head>
        <style>
          ${this.getFontCss()}
          .container {
            width: 400px;
            height: 100px;
            display: flex;
            align-items: center;
            background-color: #1e2024;
            padding: 15px;
            box-sizing: border-box;
          }
          .avatar {
            width: 66px;
            height: 66px;
            margin-right: 20px;
            border-radius: 4px;
          }
          .info {
            display: flex;
            flex-direction: column;
            justify-content: center;
          }
          .name {
            font-size: 19px;
            color: #e3ffc2;
            margin-bottom: 4px;
          }
          .status {
            font-size: 17px;
            color: #969696;
            margin-bottom: 4px;
          }
          .game {
            font-size: 14px;
            font-weight: bold;
            color: #91c257;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <img class="avatar" src="${avatarUrl}" />
          <div class="info">
            <div class="name">${this.escapeHtml(name)}</div>
            <div class="status">${this.escapeHtml(status)}</div>
            <div class="game">${this.escapeHtml(game)}</div>
          </div>
        </div>
      </body>
    </html>
    `

    const page = await this.ctx.puppeteer.page()
    await page.setContent(html)
    const element = await page.$('.container')
    const buffer = await element.screenshot({ type: 'png' })
    await page.close()
    return buffer
  }

  async drawFriendsStatus(parentAvatar: Buffer | string, parentName: string, players: PlayerSummary[], binds: SteamBind[]): Promise<Buffer | string> {
    const sorted = [...players].sort((a, b) => {
      const stateA = this.getPlayerStateOrder(a)
      const stateB = this.getPlayerStateOrder(b)
      return stateA - stateB
    })

    const groups = [
      { title: '游戏中', items: sorted.filter(p => p.gameextrainfo) },
      { title: '在线好友', items: sorted.filter(p => !p.gameextrainfo && p.personastate !== 0) },
      { title: '离线', items: sorted.filter(p => p.personastate === 0) }
    ].filter(g => g.items.length > 0)

    const parentAvatarSrc = this.imageToBase64(parentAvatar)

    let listHtml = ''
    for (const group of groups) {
      listHtml += `<div class="group-title">${group.title} (${group.items.length})</div>`
      for (const player of group.items) {
        const bind = binds.find(b => b.steamId === player.steamid)
        const name = this.escapeHtml(bind?.nickname || player.personaname)
        const avatar = player.avatarmedium || player.avatar

        let statusText = '离线'
        let nameColor = '#656565'
        let statusColor = '#656565'

        if (player.gameextrainfo) {
          statusText = this.escapeHtml(player.gameextrainfo)
          nameColor = '#91c257'
          statusColor = '#91c257'
        } else if (player.personastate !== 0) {
          statusText = this.getPersonaStateText(player.personastate)
          nameColor = '#6dcff6'
          statusColor = '#6dcff6'
        }

        listHtml += `
          <div class="friend-item">
            <img class="friend-avatar" src="${avatar}" />
            <div class="friend-info">
              <div class="friend-name" style="color: ${nameColor}">${name}</div>
              <div class="friend-status" style="color: ${statusColor}">${statusText}</div>
            </div>
          </div>
        `
      }
    }

    const html = `
    <html>
      <head>
        <style>
          ${this.getFontCss()}
          body {
            width: 400px;
            background-color: #1e2024;
          }
          .header {
            padding: 16px;
            display: flex;
            align-items: center;
            height: 120px;
            box-sizing: border-box;
            background: linear-gradient(to bottom, #2b2e34 0%, #1e2024 100%); 
          }
          .parent-avatar {
            width: 72px;
            height: 72px;
            border-radius: 4px;
            margin-right: 16px;
          }
          .parent-info {
            display: flex;
            flex-direction: column;
          }
          .parent-name {
            font-size: 20px;
            font-weight: bold;
            color: #6dcff6;
            margin-bottom: 4px;
          }
          .parent-status {
            font-size: 18px;
            color: #4c91ac;
          }
          .search-bar {
            height: 50px;
            background-color: #434953;
            display: flex;
            align-items: center;
            padding-left: 24px;
            color: #b7ccd5;
            font-size: 20px;
          }
          .list-container {
            padding: 16px 0;
          }
          .group-title {
            color: #c5d6d4;
            font-size: 22px;
            margin: 10px 22px;
          }
          .friend-item {
            display: flex;
            align-items: center;
            height: 64px;
            padding: 0 22px;
          }
          .friend-item:hover {
            background-color: #3d4450;
          }
          .friend-avatar {
            width: 50px;
            height: 50px;
            border-radius: 4px;
            margin-right: 16px;
          }
          .friend-info {
            display: flex;
            flex-direction: column;
          }
          .friend-name {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 4px;
          }
          .friend-status {
            font-size: 16px;
          }
        </style>
      </head>
      <body>
        <div class="main">
          <div class="header">
            <img class="parent-avatar" src="${parentAvatarSrc}" />
            <div class="parent-info">
              <div class="parent-name">${this.escapeHtml(parentName)}</div>
              <div class="parent-status">在线</div>
            </div>
          </div>
          <div class="search-bar">好友</div>
          <div class="list-container">
            ${listHtml}
          </div>
        </div>
      </body>
    </html>
    `

    const page = await this.ctx.puppeteer.page()
    await page.setContent(html)
    const element = await page.$('body')
    const buffer = await element.screenshot({ type: 'png' })
    await page.close()
    return buffer
  }

  async drawPlayerStatus(profile: SteamProfile, steamId: string): Promise<Buffer | string> {
    const bgSrc = this.imageToBase64(profile.background)
    const avatarSrc = this.imageToBase64(profile.avatar)

    let gamesHtml = ''
    for (const game of profile.game_data) {
      const gameImg = this.imageToBase64(game.game_image)
      gamesHtml += `
        <div class="game-row">
          <img class="game-img" src="${gameImg}" />
          <div class="game-info">
            <div class="game-name">${this.escapeHtml(game.game_name)}</div>
            <div class="game-stats">
              <span class="play-time">${game.play_time ? `总时数 ${game.play_time} 小时` : ''}</span>
              <span class="last-played">${this.escapeHtml(game.last_played)}</span>
            </div>
          </div>
        </div>
      `
    }

    const html = `
    <html>
      <head>
        <style>
          ${this.getFontCss()}
          body {
            width: 960px;
            background-color: #1b2838;
            position: relative;
          }
          .bg-container {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: -1;
            background-image: url('${bgSrc}');
            background-size: cover;
            background-position: center;
          }
          .bg-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: -1;
            background-color: rgba(0, 0, 0, 0.7);
          }
          .content {
            padding: 40px;
            z-index: 1;
          }
          .header {
            display: flex;
            align-items: flex-start;
            margin-bottom: 40px;
          }
          .profile-avatar {
            width: 200px;
            height: 200px;
            border: 3px solid #53a4c4;
            margin-right: 40px;
          }
          .profile-info {
            flex: 1;
          }
          .profile-name {
            font-size: 40px;
            color: white;
            margin-bottom: 10px;
          }
          .profile-id {
            font-size: 20px;
            color: #bfbfbf;
            margin-bottom: 20px;
          }
          .profile-desc {
            font-size: 22px;
            color: #bfbfbf;
            white-space: pre-wrap;
            max-width: 640px;
          }
          .games-section {
            margin-top: 20px;
          }
          .recent-header {
            background-color: rgba(0, 0, 0, 0.5);
            padding: 10px 20px;
            display: flex;
            justify-content: space-between;
            color: white;
            font-size: 26px;
            margin-bottom: 10px;
          }
          .game-row {
            background-color: rgba(0, 0, 0, 0.3);
            height: 100px;
            display: flex;
            align-items: center;
            padding: 10px 20px;
            margin-bottom: 10px;
          }
          .game-img {
            width: 184px;
            height: 69px;
            margin-right: 20px;
          }
          .game-info {
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
          }
          .game-name {
            font-size: 26px;
            color: white;
            margin-bottom: 8px;
          }
          .game-stats {
            font-size: 20px;
            color: #969696;
            display: flex;
            gap: 20px;
          }
        </style>
      </head>
      <body>
        <div class="bg-container"></div>
        <div class="bg-overlay"></div>
        <div class="content">
          <div class="header">
            <img class="profile-avatar" src="${avatarSrc}" />
            <div class="profile-info">
              <div class="profile-name">${this.escapeHtml(profile.player_name)}</div>
              <div class="profile-id">ID: ${steamId}</div>
              <div class="profile-desc">${this.escapeHtml(profile.description)}</div>
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
      </body>
    </html>
    `

    const page = await this.ctx.puppeteer.page()
    await page.setContent(html)
    const element = await page.$('body')
    const buffer = await element.screenshot({ type: 'png' })
    await page.close()
    return buffer
  }

  async getDefaultAvatar(): Promise<Buffer | string> {
    const html = `
      <html><body style="margin:0;padding:0;"><div style="width:100px;height:100px;background-color:#ccc;"></div></body></html>
    `
    const page = await this.ctx.puppeteer.page()
    await page.setContent(html)
    const element = await page.$('div')
    const buffer = await element.screenshot({ type: 'png' })
    await page.close()
    return buffer
  }

  private getPlayerStateOrder(p: PlayerSummary) {
    if (p.gameextrainfo) return 0
    if (p.personastate !== 0) return 1
    return 2
  }

  private getPersonaStateText(state: number) {
    const map = ['离线', '在线', '忙碌', '离开', '打盹', '寻求交易', '寻求游戏']
    return map[state] || '未知'
  }
}