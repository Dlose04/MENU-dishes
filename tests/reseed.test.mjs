/**
 * 「重新载入预置菜谱」这个按钮的行为。
 *
 * 设置页上它写着「会把家里那 9 道菜补回来（带照片），已经存在的同名菜不会动」，
 * 但一直零测试。这个按钮干的是**写库**的事，写错了就是静默覆盖用户的东西 ——
 * 用户可能把「番茄炒蛋」改成了自家做法、改过用料，一点按钮全没了，
 * 而且因为菜名还在、卡片还在，看起来什么异常都没有。
 *
 * 另外还钉住稳定 id 带来的一个好处：反复点这个按钮**不会产生副本**。
 * （起因见 src/db/seed.ts 里 presetId 那段 —— 预置菜 id 原来是随机的，
 * 两台设备各自装一遍再同步，同一个菜名会变成两条记录。）
 *
 * 单独一个文件：appStore 的 driver 是模块级单例，一个进程只能初始化一次，
 * 所以这里自己起一份干净的 store（每个测试文件是独立的 node 进程）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubLocalStorage, stubBrowserApis } from './_bundle.mjs'

stubBrowserApis()
stubLocalStorage()

const store = await load(src('store/appStore.ts'))

/** 库里活着的菜谱（readAllRecords 会把墓碑一起返回）。 */
async function live() {
  const { recipes } = await store.readAllRecords()
  return recipes.filter((r) => !r.deletedAt)
}

await store.initStore()

test('首次启动播下了 9 道预置菜', async () => {
  const recipes = await live()
  assert.equal(recipes.length, 9)
  assert.ok(recipes.some((r) => r.name === '番茄炒蛋'))
})

test('重新载入预置菜谱：改过的菜不会被覆盖', async () => {
  const target = (await live()).find((r) => r.name === '番茄炒蛋')
  assert.ok(target, '库里应该有番茄炒蛋')

  // 用户把这道菜改成自家做法（名字不动，只改用料 —— 这是最容易踩的改动方式）
  const ok = await store.patchRecipe(target.id, {
    ingredients: ['番茄', '鸡蛋', '我妈的秘方'],
  })
  assert.equal(ok, true, 'patchRecipe 没成功')

  await store.reseedPresets()

  const after = (await live()).find((r) => r.id === target.id)
  assert.ok(after, '重新载入之后这道菜不见了')
  assert.deepEqual(
    after.ingredients,
    ['番茄', '鸡蛋', '我妈的秘方'],
    '重新载入预置菜谱把用户改过的用料覆盖回去了',
  )
})

/**
 * 上面那条只能证明「没覆盖坏」，证明不了「真的跑了」——
 * reseedPresets 内部是 catch 住异常返回 `{added:0, photoFilled:0}` 的，
 * 它要是静默失败，前两条照样全绿。所以这里先删掉一道，看它能不能补回来。
 */
test('删掉一道预置菜之后，重新载入能把它补回来（证明它真的在干活）', async () => {
  const target = (await live()).find((r) => r.name === '炒香干')
  assert.ok(target, '库里应该有炒香干')

  await store.deleteRecipes([target.id])
  assert.ok(
    !(await live()).some((r) => r.name === '炒香干'),
    '删除没生效，后面的断言就没意义了',
  )

  const res = await store.reseedPresets()
  assert.ok(res.added >= 1, `reseedPresets 说补了 ${res.added} 道 —— 它可能是静默失败了`)
  assert.ok(
    (await live()).some((r) => r.name === '炒香干'),
    '删掉的预置菜没有被补回来',
  )
})

test('反复点「重新载入预置菜谱」不会制造副本（id 稳定）', async () => {
  const before = await live()
  await store.reseedPresets()
  await store.reseedPresets()
  const after = await live()

  assert.equal(after.length, before.length, '多跑两次重新载入，菜的数量变了')

  const ids = after.map((r) => r.id)
  assert.equal(new Set(ids).size, ids.length, '出现了重复的 id')

  const names = after.map((r) => r.name)
  assert.equal(new Set(names).size, names.length, `出现了重名的菜：${names.join('、')}`)
})

/**
 * 同名菜有两条时，两条都要看。
 *
 * 这是用户 2026-09-10 那种局面：预置菜 id 还是随机的时候，两台设备各播一遍
 * 再同步，同一个菜名就成了两条记录，而且从别的设备过来的那条**没有照片**
 * （同步不搬图片）。用户按「重新载入预置菜谱」想把图找回来，如果实现只取
 * 「同名里的一条」，补到哪条就取决于库里的顺序 —— 按了有时候管用有时候不管用。
 *
 * 故意放在最后：这一步会在库里留下一条重名的记录（正是要模拟的现场），
 * 而上面那条用例的断言恰恰是「不许有重名的菜」。
 */
test('同名菜有重复副本时，每一条没图的都会被补上', async () => {
  const original = (await live()).find((r) => r.name === '番茄炒蛋')
  assert.ok(original, '前提：库里有番茄炒蛋')

  // 造一条同名的副本（模拟同步过来的那一条：名字一样、id 不同、没有图）
  const dup = await store.createRecipe({
    name: '番茄炒蛋',
    category: '家常热菜',
    ingredients: ['番茄', '鸡蛋'],
    difficulty: '简单',
    emoji: '🍅',
  })
  assert.ok(dup, '同名副本没建出来')
  assert.notEqual(dup.id, original.id, '副本得是另一个 id，否则测的不是「同名两条」这件事')

  // 两条都没图
  await store.patchRecipe(original.id, { imageBlob: undefined })

  const res = await store.reseedPresets()
  assert.ok(
    res.photoFilled >= 2,
    `同名两条都没图，就该补两条，实际补了 ${res.photoFilled} 条 —— 只补一条的话，补到哪条全看库里的顺序`,
  )

  const pair = (await live()).filter((r) => r.name === '番茄炒蛋')
  assert.equal(pair.length, 2, 'reseed 不该顺手合并或删掉同名的记录（那是用户的数据）')
  for (const one of pair) {
    assert.ok(one.imageBlob instanceof Blob, `同名的那条「${one.id}」还是没图`)
  }
})
