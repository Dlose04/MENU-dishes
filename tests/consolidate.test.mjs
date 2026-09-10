/**
 * 同名归并（src/sync/consolidate.ts）。
 *
 * 起因：用户 2026-09-10 报「同步完又出现菜品重复」，截图里写着「全部 18」——
 * 9 道菜每道两条，一条带照片、一条没有。根子是预置菜的 id 从 `nanoid()`
 * 改成 `preset-<菜名>` 时**只对以后新播种的设备生效**，云端和装过的设备里
 * 那批随机 id 的老记录一条没动，两批一碰面就是 18 条。
 *
 * 这里钉的是归并本身的规则。**最容易写错、也最要紧的两条**：
 * - 照片必须从被合并掉的那条接到留下的那条身上（同步不搬图片，接不到就是丢）；
 * - 被合并掉的那条必须留一个**比这一组里所有记录都新**的墓碑，
 *   否则别的设备上那条老副本会赢过墓碑、把删掉的菜又活过来。
 *
 * 真机那条路（IndexedDB + 一整套同步写回）见 consolidate-idb.test.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src } from './_bundle.mjs'

const { consolidateByName } = await load(src('sync/consolidate.ts'))

/** 造一条菜谱。`image` 传个 Blob 就表示这条有照片。 */
function rec(id, name, { createdAt = 1000, updatedAt, image, deletedAt } = {}) {
  return {
    id,
    name,
    category: '家常热菜',
    ingredients: ['盐'],
    difficulty: '简单',
    emoji: '🍲',
    createdAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(image ? { imageBlob: image } : {}),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  }
}

const jpg = (byte) => new Blob([new Uint8Array([byte, byte, byte])], { type: 'image/jpeg' })

test('同名的两条合成一条，留下时间戳更新的那条', () => {
  const older = rec('legacy-番茄炒蛋', '番茄炒蛋', { createdAt: 100, updatedAt: 100 })
  const newer = rec('preset-番茄炒蛋', '番茄炒蛋', { createdAt: 500, updatedAt: 500 })

  const res = consolidateByName([older, newer], [], { stamp: 10_000 })

  assert.equal(res.mergedGroups, 1)
  assert.equal(res.recipes.filter((r) => !r.deletedAt).length, 1, '没合干净')
  const live = res.recipes.find((r) => !r.deletedAt)
  assert.equal(live.id, 'preset-番茄炒蛋', '留下的应该是更新的那条')
  assert.ok(
    res.recipes.some((r) => r.id === 'legacy-番茄炒蛋' && r.deletedAt),
    '被合并掉的那条必须留墓碑 —— 真删掉的话，别的设备下回同步会把它推回来',
  )
})

test('照片从被合并掉的那条接到留下的那条身上（同步不搬图，接不到就是丢）', () => {
  // 用户现场的精确形状：老记录有照片、新记录没照片（新的是从云端回来的）
  const oldWithPhoto = rec('legacy-番茄炒蛋', '番茄炒蛋', { createdAt: 100, image: jpg(1) })
  const newNoPhoto = rec('preset-番茄炒蛋', '番茄炒蛋', { createdAt: 900, updatedAt: 900 })

  const res = consolidateByName([oldWithPhoto, newNoPhoto], [], { stamp: 10_000 })

  const live = res.recipes.find((r) => !r.deletedAt)
  assert.equal(live.id, 'preset-番茄炒蛋')
  assert.ok(live.imageBlob, '照片没接过来 —— 用户会看到菜还在、图没了')
  assert.equal(res.photoRescued, 1)

  const grave = res.recipes.find((r) => r.id === 'legacy-番茄炒蛋')
  assert.equal(grave.imageBlob, undefined, '墓碑不该继续占着照片的空间')

  // 接回来的图必须落库，否则界面上有、下次启动又没了
  assert.ok(
    res.recipeWrites.some((r) => r.id === 'preset-番茄炒蛋' && r.imageBlob),
    '接过照片的那条没进写入列表',
  )
})

test('墓碑要比这一组里所有记录都新，否则别的设备上那条老副本会赢过它', () => {
  const a = rec('a', '红烧豆腐', { createdAt: 100, updatedAt: 100 })
  const b = rec('b', '红烧豆腐', { createdAt: 900, updatedAt: 900 })

  // stamp 给一个比两者都小的值：墓碑必须自己抬高到比 900 还大
  const res = consolidateByName([a, b], [], { stamp: 50 })

  const grave = res.recipes.find((r) => r.deletedAt)
  assert.ok(grave, '没留墓碑')
  assert.ok(
    grave.updatedAt > 900,
    `墓碑时间戳 ${grave.updatedAt} 没有比组里最新的 900 大 —— 它会输给别的设备上的旧副本`,
  )
  assert.equal(grave.deletedAt, grave.updatedAt)
})

test('墓碑也不能老到被当成过期墓碑清掉', () => {
  // 这组记录全是半年前的老数据，stamp 是「现在」
  const old = 1_000
  const res = consolidateByName(
    [rec('a', '炒香干', { createdAt: old }), rec('b', '炒香干', { createdAt: old, updatedAt: old + 1 })],
    [],
    { stamp: Date.now() },
  )
  const grave = res.recipes.find((r) => r.deletedAt)
  assert.ok(
    Date.now() - grave.deletedAt < 1000,
    '墓碑被打成了半年前的时间戳，同步时会被 pruneTombstones 清掉，然后菜就复活了',
  )
})

test('菜单里指向被合并掉那条的引用改指到留下的那条，且不重复', () => {
  const a = rec('a', '干锅包菜', { createdAt: 100 })
  const b = rec('b', '干锅包菜', { createdAt: 500, updatedAt: 500 })
  // 这一天的菜单里两条都点过 —— 不去重的话同一道菜会显示两遍
  const menu = { date: '2026-09-10', items: ['a', 'b', '别的菜'], updatedAt: 700 }

  const res = consolidateByName([a, b], [menu], { stamp: 10_000 })

  const next = res.menus[0]
  assert.deepEqual(next.items, ['b', '别的菜'], '菜单还指着被合并掉的旧 id，那道菜会从菜单里消失')
  assert.ok(next.updatedAt > 700, '菜单打了新时间戳才会同步出去')
  assert.equal(res.menuWrites.length, 1)
})

test('没有重名时是纯粹的 no-op（一条记录都不该写）', () => {
  const recipes = [
    rec('1', '番茄炒蛋', { createdAt: 100 }),
    rec('2', '炒香干', { createdAt: 200 }),
  ]
  const menus = [{ date: '2026-09-10', items: ['1'], updatedAt: 300 }]

  const res = consolidateByName(recipes, menus, { stamp: 10_000 })

  assert.equal(res.mergedGroups, 0)
  assert.deepEqual(res.recipeWrites, [])
  assert.deepEqual(res.menuWrites, [])
  // 连对象引用都不该换：每次启动、每次同步都会跑一遍，无谓地重写会
  // 让「本地和云端一致就不用推」这条短路失效，同步变成每次都推。
  assert.equal(res.recipes[0], recipes[0])
  assert.equal(res.menus[0], menus[0])
})

test('名字不同的菜一律不动（不许把「都叫…」当成重名）', () => {
  const recipes = [
    rec('1', '番茄炒蛋', { createdAt: 100 }),
    rec('2', '西红柿炒蛋', { createdAt: 200 }),
    rec('3', '番茄鸡蛋汤', { createdAt: 300 }),
  ]
  const res = consolidateByName(recipes, [], { stamp: 10_000 })
  assert.equal(res.mergedGroups, 0)
  assert.equal(res.recipes.length, 3)
})

test('已删的同名记录不参与归并（删了一道再记同名的，新的那条不该被合掉）', () => {
  const grave = rec('old', '辣椒炒肉', { createdAt: 100, deletedAt: 150, updatedAt: 150 })
  const fresh = rec('new', '辣椒炒肉', { createdAt: 900, updatedAt: 900 })

  const res = consolidateByName([grave, fresh], [], { stamp: 10_000 })

  assert.equal(res.mergedGroups, 0)
  assert.equal(res.recipes.length, 2, '墓碑被当成重名合掉了')
  assert.ok(res.recipes.some((r) => r.id === 'new' && !r.deletedAt))
  assert.ok(res.recipes.some((r) => r.id === 'old' && r.deletedAt))
})

test('时间戳打平时优先留 preset-<菜名> 那条', () => {
  const same = 500
  const random = rec('Xk3pQ', '美味速食', { createdAt: same, updatedAt: same })
  const canonical = rec('preset-美味速食', '美味速食', { createdAt: same, updatedAt: same })

  // 两种顺序都要给出同一个答案：真实合并里两条记录的先后取决于输入顺序，
  // 而两台设备的输入顺序不一定一样，两次算出不同的赢家就永远合不上
  for (const input of [[random, canonical], [canonical, random]]) {
    const res = consolidateByName(input, [], { stamp: 10_000 })
    assert.equal(
      res.recipes.find((r) => !r.deletedAt).id,
      'preset-美味速食',
      '打平时留下的应该是标准 id 那条（跟输入顺序无关）',
    )
  }
})

test('活着的记录没图、同名的墓碑身上有图 → 也接回来', () => {
  // 另一台设备上的形状：老记录（有照片）被这次同步判了死刑变成墓碑，
  // 而新记录（preset- id，没照片）还活着。不接的话，那张图会随着
  // 墓碑写回被静默释放掉 —— 用户第二次丢照片。
  const dyingWithPhoto = rec('legacy', '酸辣土豆丝', {
    createdAt: 100,
    updatedAt: 900,
    deletedAt: 900,
    image: jpg(9),
  })
  const alive = rec('preset-酸辣土豆丝', '酸辣土豆丝', { createdAt: 800, updatedAt: 800 })

  const res = consolidateByName([dyingWithPhoto, alive], [], { stamp: 10_000 })

  const live = res.recipes.find((r) => !r.deletedAt)
  assert.ok(live.imageBlob, '活着的这条没从墓碑身上接回照片')
  assert.equal(res.photoRescued, 1)
})

test('照片从本地那份（photos）里取 —— 合并结果里的记录本来就不带图', () => {
  // 同步写回时传进来的记录是云端形状：没有 imageBlob。照片只在本地那份里。
  const cloudOld = rec('legacy', '火腿炒蛋', { createdAt: 100, updatedAt: 400 })
  const cloudNew = rec('preset-火腿炒蛋', '火腿炒蛋', { createdAt: 900, updatedAt: 900 })
  const photos = new Map([['legacy', jpg(7)]])

  const res = consolidateByName([cloudOld, cloudNew], [], { stamp: 10_000, photos })

  const live = res.recipes.find((r) => !r.deletedAt)
  assert.ok(live.imageBlob, '没从本机那份照片里取 —— 云端记录是不带图的，只能从这儿拿')
})
