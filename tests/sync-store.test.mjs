/**
 * appStore 接入同步之后的回归测试。
 *
 * 这里钉的是三件「错了也不会报错、只会静默丢数据」的事：
 *
 *   1. 删除留墓碑、但**用户看不到墓碑** —— 墓碑漏进 UI，表现是「删掉的菜
 *      自己又回来了」，而且各种计数都对不上。
 *   2. 撤销删除要打**更新的**时间戳 —— 不打的话，合并时打平、而打平是
 *      「墓碑赢」，撤销会被同步反向撤销掉，菜在下次同步后又没了。
 *   3. 合并结果写回时**必须把本地照片接回去** —— 同步数据里没有图片，
 *      直接覆盖会让用户的照片被无声清空，还因为有 emoji 兜底而不易察觉。
 *
 * 存储走 localStorage 降级那条路（Node 里没有 IndexedDB），
 * 正好也把备份格式的往返一起覆盖了。
 *
 * 注意：这些用例**按顺序共享同一个 store**（initStore 只能初始化一次，
 * 模块级 driver 只有一个），所以每一步都接着上一步的状态往下做。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubLocalStorage, stubBrowserApis } from './_bundle.mjs'

stubBrowserApis()
const ls = stubLocalStorage()

const IMG = 'data:image/png;base64,iVBORw0KGgo='

function fixture(id, extra = {}) {
  return {
    id,
    name: `菜-${id}`,
    category: '家常热菜',
    ingredients: ['盐'],
    difficulty: '简单',
    emoji: '🍲',
    createdAt: 1000,
    updatedAt: 1000,
    image: IMG,
    ...extra,
  }
}

// 预置数据 + 标记「已经播种过」，免得 initStore 又塞 9 道预置菜进来
ls.setItem('family-menu:seeded', '1')
ls.setItem('family-menu:recipes', JSON.stringify([fixture('r1'), fixture('r2')]))
ls.setItem('family-menu:menus', JSON.stringify([{ date: '2026-09-10', items: ['r1', 'r2'], updatedAt: 1000 }]))

const store = await load(src('store/appStore.ts'))
await store.initStore()

/** 直接看落库的原始记录（含墓碑），UI 状态是看不到墓碑的。 */
const rawRecords = () => JSON.parse(ls.getItem('family-menu:recipes'))
const rawMenus = () => JSON.parse(ls.getItem('family-menu:menus'))
const findRaw = (id) => rawRecords().find((r) => r.id === id)

test('启动时墓碑不会出现在 UI 状态里，但落库里留着', async () => {
  // 造一条墓碑，重新读一遍库（等价于用户重开应用）
  const records = rawRecords().map((r) => (r.id === 'r2' ? { ...r, deletedAt: 2000, updatedAt: 2000 } : r))
  ls.setItem('family-menu:recipes', JSON.stringify(records))
  await store.applySyncPayload({ recipes: records, menus: [] })

  const ids = store.getState().recipes.map((r) => r.id)
  assert.deepEqual(ids, ['r1'], '墓碑漏进 UI 了 —— 用户会觉得删掉的菜又活了')
  assert.ok(findRaw('r2').deletedAt, '落库的记录不该被清掉，否则删除传不到别的设备')
})

test('删除是软删除：库里留下墓碑，UI 里立刻消失，照片被剥掉', async () => {
  const before = findRaw('r1')
  assert.ok(before.image, '前提：r1 本来有照片')

  const payload = await store.deleteRecipes(['r1'])
  assert.ok(payload, '删除应该返回可撤销的数据')
  assert.ok(payload.recipes[0].imageBlob, '撤销用的原始数据里必须带着照片，否则撤销回不来图')

  assert.equal(store.getState().recipes.some((r) => r.id === 'r1'), false, 'UI 里没删掉')

  const tomb = findRaw('r1')
  assert.ok(tomb, '记录被物理删掉了 —— 别的设备下回同步会把这道菜加回来')
  assert.ok(tomb.deletedAt, '没有墓碑')
  assert.equal(tomb.image, undefined, '墓碑不该带着照片，那是白占空间')

  // 菜单里指向它的 id 也要摘掉，否则分享时漏菜
  assert.deepEqual(rawMenus()[0].items, ['r2'], '菜单里还留着已删菜谱的 id')
  assert.ok(rawMenus()[0].updatedAt > 1000, '菜单改了却没打时间戳，同步时这次改动会被顶掉')
})

test('撤销删除：菜和照片都回来，且时间戳比删除更新', async () => {
  const records = rawRecords()
  const tomb = records.find((r) => r.id === 'r1')
  const deletedAt = tomb.deletedAt

  // 用墓碑状态的数据去撤销（真实流程里 payload 是删除前的原始对象，这里从库里取）
  const { dataURLToBlob } = await load(src('lib/image.ts'))
  const restored = [{ ...tomb, imageBlob: dataURLToBlob(IMG) }]
  await store.restoreDeleted({ recipes: restored, menus: [] })

  assert.ok(store.getState().recipes.some((r) => r.id === 'r1'), '撤销之后 UI 里没有这道菜')

  const back = findRaw('r1')
  assert.equal(back.deletedAt, undefined, '墓碑没撤掉')
  assert.ok(back.updatedAt > deletedAt, '时间戳没往前走 —— 合并时打平会判「墓碑赢」，撤销会被同步反向撤销掉')
  assert.ok(back.image, '照片没回来')
})

// 云端的时间戳必须压过本地（撤销删除刚打过一个真实时钟的时间戳），
// 否则这条「新版本」根本赢不了，测的就不是写回了。
const FUTURE = Date.now() + 100_000

test('写回合并结果时，本地照片必须接回去（否则照片被无声清空）', async () => {
  const withImage = findRaw('r1')
  assert.ok(withImage.image, '前提：r1 本来有照片')

  // 云端回来的数据：改了名字，**没有图片字段**（同步数据里本来就不带图）
  await store.applySyncPayload({
    recipes: [{ id: 'r1', name: '改过名字的菜', category: '素菜', ingredients: [], difficulty: '简单', emoji: '🥬', createdAt: 1000, updatedAt: FUTURE }],
    menus: [],
  })

  const after = findRaw('r1')
  assert.equal(after.name, '改过名字的菜', '云端的新版本没写进来')
  assert.equal(after.image, IMG, '本地照片被合并结果冲掉了 —— 用户只会看到图没了，还未必知道是同步干的')
})

test('拉取到写回之间新加的菜不会被抹掉', async () => {
  // 一次同步是「读本地 → 网络 → 合并 → 写回」，中间隔着真实的网络时间。
  // 这份 payload 里没有 r3（它是这次同步开始之后才加的），
  // 整份覆盖的话 r3 会连同磁盘记录一起消失，而且一声不吭。
  const added = await store.createRecipe({ name: '刚加的新菜', category: '家常热菜', ingredients: [], difficulty: '简单', emoji: '🍲' })
  assert.ok(added, '新菜没建出来')

  const stale = { recipes: [{ id: 'r1', name: '改过名字的菜', category: '素菜', ingredients: [], difficulty: '简单', emoji: '🥬', createdAt: 1000, updatedAt: FUTURE }], menus: [] }
  await store.applySyncPayload(stale)

  assert.ok(store.getState().recipes.some((r) => r.name === '刚加的新菜'), '同步把用户刚记的菜抹掉了')
  assert.ok(findRaw(added.id), '磁盘上也没了 —— 用户的心血凭空消失')
})

test('写回时如果同步数据判了死刑，照片要一起释放', async () => {
  await store.applySyncPayload({
    recipes: [{ id: 'r1', name: '改过名字的菜', category: '素菜', ingredients: [], difficulty: '简单', emoji: '🥬', createdAt: 1000, updatedAt: FUTURE + 1000, deletedAt: FUTURE + 1000 }],
    menus: [],
  })

  const after = findRaw('r1')
  assert.ok(after.deletedAt, '墓碑没写进去')
  assert.equal(after.image, undefined, '墓碑还占着照片的空间')
  assert.equal(store.getState().recipes.some((r) => r.id === 'r1'), false, '墓碑漏进 UI 了')
})

test('清空所有数据也是留墓碑，不然别的设备下次同步会整库推回来', async () => {
  assert.ok(store.getState().recipes.length > 0, '前提：清空之前还有菜')

  await store.clearAllData()

  assert.deepEqual(store.getState().recipes, [], 'UI 里没清干净')
  const left = rawRecords()
  assert.ok(left.length > 0, '被物理清空了 —— 另一台设备下次同步会把整库推回来，用户以为「清空」坏了')
  assert.ok(left.every((r) => r.deletedAt), '留下的应该是墓碑，不是活着的记录')
  assert.ok(left.every((r) => r.image === undefined), '墓碑不该带照片')
  assert.deepEqual(rawMenus()[0].items, [], '菜单没清空')
})
