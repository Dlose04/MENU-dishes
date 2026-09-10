/**
 * 同步写回时**照片会不会被清空** —— 这次特地跑在 IndexedDB 那条路上。
 *
 * 起因：用户 2026-09-10 报「本机照片没被删，但每台设备只要经历过一次同步，
 * 菜品就变成同步后那种不带照片的格式了」。这是一条丢数据的报告，不能靠读代码
 * 下结论。
 *
 * 原先只有 `sync-store.test.mjs` 覆盖了这件事，而它**跑的是 localStorage 降级路** ——
 * Node 里没有 IndexedDB，真机上所有浏览器走的却都是 IndexedDB。两条路的落库格式
 * 完全不同（降级路存 dataURL 字符串，真机路存 ArrayBuffer），所以在降级路上绿
 * 证明不了真机上绿。这个文件就是来补这个缺口的：同一件事，在真机那条路上再钉一遍。
 *
 * 顺带钉住 IndexedDB 的一条关键语义（`_fake-idb.mjs` 如实照抄了）：
 * **`put` 是整条替换，不是字段合并**。写回一条不带图片的记录，就是把照片抹掉。
 *
 * 注意：用例按顺序共享同一个 store（driver 是模块级单例，一个进程只能初始化一次）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubLocalStorage, stubBrowserApis } from './_bundle.mjs'
import { makeFakeIndexedDB } from './_fake-idb.mjs'

stubBrowserApis()
stubLocalStorage()
const fake = makeFakeIndexedDB()

const store = await load(src('store/appStore.ts'))
const { converge } = await load(src('sync/converge.ts'))
const { toSyncPayload } = await load(src('sync/merge.ts'))

/** 落库的原始记录（含墓碑），等于「关掉应用再打开时会读到的东西」。 */
const rawRows = () => [...fake.data.get('recipes').values()]
const rawById = (id) => rawRows().find((r) => r.id === id)

/** 云端回来的形状：同一道菜，但**没有图片**（同步数据里本来就不带图）。 */
function fromCloud(recipe, { name, updatedAt, deletedAt } = {}) {
  return {
    id: recipe.id,
    name: name ?? recipe.name,
    category: recipe.category,
    ingredients: [...recipe.ingredients],
    difficulty: recipe.difficulty,
    emoji: recipe.emoji,
    createdAt: recipe.createdAt,
    updatedAt,
    ...(deletedAt === undefined ? {} : { deletedAt }),
  }
}

test('这次测试跑的确实是 IndexedDB 那条路，且预置菜的照片以 ArrayBuffer 落库', async () => {
  await store.initStore()

  // 这条是**前提**，不是装饰：模式要是降级成了 localStorage，下面所有用例
  // 就退化成 sync-store.test.mjs 的重复，真机那条路依然没人测。
  assert.equal(store.getState().mode, 'indexeddb', '假 IDB 没被用上，测的就不是真机那条路了')

  const rows = rawRows()
  assert.equal(rows.length, 9, '首次启动应该播下 9 道预置菜')
  assert.ok(
    rows.every((r) => r.imageBuffer instanceof ArrayBuffer),
    '预置菜的照片没有以 ArrayBuffer 落库',
  )
  assert.ok(
    rows.every((r) => r.imageBlob === undefined),
    'Blob 不该直接进 IDB —— iOS/WKWebView 上不可靠',
  )
})

test('云端版本更新时，写回合并结果不会清空本地照片（真机那条路）', async () => {
  const local = store.getState().recipes
  assert.equal(local.length, 9)
  assert.ok(
    local.every((r) => r.imageBlob instanceof Blob),
    '前提：本地这些菜本来都有照片',
  )

  // 云端那份全部压过本地（时间戳更新），而且**一个图片字段都没有** ——
  // 这正是每次同步都会发生的事：另一台设备改过名字/用料，推上来的是无图版本。
  const future = Date.now() + 100_000
  await store.applySyncPayload({
    recipes: local.map((r, i) => fromCloud(r, { name: `${r.name}（改过）`, updatedAt: future + i })),
    menus: [],
  })

  const after = store.getState().recipes
  assert.equal(after.length, 9)
  for (const r of after) {
    assert.match(r.name, /（改过）$/, `「${r.name}」云端的新版本没写进来，后面的断言就没意义了`)
    assert.ok(r.imageBlob instanceof Blob, `「${r.name}」的照片被合并结果冲掉了`)
    assert.ok(r.imageBlob.size > 10_000, `「${r.name}」的照片成了个空壳`)
  }

  // UI 上有图、库里没了同样致命：下次启动读到的是库里那份，图还是丢。
  assert.ok(
    rawRows().every((r) => r.imageBuffer instanceof ArrayBuffer),
    '落库的记录里照片没了 —— 用户下次打开应用才会发现，而那时已经找不到原因',
  )
})

test('走一整轮 converge（真机形状）：拉取 → 合并 → 写回，照片依然在', async () => {
  const local = store.getState().recipes
  assert.ok(local.length >= 2, '前提：库里得有菜')

  // 服务端上那份是另一台设备推的：大部分菜都在、都改过名字、都没有图、
  // 时间戳更新；**最后一道那边还没有**（它是在那台设备上次推送之后才记的）。
  // 于是合并结果既不同于本地也不同于服务端，这一轮必然会真的推一次。
  const future = Date.now() + 200_000
  const serverPayload = {
    recipes: local
      .slice(0, -1)
      .map((r, i) => fromCloud(r, { name: `${r.name}（云端）`, updatedAt: future + i })),
    menus: [],
  }

  let pushed = null
  const transport = {
    async pull() {
      return { rev: 7, payload: serverPayload }
    },
    async push(baseRev, payload) {
      pushed = { baseRev, payload }
      return { ok: true, rev: baseRev + 1 }
    },
  }

  const result = await converge({
    transport,
    readLocal: async () => {
      const { recipes, menus } = await store.readAllRecords()
      return toSyncPayload(recipes, menus)
    },
    writeLocal: (payload) => store.applySyncPayload(payload),
  })

  assert.equal(result.pushed, true, '应该推了一轮上去')
  assert.ok(pushed, '没走到 push')

  // 推上去的本来就不该带图（同步不搬图片），但**本地必须还留着**
  assert.ok(
    pushed.payload.recipes.every((r) => r.imageBlob === undefined),
    '推给云端的记录里混进了图片，白白占带宽',
  )
  for (const r of store.getState().recipes) {
    assert.ok(r.imageBlob instanceof Blob, `跑完一整轮同步，「${r.name}」的照片没了`)
  }
  assert.ok(
    rawRows().every((r) => r.imageBuffer instanceof ArrayBuffer),
    '跑完一整轮同步，落库的记录里照片没了',
  )
})

test('别的设备删掉的菜变成墓碑时，才该释放照片（这是唯一该丢图的情况）', async () => {
  const target = store.getState().recipes[0]
  assert.ok(rawById(target.id).imageBuffer, '前提：这道菜本来有照片')

  await store.applySyncPayload({
    recipes: [fromCloud(target, { updatedAt: Date.now() + 300_000, deletedAt: Date.now() + 300_000 })],
    menus: [],
  })

  assert.ok(rawById(target.id).deletedAt, '墓碑没写进去')
  assert.equal(rawById(target.id).imageBuffer, undefined, '墓碑不该继续占着照片的空间')
  assert.equal(
    store.getState().recipes.some((r) => r.id === target.id),
    false,
    '墓碑漏进 UI 了 —— 用户会觉得删掉的菜又活了',
  )
})

test('别的设备新增的菜在本地没有图，但不会连累本地那几道菜', async () => {
  const before = store.getState().recipes
  assert.ok(before.length > 0)

  await store.applySyncPayload({
    recipes: [
      // 另一台设备新记的菜：本地没有它的照片，也不该有（同步不搬图）
      {
        id: 'from-other-device',
        name: '平板记的新菜',
        category: '家常热菜',
        ingredients: ['盐'],
        difficulty: '简单',
        emoji: '🍲',
        createdAt: Date.now(),
        updatedAt: Date.now() + 400_000,
      },
    ],
    menus: [],
  })

  const after = store.getState().recipes
  assert.equal(after.length, before.length + 1, '新菜没进来')
  assert.equal(
    after.find((r) => r.id === 'from-other-device').imageBlob,
    undefined,
    '本地凭空多出个照片',
  )
  for (const r of after) {
    if (r.id === 'from-other-device') continue
    assert.ok(r.imageBlob instanceof Blob, `「${r.name}」的照片被别的设备的新菜连累了`)
  }
})
