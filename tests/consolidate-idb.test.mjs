/**
 * 同名归并的端到端：**真机那条路**，库里的现场就是用户截图里的「全部 18」。
 *
 * 这里把用户 2026-09-10 报的那个状态原样造了出来：
 * - 9 条老记录，**随机 id**（预置菜 id 还是 `nanoid()` 那个年代的），带照片；
 * - 9 条新记录，id 是 `preset-<菜名>`，**没有照片**（刚从云端回来，同步不搬图）；
 * - 两批菜名一模一样 —— 按 id 去重两条都留下，于是 18 道菜、9 个名字。
 *
 * 为什么单开一个文件跑在假 IndexedDB 上：真机上所有浏览器走的都是 IndexedDB，
 * 照片在那条路上是以 **ArrayBuffer** 落库的（降级路存 dataURL 字符串）。
 * 归并最要紧的一件事恰恰是「照片有没有接到留下的那条身上」——
 * 在降级路上绿，证明不了真机上绿。所以第一条断言先钉死「这次跑的确实是
 * IndexedDB 那条路」，否则整个文件会悄悄退化成重复用例。
 *
 * 共享一个 store（driver 是模块级单例，一个进程只能初始化一次），用例按顺序来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubLocalStorage, stubBrowserApis } from './_bundle.mjs'
import { makeFakeIndexedDB } from './_fake-idb.mjs'

stubBrowserApis()
stubLocalStorage()
const fake = makeFakeIndexedDB()

const NAMES = [
  '番茄炒蛋',
  '酸辣土豆丝',
  '炒香干',
  '意祥一碗香',
  '红烧豆腐',
  '干锅包菜',
  '辣椒炒肉',
  '火腿炒蛋',
  '美味速食',
]

/** 直接往假库里塞记录，等于「用户上次关掉应用时库里就是这些」。 */
function seedRow(id, name, { createdAt, image = false }) {
  return {
    id,
    name,
    category: '家常热菜',
    ingredients: ['盐'],
    difficulty: '简单',
    emoji: '🍲',
    createdAt,
    updatedAt: createdAt,
    ...(image ? { imageBuffer: new Uint8Array([1, 2, 3, 4]).buffer, imageType: 'image/jpeg' } : {}),
  }
}

// —— 把「全部 18」摆好 ——
// 老记录在前（表小、带照片），新记录在后（表大、没照片）
const rows = new Map()
NAMES.forEach((name, i) => {
  rows.set(`Xk3pQ${i}`, seedRow(`Xk3pQ${i}`, name, { createdAt: 100 + i, image: true }))
  rows.set(`preset-${name}`, seedRow(`preset-${name}`, name, { createdAt: 900 + i }))
})
fake.data.set('recipes', rows)
// 那天的菜单里点的是老 id 那条 —— 归并之后这个引用得改指到留下的那条，
// 不然菜单里那道菜会变成「指向一条已经不存在的记录」，静默消失
fake.data.set('menus', new Map([['2026-09-10', { date: '2026-09-10', items: ['Xk3pQ0'], updatedAt: 500 }]]))

const store = await load(src('store/appStore.ts'))
await store.initStore()

/** 落库的原始记录（含墓碑），等于「关掉应用再打开时会读到的东西」。 */
const rawRows = () => [...fake.data.get('recipes').values()]

test('启动后重名的菜合成了 9 道，照片接到留下的那条身上（真机那条路）', () => {
  // 前提断言：模式要是降级成了 localStorage，下面这些就退化成别处已有的用例了
  assert.equal(store.getState().mode, 'indexeddb', '假 IDB 没被用上，测的就不是真机那条路了')

  const live = store.getState().recipes
  assert.equal(live.length, 9, `库里还留着 ${live.length} 道活着的菜 —— 用户看到的会是「全部 ${live.length}」`)

  assert.ok(
    live.every((r) => r.id.startsWith('preset-')),
    '留下的应该是 preset-<菜名> 那条（标准 id，收敛得干净）',
  )
  for (const r of live) {
    assert.ok(r.imageBlob instanceof Blob, `「${r.name}」的照片丢了 —— 归并时没从老记录身上接过来`)
  }

  // 照片不仅要能在界面上看见，还得真的落库：只改了内存的话，
  // 下次启动读到的还是没图的那条，用户第二次丢照片
  assert.ok(
    rawRows().filter((r) => !r.deletedAt).every((r) => r.imageBuffer instanceof ArrayBuffer),
    '落库的记录里照片没了',
  )
})

test('被合并掉的那 9 条留了墓碑，且下次同步推得出去', async () => {
  const graves = rawRows().filter((r) => r.deletedAt)
  assert.equal(graves.length, 9, '被合并掉的记录必须留墓碑 —— 真删掉的话，别的设备下回同步会把它推回来')
  assert.ok(
    graves.every((r) => r.imageBuffer === undefined),
    '墓碑还占着照片的空间',
  )

  // 墓碑得进得了同步那份数据，否则删除传不到别的设备，
  // 用户会看到「在这台手机上合掉了，同步完又变回 18 道」
  const { recipes } = await store.readAllRecords()
  assert.equal(
    recipes.filter((r) => r.deletedAt).length,
    9,
    '墓碑没进 readAllRecords —— 同步推的是这份数据，推不出去删除就传播不了',
  )
})

test('菜单里指向老 id 的引用改指到了留下的那条', () => {
  const menu = store.getState().menus.find((m) => m.date === '2026-09-10')
  assert.ok(menu, '那天的菜单不见了')
  assert.deepEqual(
    menu.items,
    ['preset-番茄炒蛋'],
    '菜单还指着被合并掉的旧 id —— 那天菜单里会少一道菜',
  )
})

test('同步时云端又把老记录带回来，写回时再合一次（不会变回 18）', async () => {
  // 云端那份还没清掉，而且另一台设备也在推它自己那批老 id 的记录
  await store.applySyncPayload({
    recipes: NAMES.map((name, i) => ({
      id: `别处来的${i}`,
      name,
      category: '家常热菜',
      ingredients: ['盐'],
      difficulty: '简单',
      emoji: '🍲',
      createdAt: 200 + i,
      updatedAt: 200 + i,
    })),
    menus: [],
  })

  const live = store.getState().recipes
  assert.equal(live.length, 9, `同步完变成了 ${live.length} 道 —— 重名又没合掉`)
  for (const r of live) {
    assert.ok(r.imageBlob instanceof Blob, `同步一轮之后「${r.name}」的照片没了`)
  }
  assert.ok(
    live.every((r) => r.id.startsWith('preset-')),
    '留下的不该换人：新来的那批老 id 时间戳更旧',
  )
  assert.equal(
    rawRows().filter((r) => r.id.startsWith('别处来的') && r.deletedAt).length,
    9,
    '云端带回来的那批老记录没被记成墓碑，下次同步还会再冒出来',
  )
})
