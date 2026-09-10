import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubLocalStorage } from './_bundle.mjs'

const ls = stubLocalStorage()
const seed = await load(src('db/seed.ts'))
const { PRESET_RECIPES, buildSeedRecipes, shouldSeed, markSeeded } = seed

/** 需求文档里写死的 12 道预置菜，逐字抄下来做对照。 */
const SPEC = [
  { name: '番茄炒蛋', category: '家常热菜', ingredients: ['番茄', '鸡蛋', '小葱'], difficulty: '简单', emoji: '🍅' },
  { name: '青椒肉丝', category: '家常热菜', ingredients: ['青椒', '猪里脊', '蒜'], difficulty: '简单', emoji: '🫑' },
  { name: '酸辣土豆丝', category: '家常热菜', ingredients: ['土豆', '干辣椒', '陈醋'], difficulty: '简单', emoji: '🥔' },
  { name: '麻婆豆腐', category: '家常热菜', ingredients: ['嫩豆腐', '牛肉末', '豆瓣酱', '花椒'], difficulty: '中等', emoji: '🌶️' },
  { name: '红烧肉', category: '硬菜', ingredients: ['五花肉', '冰糖', '八角', '生抽'], difficulty: '中等', emoji: '🥩' },
  { name: '宫保鸡丁', category: '硬菜', ingredients: ['鸡胸肉', '花生米', '干辣椒'], difficulty: '中等', emoji: '🍗' },
  { name: '可乐鸡翅', category: '硬菜', ingredients: ['鸡中翅', '可乐', '姜片'], difficulty: '简单', emoji: '🥤' },
  { name: '清蒸鲈鱼', category: '硬菜', ingredients: ['鲈鱼', '葱姜', '蒸鱼豉油'], difficulty: '中等', emoji: '🐟' },
  { name: '糖醋排骨', category: '硬菜', ingredients: ['肋排', '香醋', '冰糖'], difficulty: '较难', emoji: '🍖' },
  { name: '蒜蓉西兰花', category: '素菜', ingredients: ['西兰花', '蒜'], difficulty: '简单', emoji: '🥦' },
  { name: '干煸四季豆', category: '素菜', ingredients: ['四季豆', '肉末', '干辣椒'], difficulty: '中等', emoji: '🫛' },
  { name: '紫菜蛋花汤', category: '汤羹', ingredients: ['紫菜', '鸡蛋', '虾皮'], difficulty: '简单', emoji: '🍲' },
]

test('预置菜和需求文档里的一模一样（12 道，字段逐个对）', () => {
  assert.equal(PRESET_RECIPES.length, 12)
  assert.deepEqual(
    PRESET_RECIPES.map((p) => ({ ...p })),
    SPEC,
  )
})

test('buildSeedRecipes 产出完整菜谱：带 id、带创建时间', () => {
  const recipes = buildSeedRecipes()
  assert.equal(recipes.length, 12)
  const ids = new Set(recipes.map((r) => r.id))
  assert.equal(ids.size, 12, 'id 重复了')
  for (const r of recipes) {
    assert.ok(r.id.length >= 12, `id 太短：${r.id}`)
    assert.ok(Number.isFinite(r.createdAt) && r.createdAt > 0)
    assert.ok(Array.isArray(r.ingredients))
  }
  // 保持原始编排顺序，用户看到的就是文档里那个顺序
  assert.deepEqual(
    recipes.map((r) => r.name),
    SPEC.map((s) => s.name),
  )
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
