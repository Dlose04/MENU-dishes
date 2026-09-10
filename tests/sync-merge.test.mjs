import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src } from './_bundle.mjs'

const { mergePayload, toSyncRecipe, toSyncPayload, pruneTombstones, TOMBSTONE_TTL_MS, payloadIsEmpty } =
  await load(src('sync/merge.ts'))

const EMPTY = { recipes: [], menus: [] }

/**
 * 把 payload 规范化：合并本身就会排序，所以拿一份空 payload 跟它合一下，
 * 就得到一个「排好序的同一份数据」。测试里比对时都先规范化，
 * 免得为了顺序这种无关紧要的差异写一堆特判。
 */
const norm = (p) => mergePayload(p, EMPTY)

function recipe(id, updatedAt, extra = {}) {
  return {
    id,
    name: `菜-${id}`,
    category: '家常热菜',
    ingredients: ['盐'],
    difficulty: '简单',
    emoji: '🍲',
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  }
}

function menu(date, updatedAt, items = []) {
  return { date, items, updatedAt }
}

/* ------------------------------------------------------------------ */
/* 代数性质 —— 这三条才是「两台设备必然合得上」的保证                    */
/* ------------------------------------------------------------------ */

/** 可复现的伪随机（种子固定，所以失败时能一模一样地重跑）。 */
function makeRand(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function randomPayload(rand) {
  const recipes = []
  const usedIds = new Set()
  for (let i = 0; i < 6; i++) {
    const id = `r${Math.floor(rand() * 5)}`
    if (usedIds.has(id)) continue // 同一份 payload 里 id 不会重复
    usedIds.add(id)
    const t = Math.floor(rand() * 5) + 1
    recipes.push(recipe(id, t, rand() < 0.3 ? { deletedAt: t, ingredients: [] } : {}))
  }

  const menus = []
  const usedDates = new Set()
  for (let i = 0; i < 4; i++) {
    const date = `2026-09-0${Math.floor(rand() * 4) + 1}`
    if (usedDates.has(date)) continue
    usedDates.add(date)
    const items = []
    for (let k = 0; k < Math.floor(rand() * 3); k++) items.push(`r${Math.floor(rand() * 5)}`)
    menus.push(menu(date, Math.floor(rand() * 5) + 1, items))
  }

  return { recipes, menus }
}

test('合并是可交换的：先合哪边不影响结果（否则两台设备永远合不上）', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = makeRand(seed)
    const a = randomPayload(rand)
    const b = randomPayload(rand)
    assert.deepEqual(
      norm(mergePayload(a, b)),
      norm(mergePayload(b, a)),
      `种子 ${seed}：交换后结果不同了`,
    )
  }
})

test('合并是幂等的：同一份数据合两次等于合一次', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rand = makeRand(seed)
    const a = randomPayload(rand)
    const b = randomPayload(rand)
    const m = norm(mergePayload(a, b))
    assert.deepEqual(mergePayload(m, m), m, `种子 ${seed}`)
  }
})

test('合并是结合的：三台设备不管按什么顺序两两合，最终结果都一样', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = makeRand(seed)
    const a = randomPayload(rand)
    const b = randomPayload(rand)
    const c = randomPayload(rand)
    assert.deepEqual(
      norm(mergePayload(mergePayload(a, b), c)),
      norm(mergePayload(a, mergePayload(b, c))),
      `种子 ${seed}：结合顺序影响了结果`,
    )
  }
})

/* ------------------------------------------------------------------ */
/* 具体规则                                                            */
/* ------------------------------------------------------------------ */

test('同一道菜：时间戳大的赢', () => {
  const older = recipe('a', 100, { name: '旧名字' })
  const newer = recipe('a', 200, { name: '新名字' })
  const m = mergePayload({ recipes: [older], menus: [] }, { recipes: [newer], menus: [] })
  assert.equal(m.recipes.length, 1)
  assert.equal(m.recipes[0].name, '新名字')
})

test('删除会传播：另一台设备上那份旧副本不会把菜复活', () => {
  // 这是墓碑存在的**全部理由**。没有 deletedAt 的话，下面这个测试
  // 会留下一条活着的记录 —— 用户在手机上删的菜，在平板上又长回来了。
  const phone = { recipes: [recipe('a', 200, { deletedAt: 200, ingredients: [] })], menus: [] }
  const pad = { recipes: [recipe('a', 100)], menus: [] }
  const m = mergePayload(phone, pad)
  assert.equal(m.recipes.length, 1)
  assert.ok(m.recipes[0].deletedAt, '墓碑输了 —— 被删的菜会被复活')
})

test('没有墓碑时确实会复活（反证：说明墓碑不是多余的）', () => {
  // 对照组。把删除做成「物理抹掉」，另一台设备的旧副本就会赢。
  const phone = { recipes: [], menus: [] }
  const pad = { recipes: [recipe('a', 100)], menus: [] }
  const m = mergePayload(phone, pad)
  assert.equal(m.recipes.length, 1, '这条是预期行为，用来对照上一条')
  assert.equal(m.recipes[0].deletedAt, undefined)
})

test('时间戳完全相同：墓碑赢（必须是确定的规则，不能靠运气）', () => {
  const alive = recipe('a', 100)
  const dead = recipe('a', 100, { deletedAt: 100 })
  assert.ok(mergePayload({ recipes: [alive], menus: [] }, { recipes: [dead], menus: [] }).recipes[0].deletedAt)
  assert.ok(mergePayload({ recipes: [dead], menus: [] }, { recipes: [alive], menus: [] }).recipes[0].deletedAt)
})

test('编辑比删除更新时，菜会回来（用户改主意了，这是对的）', () => {
  const deleted = recipe('a', 100, { deletedAt: 100, ingredients: [] })
  const edited = recipe('a', 300, { name: '又改了' })
  const m = mergePayload({ recipes: [deleted], menus: [] }, { recipes: [edited], menus: [] })
  assert.equal(m.recipes[0].deletedAt, undefined)
  assert.equal(m.recipes[0].name, '又改了')
})

test('菜单：时间戳大的赢', () => {
  const old = menu('2026-09-10', 100, ['a'])
  const fresh = menu('2026-09-10', 200, ['a', 'b'])
  const m = mergePayload({ recipes: [], menus: [old] }, { recipes: [], menus: [fresh] })
  assert.deepEqual(m.menus[0].items, ['a', 'b'])
})

test('菜单：清空能传播（空数组 + 更新的时间戳）', () => {
  const before = menu('2026-09-10', 100, ['a', 'b'])
  const cleared = menu('2026-09-10', 200, [])
  const m = mergePayload({ recipes: [], menus: [before] }, { recipes: [], menus: [cleared] })
  assert.deepEqual(m.menus[0].items, [])
})

test('菜单：移除一道菜能传播（这是不做并集的全部理由）', () => {
  // 并集版本下这条会挂：删掉的 a 会被另一台设备的旧列表带回来。
  const before = menu('2026-09-10', 100, ['a', 'b'])
  const removed = menu('2026-09-10', 200, ['b'])
  const m = mergePayload({ recipes: [], menus: [before] }, { recipes: [], menus: [removed] })
  assert.deepEqual(m.menus[0].items, ['b'], '删掉的菜又活了 —— 用户会以为删除按钮坏了')
})

test('菜单：时间戳打平时，结果只取决于两份内容，不取决于谁先合', () => {
  const a = menu('2026-09-10', 100, ['x'])
  const b = menu('2026-09-10', 100, ['y'])
  const ab = mergePayload({ recipes: [], menus: [a] }, { recipes: [], menus: [b] })
  const ba = mergePayload({ recipes: [], menus: [b] }, { recipes: [], menus: [a] })
  assert.deepEqual(ab, ba, '打平时两边算出的结果不一致 —— 设备会各推各的，永远合不上')
  assert.deepEqual(ab.menus[0].items, ['y'], '按内容比大小的确定结果（是哪个不重要，一致就行）')
})

test('菜单顺序原样保留，不会被合并重排（顺序是用户看得见的）', () => {
  // TodayPage 直接按 menu.items 的顺序渲染，用户点什么顺序就是什么顺序。
  // 一旦合并时排序，每次同步用户都会看到菜单被莫名其妙地重排。
  const mine = menu('2026-09-10', 200, ['晚饭', '汤', '凉菜'])
  const theirs = menu('2026-09-10', 100, ['汤', '凉菜', '晚饭'])
  const m = mergePayload({ recipes: [], menus: [mine] }, { recipes: [], menus: [theirs] })
  assert.deepEqual(m.menus[0].items, ['晚饭', '汤', '凉菜'], '赢的那份顺序被改动了')
})

test('菜单内容键不会把两份不同的列表误判成相同', () => {
  // ['ab','c'] 和 ['a','bc'] 用空串拼起来都是 'abc'，就会被误判成内容相同，
  // 于是合并结果取决于谁先合 —— 又是合不上。
  const a = menu('2026-09-10', 100, ['ab', 'c'])
  const b = menu('2026-09-10', 100, ['a', 'bc'])
  const ab = mergePayload({ recipes: [], menus: [a] }, { recipes: [], menus: [b] })
  const ba = mergePayload({ recipes: [], menus: [b] }, { recipes: [], menus: [a] })
  assert.deepEqual(ab, ba, '两份不同的菜单被当成同一份了')
})

/* ------------------------------------------------------------------ */
/* 脏数据与边界                                                        */
/* ------------------------------------------------------------------ */

test('缺 updatedAt 的老数据按 createdAt 算，不会因为少个字段就永远同步不动', () => {
  const legacy = { ...recipe('a', 100), updatedAt: undefined }
  const edited = recipe('a', 200, { name: '新' })
  const m = mergePayload({ recipes: [legacy], menus: [] }, { recipes: [edited], menus: [] })
  assert.equal(m.recipes[0].name, '新')
})

test('坏时间戳（NaN / 负数 / 字符串）一律当最旧，不会把好数据顶掉', () => {
  const good = recipe('a', 100, { name: '好的' })
  for (const bad of [NaN, -1, 0, undefined, 'abc', null]) {
    const broken = { ...recipe('a', 100), name: '坏的', updatedAt: bad, createdAt: bad }
    const m = mergePayload({ recipes: [broken], menus: [] }, { recipes: [good], menus: [] })
    assert.equal(m.recipes[0].name, '好的', `updatedAt=${String(bad)} 时坏数据赢了`)
  }
})

test('没有 id 的记录直接丢掉，不会污染结果', () => {
  const m = mergePayload(
    { recipes: [{ ...recipe('a', 100), id: '' }, null, recipe('b', 100)], menus: [] },
    { recipes: [], menus: [] },
  )
  assert.deepEqual(m.recipes.map((r) => r.id), ['b'])
})

test('空合集空', () => {
  assert.deepEqual(mergePayload(EMPTY, EMPTY), EMPTY)
})

/* ------------------------------------------------------------------ */
/* 图片不进 payload                                                    */
/* ------------------------------------------------------------------ */

test('照片不进同步数据（第一版刻意不同步图片）', () => {
  const withPhoto = { ...recipe('a', 100), imageBlob: { fake: 'blob' } }
  const stripped = toSyncRecipe(withPhoto)
  assert.equal('imageBlob' in stripped, false)
  // 其余字段一个不能少，否则同步过去的是残缺的菜谱
  assert.equal(stripped.name, withPhoto.name)
  assert.deepEqual(stripped.ingredients, withPhoto.ingredients)
  assert.equal(stripped.emoji, withPhoto.emoji)
})

test('toSyncPayload 同样剥掉图片', () => {
  const p = toSyncPayload([{ ...recipe('a', 100), imageBlob: { fake: 'blob' } }], [menu('2026-09-10', 1, ['a'])])
  assert.equal(JSON.stringify(p).includes('imageBlob'), false)
  assert.equal(JSON.stringify(p).includes('fake'), false)
})

test('JSON 往返之后还能正常合并（网络传的就是 JSON）', () => {
  const a = { recipes: [recipe('a', 100)], menus: [menu('2026-09-10', 5, ['a'])] }
  const roundTrip = JSON.parse(JSON.stringify(a))
  assert.deepEqual(norm(mergePayload(a, roundTrip)), norm(a))
})

/* ------------------------------------------------------------------ */
/* 墓碑清理                                                            */
/* ------------------------------------------------------------------ */

test('过期墓碑会被清掉，新墓碑留着', () => {
  const now = 1_000_000_000_000
  const fresh = recipe('fresh', now - 1000, { deletedAt: now - 1000 })
  const expired = recipe('expired', now - TOMBSTONE_TTL_MS - 1000, { deletedAt: now - TOMBSTONE_TTL_MS - 1000 })
  const alive = recipe('alive', now, {})
  const kept = pruneTombstones([fresh, expired, alive], now).map((r) => r.id)
  assert.deepEqual(kept.sort(), ['alive', 'fresh'])
})

test('清理不会误伤活着的记录（哪怕它很老）', () => {
  const now = 1_000_000_000_000
  const ancient = recipe('ancient', 1, {}) // 1970 年创建的菜，没有墓碑
  assert.deepEqual(pruneTombstones([ancient], now).map((r) => r.id), ['ancient'])
})

test('payloadIsEmpty 认得准', () => {
  assert.equal(payloadIsEmpty(EMPTY), true)
  assert.equal(payloadIsEmpty({ recipes: [recipe('a', 1)], menus: [] }), false)
  assert.equal(payloadIsEmpty({ recipes: [], menus: [menu('2026-09-10', 1, [])] }), false)
})
