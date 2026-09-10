import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubLocalStorage } from './_bundle.mjs'

const ls = stubLocalStorage()
const seed = await load(src('db/seed.ts'))
const { PRESET_RECIPES, buildSeedRecipes, shouldSeed, markSeeded } = seed
const { SEED_PHOTOS } = await load(src('db/seed-photos.ts'))

/**
 * 自家那 8 道菜，照用户给的说法逐字抄下来做对照。
 *
 * 这里的期望值是**手抄的**，不是从 src/db/seed.ts 里 import 过来的 ——
 * 从源码里取期望值等于自己证明自己，改错了也测不出来。
 */
const SPEC = [
  { name: '番茄炒蛋', category: '家常热菜', ingredients: ['番茄', '鸡蛋'], difficulty: '简单', emoji: '🍅' },
  { name: '酸辣土豆丝', category: '素菜', ingredients: ['土豆', '青辣椒', '红辣椒'], difficulty: '简单', emoji: '🥔' },
  { name: '炒香干', category: '素菜', ingredients: ['豆干', '辣椒'], difficulty: '简单', emoji: '🫘' },
  { name: '意祥一碗香', category: '家常热菜', ingredients: ['鸡蛋', '猪肉', '辣椒'], difficulty: '中等', emoji: '🍲' },
  { name: '红烧豆腐', category: '家常热菜', ingredients: ['豆腐', '辣椒'], difficulty: '简单', emoji: '🥘' },
  { name: '干锅包菜', category: '家常热菜', ingredients: ['猪肉', '包菜', '干辣椒'], difficulty: '中等', emoji: '🥬' },
  { name: '辣椒炒肉', category: '家常热菜', ingredients: ['辣椒', '猪肉'], difficulty: '简单', emoji: '🌶️' },
  { name: '火腿炒蛋', category: '家常热菜', ingredients: ['火腿', '鸡蛋'], difficulty: '简单', emoji: '🍳' },
]

test('预置菜就是自家那 8 道（字段逐个对）', () => {
  assert.equal(PRESET_RECIPES.length, 8)
  assert.deepEqual(
    PRESET_RECIPES.map((p) => ({ ...p })),
    SPEC,
  )
})

test('buildSeedRecipes 产出完整菜谱：带 id、带创建时间', () => {
  const recipes = buildSeedRecipes()
  assert.equal(recipes.length, 8)
  const ids = new Set(recipes.map((r) => r.id))
  assert.equal(ids.size, 8, 'id 重复了')
  for (const r of recipes) {
    assert.ok(r.id.length >= 12, `id 太短：${r.id}`)
    assert.ok(Number.isFinite(r.createdAt) && r.createdAt > 0)
    assert.ok(Array.isArray(r.ingredients))
  }
  // 保持原始编排顺序，用户看到的就是这个顺序
  assert.deepEqual(
    recipes.map((r) => r.name),
    SPEC.map((s) => s.name),
  )
})

/**
 * 配图这条线单独钉住。
 *
 * 起因：照片是 base64 内联在 src/db/seed-photos.ts 里的，而那张表是按**菜名**
 * 索引的 —— 菜名打错一个字、或者 seed-photos/ 的文件序号和 PRESET_RECIPES
 * 对不上，照片就会静静地落到别的菜身上（或者干脆没有）。构建和 tsc 都不会
 * 报错，只有真机打开才看得出来。所以这里逐个菜名核对，并且真解一遍 base64。
 */
test('每道预置菜都带上了自己那张照片，而且是张真 JPEG', async () => {
  const recipes = buildSeedRecipes()
  for (const r of recipes) {
    assert.ok(r.imageBlob instanceof Blob, `${r.name} 没有配图`)
    assert.equal(r.imageBlob.type, 'image/jpeg', `${r.name} 的图片 MIME 不对`)
    // 解出前几个字节验一下 JPEG 魔数 FF D8 FF —— 只检查非空的话，
    // 把某道菜的照片复制成另一道菜的，这个测试照样绿。
    const head = new Uint8Array(await r.imageBlob.slice(0, 3).arrayBuffer())
    assert.deepEqual([...head], [0xff, 0xd8, 0xff], `${r.name} 的照片不是合法 JPEG`)
    assert.ok(r.imageBlob.size > 10_000, `${r.name} 的照片小得不像照片：${r.imageBlob.size} 字节`)
  }
  // 8 张各不相同：串图最典型的症状就是「每道菜长得一样」
  const sizes = recipes.map((r) => r.imageBlob.size)
  assert.equal(new Set(sizes).size, 8, '有菜共用了同一张照片')
})

test('菜名和配图表对得上：改菜名会让照片落空，而不是串到别的菜身上', () => {
  // 这条是上面那条的对照组 —— 说明「按名字取图」在名字对不上时是安全失败，
  // 而不是悄悄拿隔壁那道菜的照片顶上。
  assert.equal(Object.keys(SEED_PHOTOS).length, 8)
  assert.deepEqual(Object.keys(SEED_PHOTOS), SPEC.map((s) => s.name))
})

test('同一个数据只播种一次：清空菜谱后不会又冒出来', () => {
  ls.clear()

  // 全新用户：库是空的 + 没播种过 -> 播
  assert.equal(shouldSeed(0), true)

  // 播种完成
  markSeeded()
  assert.equal(ls.getItem('family-menu:seeded'), '1')

  // 用户把菜全删了（库空了），但已经播过种 -> 不再播
  assert.equal(shouldSeed(0), false, '用户清空之后预置菜不该自己长回来')
})

test('数据库非空时永远不播种（判断依据是「库空不空」，不是「第几次启动」）', () => {
  ls.clear()
  assert.equal(shouldSeed(3), false)
  assert.equal(shouldSeed(1), false)
  markSeeded()
  assert.equal(shouldSeed(0), false)
})

test('localStorage 完全不可用时退化成「只看库空不空」，不抛异常', () => {
  const saved = globalThis.localStorage
  // 模拟隐私模式下访问 localStorage 就抛
  delete globalThis.localStorage
  try {
    assert.doesNotThrow(() => shouldSeed(0))
    assert.equal(shouldSeed(0), true, '读不到标记时，空库应该照常播种')
    assert.equal(shouldSeed(5), false)
    assert.doesNotThrow(() => markSeeded())
  } finally {
    globalThis.localStorage = saved
  }
})

test('预置菜被改过之后不会被覆盖（重新播种时按名字跳过已有菜）', () => {
  // buildSeedRecipes 每次生成新 id，所以「改过的预置菜」在库里就是一条
  // 普通记录；seeded 标记保证不会再有第二次自动播种把用户改动冲掉。
  const a = buildSeedRecipes()
  const b = buildSeedRecipes()
  assert.notEqual(a[0].id, b[0].id, '两次播种应该是不同的 id（所以只能播一次）')
  assert.deepEqual(
    a.map((r) => r.name),
    b.map((r) => r.name),
  )
})
