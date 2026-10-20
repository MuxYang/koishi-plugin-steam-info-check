export interface GameActivity {
  name: string
  isNonSteam: boolean
}

export function getSteamAppId(gameId: string | number | undefined): string | undefined {
  const value = String(gameId ?? '')
  if (!/^\d+$/.test(value)) return
  const id = BigInt(value)
  // CGameID stores a 24-bit AppID followed by the game type and mod/shortcut ID.
  if (id > 0n && id <= 0xffffffn) return id.toString()
}

export function getGameActivity(player: { gameextrainfo?: string; gameid?: string }): GameActivity | undefined {
  const name = player.gameextrainfo?.trim()
  if (!name) return
  const id = player.gameid
  const isNonSteam = !id || id === '0'
    || (/^\d+$/.test(id) && ((BigInt(id) >> 24n) & 0xffn) === 2n)
  return { name, isNonSteam }
}

export function getGameKey(player: { gameextrainfo?: string; gameid?: string }): string | undefined {
  const activity = getGameActivity(player)
  if (activity) return JSON.stringify([player.gameid || '', activity.name])
}
