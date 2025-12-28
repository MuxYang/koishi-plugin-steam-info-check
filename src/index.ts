import { Context, Schema, Logger, Service, Session, h } from 'koishi'
import { SteamService } from './service'
import { DrawService } from './drawer'
import { SteamBind, SteamChannel } from './database'
import zhCN from './locales/zh-CN'

export const name = 'steam-info'
export const inject = ['model', 'http', 'puppeteer', 'database']

export interface Config {
  steamApiKey: string[]
  proxy?: string
  steamRequestInterval: number
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
  steamApiKey: Schema.array(String).required().description('Steam API Key（支持多个）'),
  proxy: Schema.string().description('代理地址，例如 http://127.0.0.1:7890'),
  steamRequestInterval: Schema.number().default(300).description('轮询间隔（秒）'),
  startBroadcastType: Schema.union(['all','part','none','list','text_image','image','text']).default('text_image').description('播报方式：可选 all（全部图片列表）、part（仅开始游戏时按后续模式）、none（仅文字），或具体开始模式 list/text_image/image/text'),
  steamDisableBroadcastOnStartup: Schema.boolean().default(false).description('启动时禁用首次播报（仅预热缓存）'),
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
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('zh', zhCN)

  // Services
  ctx.plugin(SteamService, config)
  ctx.plugin(DrawService, config)

  // 日志转发与管理员配置已移除：不再在运行时注入相关逻辑。

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
    platform: 'string',
    assignee: 'string',
  }, {
    primary: 'id',
  })

  // Commands and scheduler depend on steam/drawer being ready
  ctx.using(['steam', 'drawer'], (ctx) => {
    ctx.command('steam', 'Steam 信息')

    ctx.command('steam.bind <steamId:string>', '绑定 Steam ID', { authority: config.commandAuthority.bind })
      .alias('steambind', '绑定steam')
      .action(async ({ session }, steamId) => {
        if (!session) return

        // 如果未提供参数，返回当前已绑定的 Steam ID（若有）
        if (!steamId) {
          try {
            const bind = await ctx.database.get('steam_bind', { userId: session.userId, channelId: session.channelId })
            if (bind.length) return session.text('.current_bound', [bind[0].steamId])
            return session.text('.not_bound')
          } catch (e) {
            logger.error('查询当前绑定失败：' + String(e) + ' EEE')
            return session.text('.error')
          }
        }

        if (!/^[0-9]+$/.test(steamId)) return session.text('.invalid_id')

        const targetId = await ctx.steam.getSteamId(steamId)
        if (!targetId) return session.text('.id_not_found')

        // 检查是否已绑定
        try {
          const existing = await ctx.database.get('steam_bind', { userId: session.userId, channelId: session.channelId })
          if (existing.length) {
            return session.text('.already_bound')
          }
        } catch (e) {
          logger.error('检查已绑定状态失败：' + String(e) + ' EEE')
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
            try {
              const [, userId] = session.resolve(target)
              if (userId) {
                const bind = await ctx.database.get('steam_bind', { userId, channelId: session.channelId })
                if (bind.length) steamId = bind[0].steamId
              }
            } catch {
              /* ignore resolve errors */
            }

            if (!steamId && /^\d+$/.test(target)) {
              steamId = await ctx.steam.getSteamId(target)
            }
          } else {
            const bind = await ctx.database.get('steam_bind', { userId: session.userId, channelId: session.channelId })
            if (bind.length) steamId = bind[0].steamId
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

          if (!name && !avatarBase64) return session.text('.args_missing')

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
        const bind = await ctx.database.get('steam_bind', { userId: session.userId, channelId: session.channelId })
        if (!bind.length) return session.text('.not_bound')
        
        await ctx.database.upsert('steam_bind', [{ ...bind[0], nickname }])
        return session.text('.nickname_set', [nickname])
      })

      // (已移除) 调试命令 steam.whoami 已删除以避免缺失的 i18n 警告

    // Scheduler
    let skipFirstBroadcast = config.steamDisableBroadcastOnStartup
    ctx.setInterval(async () => {
      if (skipFirstBroadcast) {
        await seedStatusCache(ctx)
        skipFirstBroadcast = false
        return
      }
      await broadcast(ctx, config)
    }, config.steamRequestInterval * 1000)
  })
}

// Broadcast Logic
const statusCache = new Map<string, any>()

async function ensureChannelMeta(ctx: Context, session: Session) {
  const channelId = session.channelId
  const existing = await ctx.database.get('steam_channel', { id: channelId })
  const current = existing[0] || { id: channelId, enable: true, platform: session.platform, assignee: session.selfId }

  let name = current.name
  if (!name && session.event?.channel?.name) {
    name = session.event.channel.name
  }
  // OneBot 群名补充
  if (!name && session.platform?.includes('onebot') && session.bot?.internal?.getGroupInfo) {
    // 先尝试原始（primitive）参数，许多 adapter/napcat 期望直接的字符串或数字
    const primitiveVariants = [channelId, Number(channelId)]
    for (const arg of primitiveVariants) {
      try {
        logger.error(`getGroupInfo 尝试 args=${JSON.stringify(arg)}`)
        const info = await session.bot.internal.getGroupInfo(arg as any)
        logger.error(`getGroupInfo 返回: ${JSON.stringify(info)}`)
        if (info) {
          if ((info as any).group_name) { name = (info as any).group_name; break }
          if ((info as any).data && (info as any).data.group_name) { name = (info as any).data.group_name; break }
          if ((info as any).data && (info as any).data.group && (info as any).data.group.group_name) { name = (info as any).data.group.group_name; break }
          if ((info as any).ret && (info as any).ret.data && (info as any).ret.data.group_name) { name = (info as any).ret.data.group_name; break }
        }
      } catch (err) {
        logger.error('getGroupInfo 原始参数调用失败，arg=' + JSON.stringify(arg) + '，错误：' + String(err) + ' EEE')
        if (err && (err as any).message) {
          logger.error('getGroupInfo 原始错误信息: ' + String((err as any).message))
        }
      }
    }

    // 如果 primitive 未成功，再尝试对象参数包裹形式
    if (!name) {
      const argVariants = [
        { group_id: channelId },
        { group_id: { group_id: channelId } },
        { group_id: Number(channelId) },
        { group_id: { group_id: Number(channelId) } },
      ]
      for (const args of argVariants) {
        try {
          logger.error(`getGroupInfo 尝试 args=${JSON.stringify(args)}`)
          const info = await session.bot.internal.getGroupInfo(args)
          logger.error(`getGroupInfo 返回: ${JSON.stringify(info)}`)

          if (!info) continue

          if ((info as any).group_name) { name = (info as any).group_name; break }
          if ((info as any).data && (info as any).data.group_name) { name = (info as any).data.group_name; break }
          if ((info as any).data && (info as any).data.group && (info as any).data.group.group_name) { name = (info as any).data.group.group_name; break }
          if ((info as any).ret && (info as any).ret.data && (info as any).ret.data.group_name) { name = (info as any).ret.data.group_name; break }

          logger.error('getGroupInfo 返回了未识别结构（尝试 参数：' + JSON.stringify(args) + '）: ' + JSON.stringify(info) + ' EEE')
        } catch (err) {
          try {
            logger.error('getGroupInfo 调用失败，args=' + JSON.stringify(args) + '，错误：' + String(err) + ' EEE')
            if (err && (err as any).message) {
              logger.error('getGroupInfo 原始错误信息: ' + String((err as any).message))
            }
          } catch (e) {
            logger.error('getGroupInfo 调用失败但记录 args 时出错：' + String(e) + ' EEE')
          }
        }
      }
    }

    // 所有尝试失败，记录最终失败并使用回退值
    if (!name) {
      logger.error('getGroupInfo 所有尝试均失败，使用回退群名: ' + channelId + ' EEE')
      name = channelId
    }
  }

  let avatar = current.avatar
  if (!avatar) {
    try {
      // For QQ group avatars
      const url = `http://p.qlogo.cn/gh/${channelId}/${channelId}/0`
      const buffer = await ctx.http.get(url, { responseType: 'arraybuffer' })
      avatar = Buffer.from(buffer).toString('base64')
    } catch {
      // fallback later to default avatar
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
  logger.error(`seedStatusCache: load binds count=${binds.length}`)
  if (!binds.length) return
  const steamIds = [...new Set(binds.map(b => b.steamId))]
  const summaries = await ctx.steam.getPlayerSummaries(steamIds)
  logger.error(`seedStatusCache: fetched summaries=${summaries.length}`)
  for (const player of summaries) {
    statusCache.set(player.steamid, player)
  }
}

async function broadcast(ctx: Context, config: Config) {
  try {
    const channels = await ctx.database.get('steam_channel', { enable: true })
    logger.error(`broadcast: enabled channels=${channels.length}`)
  if (channels.length === 0) return

    const channelIds = channels.map(c => c.id)
  const binds = await ctx.database.get('steam_bind', { channelId: channelIds })
    logger.error(`broadcast: binds total=${binds.length}`)
  if (binds.length === 0) return

  const steamIds = [...new Set(binds.map(b => b.steamId))]
    logger.error(`broadcast: unique steamIds=${steamIds.length}`)

    const currentSummaries = await ctx.steam.getPlayerSummaries(steamIds)
    logger.error(`broadcast: fetched summaries=${currentSummaries.length}`)
  const currentMap = new Map(currentSummaries.map(p => [p.steamid, p]))

  for (const channel of channels) {
      logger.error(`broadcast: channel=${channel.id} processing`)
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

      // 只在玩家开始游戏或从一个游戏切换到另一个游戏时推送
      if (newGame && !oldGame) {
        msgs.push(`${name} 开始玩 ${newGame} 了`)
        startGamingPlayers.push({ ...current, nickname: bind.nickname })
      } else if (newGame && oldGame && newGame !== oldGame) {
        // 游戏切换视同开始：不要发停止/开始的文字，改为把玩家加入开始列表，后面按图片发送
        startGamingPlayers.push({ ...current, nickname: bind.nickname })
      }
    }

    if (msgs.length > 0) {
      logger.error(`broadcast: channel=${channel.id} msgs=${msgs.length}`)
      const botKey = channel.platform && channel.assignee ? `${channel.platform}:${channel.assignee}` : undefined
      const bot = botKey ? ctx.bots[botKey] : Object.values(ctx.bots)[0]
      if (!bot) continue

      // 统一使用 startBroadcastType：支持 all/part/none 或具体开始模式（list/text_image/image/text）
      const configured = (config as any).startBroadcastType || 'text_image'
      let broadcastType: string
      let startMode: string
      if (['all', 'part', 'none'].includes(configured)) {
        broadcastType = configured
        startMode = 'text_image'
      } else {
        broadcastType = 'part'
        startMode = configured
      }

      // 如果为 none，始终仅文字
      if (broadcastType === 'none') {
        await bot.sendMessage(channel.id, msgs.join('\n'))
      } else if (broadcastType === 'all') {
        // all：优先展示整个频道的状态图（同 steam.check），若失败则回退文字
        try {
          const channelPlayers = channelBinds.map(b => currentMap.get(b.steamId)).filter(Boolean) as any[]
          const parentAvatar = channel.avatar ? Buffer.from(channel.avatar, 'base64') : await ctx.drawer.getDefaultAvatar()
          const image = await ctx.drawer.drawFriendsStatus(parentAvatar, channel.name || channel.id, channelPlayers, channelBinds)
          if (image) {
            const img = typeof image === 'string' ? image : h.image(image, 'image/png')
            await bot.sendMessage(channel.id, msgs.join('\n') + img)
          } else {
            await bot.sendMessage(channel.id, msgs.join('\n'))
          }
        } catch (e) {
          logger.error('broadcast draw full list failed: ' + String(e) + ' EEE')
          await bot.sendMessage(channel.id, msgs.join('\n'))
        }
      } else {
        // part：仅在有开始游戏的玩家时按 startBroadcastType 决定格式，否则仅文字
        if (startGamingPlayers.length > 0) {
          if (startMode === 'list') {
            const channelPlayers = channelBinds.map(b => currentMap.get(b.steamId)).filter(Boolean) as any[]
            const parentAvatar = channel.avatar ? Buffer.from(channel.avatar, 'base64') : await ctx.drawer.getDefaultAvatar()
            const image = await ctx.drawer.drawFriendsStatus(parentAvatar, channel.name || channel.id, channelPlayers, channelBinds)
            if (image) {
              const img = typeof image === 'string' ? image : h.image(image, 'image/png')
              await bot.sendMessage(channel.id, msgs.join('\n') + img)
            } else {
              await bot.sendMessage(channel.id, msgs.join('\n'))
            }
          } else if (startMode === 'text_image') {
            // 先发送文字（如果有），然后逐个发送玩家图片，每张图片间隔 4-10s
            if (msgs.length > 0) await bot.sendMessage(channel.id, msgs.join('\n'))
            for (const p of startGamingPlayers) {
              try {
                const imgBuf = await ctx.drawer.drawStartGaming(p, p.nickname)
                const img = imgBuf ? (typeof imgBuf === 'string' ? imgBuf : h.image(imgBuf, 'image/png')) : ''
                if (img) await bot.sendMessage(channel.id, img)
              } catch (e) {
                logger.error('broadcast drawStartGaming failed: ' + String(e) + ' EEE')
              }
              // 随机延迟 4-10 秒
              const delay = Math.floor(Math.random() * (10000 - 4000 + 1)) + 4000
              await new Promise(res => setTimeout(res, delay))
            }
          } else if (startMode === 'image') {
            // 仅图片：逐个发送每位玩家的图片，图片间隔 4-10s
            for (const p of startGamingPlayers) {
              try {
                const imgBuf = await ctx.drawer.drawStartGaming(p, p.nickname)
                const img = imgBuf ? (typeof imgBuf === 'string' ? imgBuf : h.image(imgBuf, 'image/png')) : ''
                if (img) await bot.sendMessage(channel.id, img)
              } catch (e) {
                logger.error('broadcast drawStartGaming failed: ' + String(e) + ' EEE')
              }
              const delay = Math.floor(Math.random() * (10000 - 4000 + 1)) + 4000
              await new Promise(res => setTimeout(res, delay))
            }
          } else {
            // text
            await bot.sendMessage(channel.id, msgs.join('\n'))
          }
        } else {
          await bot.sendMessage(channel.id, msgs.join('\n'))
        }
      }
    }
  }

  // 广播完成后更新缓存
  for (const p of currentSummaries) {
    statusCache.set(p.steamid, p)
  }
} catch (err) {
  logger.error('broadcast 发生异常：' + String(err) + ' EEE')
}
}
