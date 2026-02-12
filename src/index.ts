import { Context, Schema, Logger, Session, h } from 'koishi'
import { SteamService, PlayerSummary } from './service'
import { DrawService } from './drawer'
import { SteamBind, SteamChannel } from './database'
import zhCN from './locales/zh-CN'

export const name = 'steam-info'
export const inject = ['model', 'http', 'puppeteer', 'database']

export interface Config {
  steamApiKey: string[]
  enableProxy: boolean
  proxy?: string
  steamRequestInterval: number
  startBroadcastType: 'all' | 'part' | 'none' | 'list' | 'text_image' | 'image' | 'text'
  steamDisableBroadcastOnStartup: boolean
  enableIpCheck: boolean
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

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    steamApiKey: Schema.array(String).required().description('Steam API Key（支持多个）'),
    enableProxy: Schema.boolean().default(false).description('启用代理'),
  }),
  Schema.union([
    Schema.object({
      enableProxy: Schema.const(true).required(),
      proxy: Schema.string().required().description('代理地址，例如 http://127.0.0.1:7890'),
    }),
    Schema.object({
      enableProxy: Schema.const(false) as Schema<boolean>,
    }),
  ]),
  Schema.object({
    steamRequestInterval: Schema.number().default(300).description('轮询间隔（秒）'),
    startBroadcastType: Schema.union(['all', 'part', 'none', 'list', 'text_image', 'image', 'text']).default('text_image').description('播报方式：可选 all（全部图片列表）、part（仅开始游戏时按后续模式）、none（仅文字），或具体开始模式 list/text_image/image/text'),
    steamDisableBroadcastOnStartup: Schema.boolean().default(false).description('启动时禁用首次播报（仅预热缓存）'),
    enableIpCheck: Schema.boolean().default(false).description('启用IP检测：Steam API连接失败时，检测本机外网IP（前两段，后两段隐藏为*）'),
    fonts: Schema.object({
      regular: Schema.string().default('fonts/MiSans-Regular.ttf'),
      light: Schema.string().default('fonts/MiSans-Light.ttf'),
      bold: Schema.string().default('fonts/MiSans-Bold.ttf'),
    }).description('字体文件路径，相对于插件资源目录或绝对路径'),
    commandAuthority: Schema.object({
      bind: Schema.number().default(1).description('绑定命令所需权限'),
      unbind: Schema.number().default(1).description('解绑命令所需权限'),
      info: Schema.number().default(1).description('查看资料命令所需权限'),
      check: Schema.number().default(1).description('查看状态命令所需权限'),
      enable: Schema.number().default(2).description('启用播报命令所需权限'),
      disable: Schema.number().default(2).description('禁用播报命令所需权限'),
      update: Schema.number().default(2).description('更新群信息命令所需权限'),
      nickname: Schema.number().default(1).description('设置昵称命令所需权限'),
    }).description('命令权限配置'),
  }),
])

export const logger = new Logger('steam-info')

declare module 'koishi' {
  interface Context {
    steam: SteamService
    drawer: DrawService
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('zh', zhCN)

  ctx.plugin(SteamService, config)
  ctx.plugin(DrawService, config)
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
    id: 'string',
    enable: 'boolean',
    name: 'string',
    avatar: 'string',
    platform: 'string',
    assignee: 'string',
  }, {
    primary: 'id',
  })

  ctx.using(['steam', 'drawer'], (ctx) => {
    ctx.command('steam', 'Steam 信息')

    ctx.command('steam.bind <steamId:string>', '绑定 Steam ID', { authority: config.commandAuthority.bind })
      .alias('steambind', '绑定steam')
      .action(async ({ session }, steamId) => {
        if (!session) return

        // 如果未提供参数，返回该子命令的用法提示
        if (!steamId) return session.text('.usage')

        if (!/^[0-9]+$/.test(steamId)) return session.text('.invalid_id')

        const targetId = await ctx.steam.getSteamId(steamId)
        if (!targetId) return session.text('.id_not_found')

        const existing = await ctx.database.get('steam_bind', { userId: session.userId, channelId: session.channelId })
        if (existing.length) {
          return session.text('.already_bound')
        }

        await ctx.database.upsert('steam_bind', [
          {
            userId: session.userId,
            channelId: session.channelId,
            steamId: targetId,
          }
        ], ['userId', 'channelId'])

        return session.text('.bind_success', [targetId])
      })

    ctx.command('steam.unbind', '解绑 Steam ID', { authority: config.commandAuthority.unbind })
      .alias('steamunbind', '解绑steam')
      .action(async ({ session }) => {
        if (!session) return
        const result = await ctx.database.remove('steam_bind', {
          userId: session.userId,
          channelId: session.channelId,
        })
        return result ? session.text('.unbind_success') : session.text('.not_bound')
      })

    ctx.command('steam.info [target:text]', '查看 Steam 资料', { authority: config.commandAuthority.info })
      .alias('steaminfo', 'steam信息')
      .action(async ({ session }, target) => {
        if (!session) return
        try {
          let steamId: string | null = null

          if (target) {
            // 尝试解析@提及
            const parsed = h.parse(target)
            const atElement = parsed.find(el => el.type === 'at')
            if (atElement?.attrs?.id) {
              const bind = await ctx.database.get('steam_bind', { userId: atElement.attrs.id, channelId: session.channelId })
              if (bind.length) steamId = bind[0].steamId
            }

            // 如果未通过@找到，尝试解析为Steam ID
            if (!steamId && /^\d+$/.test(target)) {
              steamId = await ctx.steam.getSteamId(target)
            }
          } else {
            // 没有提供参数，使用当前用户的绑定账户
            const bind = await ctx.database.get('steam_bind', { userId: session.userId, channelId: session.channelId })
            if (bind.length) {
              steamId = bind[0].steamId
            }
          }

          if (!steamId) return session.text('.user_not_found')

          const profile = await ctx.steam.getUserData(steamId)
          const image = await ctx.drawer.drawPlayerStatus(profile, steamId)
          if (typeof image === 'string') return image
          return h.image(image, 'image/png')
        } catch (err) {
          logger.error(err)
          return session.text('.error')
        }
      })

    ctx.command('steam.check', '查看好友在线状态', { authority: config.commandAuthority.check })
      .alias('steamcheck', '查看steam', '查steam')
      .action(async ({ session }) => {
        if (!session) return
        try {
          const binds = await ctx.database.get('steam_bind', { channelId: session.channelId })
          if (binds.length === 0) return session.text('.no_binds')

          const steamIds = binds.map(b => b.steamId)
          const summaries = await ctx.steam.getPlayerSummaries(steamIds)

          if (summaries.length === 0) return session.text('.api_error')

          const channelInfo = await ensureChannelMeta(ctx, session)
          const parentAvatar = channelInfo.avatar
            ? Buffer.from(channelInfo.avatar, 'base64')
            : await ctx.drawer.getDefaultAvatar()
          const parentName = channelInfo.name || session.channelId || 'Unknown'

          const image = await ctx.drawer.drawFriendsStatus(parentAvatar, parentName, summaries, binds)
          if (typeof image === 'string') return image
          return h.image(image, 'image/png')
        } catch (err) {
          logger.error(err)
          return session.text('.error')
        }
      })

    ctx.command('steam.enable', '启用播报', { authority: config.commandAuthority.enable })
      .alias('steamenable', '启用steam')
      .action(async ({ session }) => {
        if (!session) return
        await ctx.database.upsert('steam_channel', [{
          id: session.channelId,
          enable: true,
          platform: session.platform,
          assignee: session.selfId,
        }])
        return session.text('.enable_success')
      })

    ctx.command('steam.disable', '禁用播报', { authority: config.commandAuthority.disable })
      .alias('steamdisable', '禁用steam')
      .action(async ({ session }) => {
        if (!session) return
        await ctx.database.upsert('steam_channel', [{
          id: session.channelId,
          enable: false,
          platform: session.platform,
          assignee: session.selfId,
        }])
        return session.text('.disable_success')
      })

    ctx.command('steam.update [name:string] [avatar:image]', '更新群信息', { authority: config.commandAuthority.update })
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

        if (!name && !avatarBase64) return session.text('.usage')

        const update: any = { id: session.channelId, platform: session.platform, assignee: session.selfId }
        if (name) update.name = name
        if (avatarBase64) update.avatar = avatarBase64

        await ctx.database.upsert('steam_channel', [update])
        return session.text('.update_success')
      })

    ctx.command('steam.nickname <nickname:string>', '设置 Steam 昵称', { authority: config.commandAuthority.nickname })
      .alias('steamnickname', 'steam昵称')
      .action(async ({ session }, nickname) => {
        if (!session) return
        if (!nickname) return session.text('.usage')
        const bind = await ctx.database.get('steam_bind', { userId: session.userId, channelId: session.channelId })
        if (!bind.length) return session.text('.not_bound')

        await ctx.database.upsert('steam_bind', [{ ...bind[0], nickname }])
        return session.text('.nickname_set', [nickname])
      })

    let skipFirstBroadcast = config.steamDisableBroadcastOnStartup
    const timer = ctx.setInterval(async () => {
      if (skipFirstBroadcast) {
        await seedStatusCache(ctx)
        skipFirstBroadcast = false
        return
      }
      await broadcast(ctx, config)
    }, config.steamRequestInterval * 1000)

    ctx.on('dispose', () => {
      try { clearInterval(timer as unknown as NodeJS.Timeout) } catch { }
    })
  })
}

// 播报状态缓存
const statusCache = new Map<string, any>()
// 玩家游戏状态元数据，用于判断短时间内重新开始同一游戏是否需要播报
const playMeta = new Map<string, { lastLeftAt?: number, lastLeftGame?: string }>()
// 上次见到玩家的时间戳
const lastSeenAt = new Map<string, number>()
// 缓存过期时间（7天）
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000

async function ensureChannelMeta(ctx: Context, session: Session) {
  const channelId = session.channelId
  const existing = await ctx.database.get('steam_channel', { id: channelId })
  const current = existing[0] || { id: channelId, enable: true, platform: session.platform, assignee: session.selfId }

  let name = current.name
  if (!name && session.event?.channel?.name) {
    name = session.event.channel.name
  }
  // OneBot 群名获取
  if (!name && session.platform?.includes('onebot') && session.bot?.internal?.getGroupInfo) {
    const tryGetGroupName = async (arg: any): Promise<string | null> => {
      try {
        const info = await session.bot.internal.getGroupInfo(arg)
        if (!info) return null
        return (info as any).group_name
          || (info as any).data?.group_name
          || (info as any).data?.group?.group_name
          || (info as any).ret?.data?.group_name
          || null
      } catch {
        return null
      }
    }

    const argVariants = [
      channelId,
      Number(channelId),
      { group_id: channelId },
      { group_id: Number(channelId) },
    ]

    for (const arg of argVariants) {
      const result = await tryGetGroupName(arg)
      if (result) {
        name = result
        break
      }
    }
  }

  let avatar = current.avatar
  if (!avatar) {
    try {
      const url = `https://p.qlogo.cn/gh/${channelId}/${channelId}/0`
      const buffer = await ctx.http.get(url, { responseType: 'arraybuffer' })
      avatar = Buffer.from(buffer).toString('base64')
    } catch {
      // 使用默认头像
    }
  }

  const update: any = { id: channelId, platform: session.platform, assignee: session.selfId }
  if (name) update.name = name
  if (avatar) update.avatar = avatar
  await ctx.database.upsert('steam_channel', [update])

  return { ...current, ...update }
}

async function seedStatusCache(ctx: Context) {
  const binds = await ctx.database.get('steam_bind', {})
  if (!binds.length) return
  const steamIds = [...new Set(binds.map(b => b.steamId))]
  const summaries = await ctx.steam.getPlayerSummaries(steamIds)
  for (const player of summaries) {
    statusCache.set(player.steamid, player)
    lastSeenAt.set(player.steamid, Date.now())
  }
}

async function broadcast(ctx: Context, config: Config) {
  try {
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
      const startGamingPlayers: (PlayerSummary & { nickname?: string })[] = []

      const now = Date.now()
      for (const bind of channelBinds) {
        const current = currentMap.get(bind.steamId)
        const old = statusCache.get(bind.steamId)
        if (!current || !old) continue

        const oldGame = old.gameextrainfo || null
        const newGame = current.gameextrainfo || null
        const name = bind.nickname || current.personaname

        let displayGameName = newGame
        if (newGame && current.gameid) {
          const localized = await ctx.steam.getLocalizedGameName(current.gameid)
          if (localized) displayGameName = localized
        }

        const meta = playMeta.get(bind.steamId) || {}

        if (newGame && !oldGame) {
          // 开始玩游戏（短时间内重新开始同一游戏不播报）
          const isResume = meta.lastLeftAt && meta.lastLeftGame === newGame && (now - meta.lastLeftAt) < 10 * 60 * 1000
          if (!isResume) {
            msgs.push(`${name} 开始玩 ${displayGameName} 了`)
            startGamingPlayers.push({ ...current, nickname: bind.nickname, gameextrainfo: displayGameName as string })
          }
          meta.lastLeftAt = undefined
          meta.lastLeftGame = undefined
          playMeta.set(bind.steamId, meta)
        } else if (newGame && oldGame && newGame !== oldGame) {
          // 切换游戏
          msgs.push(`${name} 开始玩 ${displayGameName} 了`)
          startGamingPlayers.push({ ...current, nickname: bind.nickname, gameextrainfo: displayGameName as string })
          meta.lastLeftAt = undefined
          meta.lastLeftGame = undefined
          playMeta.set(bind.steamId, meta)
        } else if (!newGame && oldGame) {
          // 停止游戏
          meta.lastLeftAt = now
          meta.lastLeftGame = oldGame
          playMeta.set(bind.steamId, meta)
        }
      }

      if (msgs.length === 0) continue

      const botKey = channel.platform && channel.assignee ? `${channel.platform}:${channel.assignee}` : undefined
      const bot = botKey ? ctx.bots[botKey] : Object.values(ctx.bots)[0]
      if (!bot) continue

      await sendBroadcast(ctx, config, bot, channel, msgs, startGamingPlayers, channelBinds, currentMap)
    }

    // 更新缓存
    const now = Date.now()
    for (const p of currentSummaries) {
      statusCache.set(p.steamid, p)
      lastSeenAt.set(p.steamid, now)
    }
    // 清理过期缓存
    for (const [id, ts] of lastSeenAt.entries()) {
      if (now - ts > STALE_TTL_MS) {
        lastSeenAt.delete(id)
        statusCache.delete(id)
        playMeta.delete(id)
      }
    }
  } catch (err) {
    logger.error('broadcast error: ' + String(err))
  }
}

/** 发送播报消息 */
async function sendBroadcast(
  ctx: Context, config: Config, bot: any, channel: SteamChannel,
  msgs: string[], startGamingPlayers: (PlayerSummary & { nickname?: string })[],
  channelBinds: SteamBind[], currentMap: Map<string, PlayerSummary>,
) {
  const configured = config.startBroadcastType || 'text_image'
  let broadcastType: string
  let startMode: string
  if (['all', 'part', 'none'].includes(configured)) {
    broadcastType = configured
    startMode = 'text_image'
  } else {
    broadcastType = 'part'
    startMode = configured
  }

  const sendListImage = async (withText: boolean) => {
    try {
      const channelPlayers = channelBinds.map(b => currentMap.get(b.steamId)).filter(Boolean) as PlayerSummary[]
      const parentAvatar = channel.avatar ? Buffer.from(channel.avatar, 'base64') : await ctx.drawer.getDefaultAvatar()
      const image = await ctx.drawer.drawFriendsStatus(parentAvatar, channel.name || channel.id, channelPlayers, channelBinds)
      if (image) {
        const img = typeof image === 'string' ? image : h.image(image, 'image/png')
        await bot.sendMessage(channel.id, withText ? msgs.join('\n') + img : img)
        return
      }
    } catch (e) {
      logger.error('broadcast draw list failed: ' + String(e))
    }
    if (withText) await bot.sendMessage(channel.id, msgs.join('\n'))
  }

  const sendPlayerImages = async () => {
    for (const p of startGamingPlayers) {
      try {
        const imgBuf = await ctx.drawer.drawStartGaming(p, p.nickname)
        if (imgBuf) {
          const img = typeof imgBuf === 'string' ? imgBuf : h.image(imgBuf, 'image/png')
          await bot.sendMessage(channel.id, img)
        }
      } catch (e) {
        logger.error('broadcast drawStartGaming failed: ' + String(e))
      }
      await new Promise(res => setTimeout(res, Math.floor(Math.random() * 6000) + 4000))
    }
  }

  if (broadcastType === 'none') {
    await bot.sendMessage(channel.id, msgs.join('\n'))
  } else if (broadcastType === 'all') {
    await sendListImage(true)
  } else if (startGamingPlayers.length > 0) {
    switch (startMode) {
      case 'list':
        await sendListImage(true)
        break
      case 'text_image':
        await bot.sendMessage(channel.id, msgs.join('\n'))
        await sendPlayerImages()
        break
      case 'image':
        await sendPlayerImages()
        break
      default:
        await bot.sendMessage(channel.id, msgs.join('\n'))
    }
  } else {
    await bot.sendMessage(channel.id, msgs.join('\n'))
  }
}
