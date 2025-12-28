export interface SteamBind {
  id: number
  userId: string
  channelId: string
  steamId: string
  nickname?: string
}

export interface SteamChannel {
  id: string
  enable: boolean
  name?: string
  avatar?: string
}

declare module 'koishi' {
  interface Tables {
    steam_bind: SteamBind
    steam_channel: SteamChannel
  }
}