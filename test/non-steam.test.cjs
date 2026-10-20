const assert = require('node:assert/strict')
const { test } = require('node:test')
const { getGameActivity, getGameKey, getSteamAppId } = require('../dist/game-status')
const { SteamService } = require('../dist/service')
const { DrawService } = require('../dist/drawer')
const { apply } = require('../dist/index')

const shortcutId = ((0xdeadbeefn << 32n) | (2n << 24n)).toString()
const player = {
  steamid: '76561198000000001', personaname: 'Tester', profileurl: '',
  avatar: '', avatarmedium: '', avatarfull: '', personastate: 1,
}

test('recognizes shortcut IDs without rounding and accepts only store AppIDs', () => {
  assert.equal(getGameActivity({ gameextrainfo: 'FL Studio', gameid: shortcutId }).isNonSteam, true)
  assert.equal(getGameActivity({ gameextrainfo: 'FL Studio' }).isNonSteam, true)
  assert.equal(getGameActivity({ gameextrainfo: 'FL Studio', gameid: '0' }).isNonSteam, true)
  assert.equal(getGameActivity({ gameextrainfo: 'Dota 2', gameid: '570' }).isNonSteam, false)
  assert.equal(getGameActivity({ gameextrainfo: ' ' }), undefined)
  for (const id of [shortcutId, '0', '-1', 'abc', undefined, '16777216']) {
    assert.equal(getSteamAppId(id), undefined)
  }
  assert.equal(getSteamAppId('570'), '570')
  assert.notEqual(getGameKey({ gameextrainfo: 'Same', gameid: '570' }),
    getGameKey({ gameextrainfo: 'Same', gameid: shortcutId }))
})

test('non-Steam IDs never cause a store request', async () => {
  const steam = Object.create(SteamService.prototype)
  steam.gameNameCache = new Map()
  steam.config = { requestTimeout: 100 }
  let calls = 0
  steam.proxyGet = async () => { calls++; return { 570: { success: true, data: { name: '刀塔 2' } } } }
  assert.equal(await steam.getLocalizedGameName(shortcutId), '')
  assert.equal(calls, 0)
  assert.equal(await steam.getLocalizedGameName('570'), '刀塔 2')
  assert.equal(calls, 1)
})

test('profile parser reads English and Chinese non-Steam status independently of recent games', () => {
  const steam = Object.create(SteamService.prototype)
  for (const header of ['In non-Steam game', '正在玩非 Steam 游戏']) {
    const profile = steam.parseProfile(`<span class="actual_persona_name">Tester</span>
      <div class="profile_in_game"><div class="profile_in_game_header">${header}</div>
      <div class="profile_in_game_name">FL Studio &amp; Tools</div></div>`, player.steamid)
    assert.deepEqual(profile.current_game, { name: 'FL Studio & Tools', isNonSteam: true })
    assert.deepEqual(profile.game_data, [])
  }
  assert.equal(steam.parseProfile('<title>Offline</title>', player.steamid).current_game, undefined)
  assert.deepEqual(steam.parseProfile(`<div class="profile_in_game_header">In-Game</div>
    <div class="profile_in_game_name"><a>Dota 2</a></div>`, player.steamid).current_game,
  { name: 'Dota 2', isNonSteam: false })
})

function drawerForHtml() {
  const drawer = Object.create(DrawService.prototype)
  drawer.config = { replaceWallpaperEmoji: true }
  drawer.getFontCss = () => ''
  drawer.render = async html => html
  return drawer
}

test('cards label non-Steam games, escape custom names, and avoid duplicate offline entries', async () => {
  const drawer = drawerForHtml()
  const activity = { ...player, gameextrainfo: '<FL Studio>', gameid: shortcutId, personastate: 0 }
  const start = await drawer.drawStartGaming(activity)
  assert.match(start, /正在玩非 Steam 游戏/)
  assert.match(start, /&lt;FL Studio&gt;/)
  const friends = await drawer.drawFriendsStatus('', 'Group', [activity], [])
  assert.match(friends, /&lt;FL Studio&gt;（非 Steam 游戏）/)
  assert.doesNotMatch(friends, /离线 \(/)
  const nonSteamWallpaper = await drawer.drawStartGaming({ ...activity, gameextrainfo: 'Wallpaper Engine' })
  assert.doesNotMatch(nonSteamWallpaper, /正在🛫/)
  const wallpaper = await drawer.drawStartGaming({ ...player, gameextrainfo: 'Wallpaper Engine', gameid: '431960' })
  assert.match(wallpaper, /正在🛫/)
  const profile = await drawer.drawPlayerStatus({
    player_name: 'Tester', avatar: '', background: '', description: '', game_data: [],
    current_game: { name: '<FL Studio>', isNonSteam: true },
  }, player.steamid)
  assert.match(profile, /正在玩非 Steam 游戏/)
  assert.match(profile, /&lt;FL Studio&gt;/)
})

async function broadcastHarness(id, options = {}) {
  let tick
  let current = { ...player, steamid: id }
  const messages = [], storeIds = [], cards = []
  const channels = (options.channels || [id]).map(channelId => ({ id: channelId, enable: true }))
  const binds = channels.map(channel => ({ userId: 'user', channelId: channel.id, steamId: id }))
  const sentChannels = []
  const command = { alias: () => command, action: () => command }
  const ctx = {
    i18n: { define() {} }, plugin() {}, model: { extend() {} }, on() {},
    command: () => command, using: (_, callback) => callback(ctx),
    setInterval: callback => { tick = callback },
    database: { get: async table => table === 'steam_bind' ? binds : channels },
    steam: {
      getPlayerSummaries: async () => [{ ...current }],
      getLocalizedGameName: async id => { storeIds.push(id); return '本地化游戏' },
    },
    drawer: { drawStartGaming: async p => { cards.push(p); return 'card' } },
    bots: { test: { sendMessage: async (channel, message) => { sentChannels.push(channel); messages.push(message) } } },
  }
  apply(ctx, {
    commandAuthority: {}, steamRequestInterval: 300, startBroadcastType: 'text_image',
    steamDisableBroadcastOnStartup: true, enablePushDelay: false,
    ...options.config,
  })
  await tick()
  return {
    messages, storeIds, cards, sentChannels,
    update: async activity => { current = { ...player, steamid: id, ...activity }; await tick() },
  }
}

test('polling broadcasts non-Steam start, switch and resume without store requests or repeated messages', async () => {
  const harness = await broadcastHarness('76561198000000002')
  const fl = { gameextrainfo: 'FL Studio', gameid: shortcutId }
  await harness.update(fl)
  assert.match(harness.messages[0], /开始玩非 Steam 游戏 FL Studio 了/)
  assert.equal(harness.cards[0].gameextrainfo, 'FL Studio')
  await harness.update(fl)
  assert.equal(harness.messages.length, 2)
  await harness.update({ gameextrainfo: 'Another Tool' })
  assert.match(harness.messages[2], /Another Tool/)
  await harness.update({})
  await harness.update({ gameextrainfo: 'Another Tool' })
  assert.equal(harness.messages.length, 4, 'quick resume is suppressed')
  assert.deepEqual(harness.storeIds, [])
})

test('polling distinguishes same-name Steam and non-Steam games and retains Steam localization', async () => {
  const harness = await broadcastHarness('76561198000000003')
  await harness.update({ gameextrainfo: 'Same Name', gameid: '570' })
  assert.match(harness.messages[0], /开始玩 本地化游戏 了/)
  await harness.update({ gameextrainfo: 'Same Name', gameid: shortcutId })
  assert.match(harness.messages[2], /开始玩非 Steam 游戏 Same Name 了/)
  assert.deepEqual(harness.storeIds, ['570'])
})

test('same player returning every 20 minutes produces one broadcast across 14 cycles', async t => {
  let now = 1800000000000
  t.mock.method(Date, 'now', () => now)
  const harness = await broadcastHarness('76561198000000005')
  const game = { gameextrainfo: 'Bongo Cat', gameid: '3419430' }
  for (let i = 0; i < 14; i++) {
    await harness.update(game)
    now += 5 * 60 * 1000
    await harness.update({})
    now += 15 * 60 * 1000
  }
  assert.equal(harness.messages.length, 2, 'one text and one card, rather than 14 pairs')
  now += 60 * 60 * 1000
  await harness.update(game)
  assert.equal(harness.messages.length, 2, 'elapsed time does not clear the last broadcast game')
})

test('last broadcast game is independent for each channel and player', async t => {
  let now = 1800000000000
  t.mock.method(Date, 'now', () => now)
  const a = await broadcastHarness('76561198000000007', { channels: ['group-a', 'group-b'] })
  const b = await broadcastHarness('76561198000000008', { channels: ['group-a'] })
  const first = { gameextrainfo: 'First Game', gameid: '10' }
  await a.update(first)
  assert.deepEqual(a.sentChannels, ['group-a', 'group-a', 'group-b', 'group-b'])
  await b.update(first)
  assert.equal(b.messages.length, 2, 'another player may start the same game')
  now += 20 * 60 * 1000
  await a.update({ gameextrainfo: 'Second Game', gameid: '20' })
  assert.equal(a.messages.length, 8, 'another game is not affected')
  await a.update(first)
  assert.equal(a.messages.length, 12, 'broadcasting another game permits the original game again')
})

test('switching to a different game and back broadcasts all three starts', async t => {
  let now = 1800000000000
  t.mock.method(Date, 'now', () => now)
  const harness = await broadcastHarness('76561198000000009')
  const game = { gameextrainfo: 'Bongo Cat', gameid: '3419430' }
  await harness.update(game)
  await harness.update({})
  now += 20 * 60 * 1000
  await harness.update(game)
  assert.equal(harness.messages.length, 2)
  await harness.update({ gameextrainfo: 'Another Game', gameid: '570' })
  assert.equal(harness.messages.length, 4)
  await harness.update(game)
  assert.equal(harness.messages.length, 6)
})
