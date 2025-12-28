import { Context, Schema, Logger, Service, Session, h } from 'koishi'
import { SteamService } from './service'
import { DrawService } from './drawer'
import { SteamBind, SteamChannel } from './database'

export const name = 'steam-info'
export const inject = ['model', 'http', 'puppeteer', 'database']

export interface Config {
  steamApiKey: string[]
  proxy?: string
  steamRequestInterval: number
  steamBroadcastType: 'all' | 'part' | 'none'
  steamDisableBroadcastOnStartup: boolean
  fonts: {
    regular: string
    light: string
    bold: string
  }
  commandAuthority: {
    bind: number
    unbind: number
    info: number
    check: number
    enable: number
    disable: number
    update: number
    nickname: number
  }
}

export const Config: Schema<Config> = Schema.object({
  steamApiKey: Schema.array(String).required().description('Steam API Key (supports multiple)'),
  proxy: Schema.string().description('Proxy URL (e.g., http://127.0.0.1:7890)'),
  steamRequestInterval: Schema.number().default(300).description('Polling interval in seconds'),
  steamBroadcastType: Schema.union(['all', 'part', 'none']).default('part').description('Broadcast type: all (list), part (gaming only), none (text only)'),
  steamDisableBroadcastOnStartup: Schema.boolean().default(false).description('Disable broadcast on startup'),
  fonts: Schema.object({
    regular: Schema.string().default('fonts/MiSans-Regular.ttf'),
    light: Schema.string().default('fonts/MiSans-Light.ttf'),
    bold: Schema.string().default('fonts/MiSans-Bold.ttf'),
  }).description('Font paths relative to the plugin resource directory or absolute paths'),
  commandAuthority: Schema.object({
    bind: Schema.number().default(1).description('Authority for bind command'),
    unbind: Schema.number().default(1).description('Authority for unbind command'),
    info: Schema.number().default(1).description('Authority for info command'),
    check: Schema.number().default(1).description('Authority for check command'),
    enable: Schema.number().default(2).description('Authority for enable broadcast'),
    disable: Schema.number().default(2).description('Authority for disable broadcast'),
    update: Schema.number().default(2).description('Authority for update group info'),
    nickname: Schema.number().default(1).description('Authority for nickname command'),
  }).description('Command Authorities'),
})

export const logger = new Logger('steam-info')

declare module 'koishi' {
  interface Context {
    steam: SteamService
    drawer: DrawService
  }
}

export function apply(ctx: Context, config: Config) {
  // Localization
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

  // Services
  ctx.plugin(SteamService, config)
  ctx.plugin(DrawService, config)

  // Database
  ctx.model.extend('steam_bind', {
    id: 'unsigned',
    userId: 'string',
    channelId: 'string',
    steamId: 'string',
    nickname: 'string',
  }, {
    primary: 'id',
    autoInc: true,
  })

  ctx.model.extend('steam_channel', {
    id: 'string', // channelId
    enable: 'boolean',
    name: 'string',
    avatar: 'string',
  }, {
    primary: 'id',
  })

  // Commands
  ctx.command('steam', 'Steam Information')

  ctx.command('steam.bind <steamId:string>', 'Bind Steam ID', { authority: config.commandAuthority.bind })
    .alias('steambind', '绑定steam')
    .action(async ({ session }, steamId) => {
      if (!session) return
      if (!steamId || !/^\d+$/.test(steamId)) return session.text('.invalid_id')
      
      const targetId = await ctx.steam.getSteamId(steamId)
      if (!targetId) return session.text('.id_not_found')

      await ctx.database.upsert('steam_bind', [
        {
          userId: session.userId,
          channelId: session.channelId,
          steamId: targetId,
        }
      ], ['userId', 'channelId'])

      return session.text('.bind_success', [targetId])
    })

  ctx.command('steam.unbind', 'Unbind Steam ID', { authority: config.commandAuthority.unbind })
    .alias('steamunbind', '解绑steam')
    .action(async ({ session }) => {
      if (!session) return
      const result = await ctx.database.remove('steam_bind', {
        userId: session.userId,
        channelId: session.channelId,
      })
      return result ? session.text('.unbind_success') : session.text('.not_bound')
    })

  ctx.command('steam.info [target:text]', 'View Steam Profile', { authority: config.commandAuthority.info })
    .alias('steaminfo', 'steam信息')
    .action(async ({ session }, target) => {
      if (!session) return
      let steamId: string | null = null
      if (target) {
        // Check if target is mention
        const [platform, userId] = session.resolve(target)
        if (userId) {
           const bind = await ctx.database.get('steam_bind', { userId, channelId: session.channelId })
           if (bind.length) steamId = bind[0].steamId
        } else if (/^\d+$/.test(target)) {
           steamId = await ctx.steam.getSteamId(target)
        }
      } else {
        const bind = await ctx.database.get('steam_bind', { userId: session.userId, channelId: session.channelId })
        if (bind.length) steamId = bind[0].steamId
      }

      if (!steamId) return session.text('.user_not_found')

      const profile = await ctx.steam.getUserData(steamId)
      const image = await ctx.drawer.drawPlayerStatus(profile, steamId)
      if (typeof image === 'string') return session.send(image)
      return session.send(h.image(image, 'image/png'))
    })

  ctx.command('steam.check', 'Check Friends Status', { authority: config.commandAuthority.check })
    .alias('steamcheck', '查看steam', '查steam')
    .action(async ({ session }) => {
      if (!session) return
      const binds = await ctx.database.get('steam_bind', { channelId: session.channelId })
      if (binds.length === 0) return session.text('.no_binds')

      const steamIds = binds.map(b => b.steamId)
      const summaries = await ctx.steam.getPlayerSummaries(steamIds)
      
      if (summaries.length === 0) return session.text('.api_error')

      const channelInfo = await ctx.database.get('steam_channel', { id: session.channelId })
      const parentAvatar = channelInfo[0]?.avatar 
        ? Buffer.from(channelInfo[0].avatar, 'base64') 
        : await ctx.drawer.getDefaultAvatar()
      const parentName = channelInfo[0]?.name || session.channelId || 'Unknown'

      const image = await ctx.drawer.drawFriendsStatus(parentAvatar, parentName, summaries, binds)
      if (typeof image === 'string') return session.send(image)
      return session.send(h.image(image, 'image/png'))
    })

  ctx.command('steam.enable', 'Enable Broadcast', { authority: config.commandAuthority.enable })
    .alias('steamenable', '启用steam')
    .action(async ({ session }) => {
      if (!session) return
      await ctx.database.upsert('steam_channel', [{ id: session.channelId, enable: true }])
      return session.text('.enable_success')
    })

  ctx.command('steam.disable', 'Disable Broadcast', { authority: config.commandAuthority.disable })
    .alias('steamdisable', '禁用steam')
    .action(async ({ session }) => {
      if (!session) return
      await ctx.database.upsert('steam_channel', [{ id: session.channelId, enable: false }])
      return session.text('.disable_success')
    })
  
  ctx.command('steam.update [name:string] [avatar:image]', 'Update Group Info', { authority: config.commandAuthority.update })
    .alias('steamupdate', '更新群信息')
    .action(async ({ session }, name, avatar) => {
        if (!session) return
        const img = session.elements && session.elements.find(e => e.type === 'img')
        const imgUrl = img?.attrs?.src
        
        let avatarBase64 = null
        if (imgUrl) {
            const buffer = await ctx.http.get(imgUrl, { responseType: 'arraybuffer' })
            avatarBase64 = Buffer.from(buffer).toString('base64')
        }

        if (!name && !avatarBase64) return session.text('.args_missing')

        const update: any = { id: session.channelId }
        if (name) update.name = name
        if (avatarBase64) update.avatar = avatarBase64
        
        await ctx.database.upsert('steam_channel', [update])
        return session.text('.update_success')
    })

  ctx.command('steam.nickname <nickname:string>', 'Set Steam Nickname', { authority: config.commandAuthority.nickname })
    .alias('steamnickname', 'steam昵称')
    .action(async ({ session }, nickname) => {
      if (!session) return
      const bind = await ctx.database.get('steam_bind', { userId: session.userId, channelId: session.channelId })
      if (!bind.length) return session.text('.not_bound')
      
      await ctx.database.upsert('steam_bind', [{ ...bind[0], nickname }])
      return session.text('.nickname_set', [nickname])
    })

  // Scheduler
  ctx.setInterval(async () => {
    await broadcast(ctx)
  }, config.steamRequestInterval * 1000)
}

// Broadcast Logic
const statusCache = new Map<string, any>()

async function broadcast(ctx: Context) {
  const channels = await ctx.database.get('steam_channel', { enable: true })
  if (channels.length === 0) return

  const channelIds = channels.map(c => c.id)
  const binds = await ctx.database.get('steam_bind', { channelId: channelIds })
  if (binds.length === 0) return

  const steamIds = [...new Set(binds.map(b => b.steamId))]
  
  const currentSummaries = await ctx.steam.getPlayerSummaries(steamIds)
  const currentMap = new Map(currentSummaries.map(p => [p.steamid, p]))

  for (const channel of channels) {
    const channelBinds = binds.filter(b => b.channelId === channel.id)
    const msgs: string[] = []
    const startGamingPlayers: any[] = []

    for (const bind of channelBinds) {
      const current = currentMap.get(bind.steamId)
      const old = statusCache.get(bind.steamId)
      
      if (!current) continue
      
      if (!old) continue 

      const oldGame = old.gameextrainfo
      const newGame = current.gameextrainfo
      const name = bind.nickname || current.personaname

      if (newGame && !oldGame) {
        msgs.push(`${name} 开始玩 ${newGame} 了`)
        startGamingPlayers.push({ ...current, nickname: bind.nickname })
      } else if (!newGame && oldGame) {
        msgs.push(`${name} 玩了 ${oldGame} 后不玩了`)
      } else if (newGame && oldGame && newGame !== oldGame) {
        msgs.push(`${name} 停止玩 ${oldGame}，开始玩 ${newGame} 了`)
      }
    }

    if (msgs.length > 0) {
        const bot = ctx.bots[0]
        if (!bot) continue

        if (ctx.config.steamBroadcastType === 'none') {
            await bot.sendMessage(channel.id, msgs.join('\n'))
        } else if (ctx.config.steamBroadcastType === 'part') {
            if (startGamingPlayers.length > 0) {
                const images = await Promise.all(startGamingPlayers.map(p => ctx.drawer.drawStartGaming(p, p.nickname)))
                const combined = await ctx.drawer.concatImages(images)
                const img = combined ? (typeof combined === 'string' ? combined : h.image(combined, 'image/png')) : ''
                await bot.sendMessage(channel.id, msgs.join('\n') + img)
            } else {
                await bot.sendMessage(channel.id, msgs.join('\n'))
            }
        } else if (ctx.config.steamBroadcastType === 'all') {
            const channelPlayers = channelBinds.map(b => currentMap.get(b.steamId)).filter(Boolean) as any[]
            const parentAvatar = channel.avatar ? Buffer.from(channel.avatar, 'base64') : await ctx.drawer.getDefaultAvatar()
            const image = await ctx.drawer.drawFriendsStatus(parentAvatar, channel.name || channel.id, channelPlayers, channelBinds)
            const img = image ? (typeof image === 'string' ? image : h.image(image, 'image/png')) : ''
            await bot.sendMessage(channel.id, msgs.join('\n') + img)
        }
    }
  }

  for (const p of currentSummaries) {
      statusCache.set(p.steamid, p)
  }
}
