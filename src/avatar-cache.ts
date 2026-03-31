import * as fs from 'fs-extra'
import * as path from 'path'
import { Logger } from 'koishi'

const logger = new Logger('steam-info-avatar-cache')

/**
 * 下载并缓存头像到 avatars 目录，返回本地文件路径。
 * @param avatarUrl 头像图片的 URL
 * @param steamId 用户 SteamID
 * @returns 本地缓存文件路径
 */
export async function downloadAndCacheAvatar(avatarUrl: string, steamId: string): Promise<string> {
  if (!avatarUrl || !steamId) throw new Error('avatarUrl 和 steamId 必须提供')
  const ext = path.extname(avatarUrl.split('?')[0]) || '.jpg'
  const cacheDir = path.resolve(__dirname, '../avatars')
  const filePath = path.join(cacheDir, `${steamId}${ext}`)

  await fs.ensureDir(cacheDir)

  if (await fs.pathExists(filePath)) {
    logger.debug(`头像已缓存: ${filePath}`)
    return filePath
  }

  logger.info(`下载头像: ${avatarUrl} -> ${filePath}`)
  const res = await fetch(avatarUrl)
  if (!res.ok) throw new Error(`下载头像失败: HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(filePath, buffer)
  return filePath
}
