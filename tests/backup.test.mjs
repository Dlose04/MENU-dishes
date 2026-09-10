import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubBrowserApis } from './_bundle.mjs'

stubBrowserApis()

const backup = await load(src('lib/backup.ts'))
const { buildBackup, parseBackup, BACKUP_APP_ID, BACKUP_VERSION } = backup

/** 一个最小的假图片 Blob（内容是什么不重要，能往返就行）。 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const fakeImage = () => new Blob([PNG_BYTES], { type: 'image/png' })

const RECIPE = {
  id: 'abc123def456',
  name: '番茄炒蛋',
  category: '家常热菜',
  ingredients: ['番茄', '鸡蛋'],
  difficulty: '简单',
  emoji: '🍅',
  note: '番茄要先烫皮',
  createdAt: 1757000000000,
}

const MENUS = [
  { date: '2026-09-10', items: ['abc123def456'] },
  { date: '2026-09-09', items: [] },
]

test('导出的文件带有应用标识和版本号（方便以后识别和升级）', async () => {
  const { file, text } = await buildBackup([RECIPE], MENUS)
  assert.equal(file.app, BACKUP_APP_ID)
  assert.equal(file.version, BACKUP_VERSION)
  assert.ok(typeof file.exportedAt === 'string' && file.exportedAt.includes('T'))
  assert.deepEqual(JSON.parse(text).app, 'family-menu')
})

test('没有图片的菜谱：照样导出，图片数记 0', async () => {
  const { text, imageCount } = await buildBackup([RECIPE], MENUS)
  assert.equal(imageCount, 0)
  const parsed = JSON.parse(text)
  assert.equal(parsed.recipes.length, 1)
  assert.equal(parsed.recipes[0].image, undefined)
  assert.equal(parsed.recipes[0].name, '番茄炒蛋')
})

test('带图片的菜谱：图片转成 dataURL 一起带走，并统计张数', async () => {
  const withImage = { ...RECIPE, imageBlob: fakeImage() }
  const { text, imageCount } = await buildBackup([withImage], MENUS)
  assert.equal(imageCount, 1)

  const parsed = JSON.parse(text)
  assert.ok(parsed.recipes[0].image.startsWith('data:image/png;base64,'))
  // Blob 本身不该出现在 JSON 里
  assert.equal(parsed.recipes[0].imageBlob, undefined)
})

test('导出再导入，菜谱内容一模一样', async () => {
  const original = { ...RECIPE, imageBlob: fakeImage() }
  const { text } = await buildBackup([original], MENUS)
  const { recipes, menus, skipped } = parseBackup(text)

  assert.equal(skipped, 0)
  assert.equal(recipes.length, 1)
  const r = recipes[0]
  assert.equal(r.id, original.id)
  assert.equal(r.name, original.name)
  assert.equal(r.category, original.category)
  assert.deepEqual(r.ingredients, original.ingredients)
  assert.equal(r.difficulty, original.difficulty)
  assert.equal(r.emoji, original.emoji)
  assert.equal(r.note, original.note)
  assert.equal(r.createdAt, original.createdAt)

  // 图片变回了 Blob，且字节一致
  assert.ok(r.imageBlob instanceof Blob)
  assert.equal(r.imageBlob.type, 'image/png')
  const bytes = new Uint8Array(await r.imageBlob.arrayBuffer())
  assert.deepEqual([...bytes], [...PNG_BYTES])

  assert.deepEqual(menus, MENUS)
})

test('MIME 类型丢了也能救回来（有些导出工具会写成 octet-stream）', () => {
  const text = JSON.stringify({
    app: 'family-menu',
    version: 1,
    recipes: [
      {
        ...RECIPE,
        image: `data:image/jpeg;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
      },
    ],
    menus: [],
  })
  const { recipes } = parseBackup(text)
  assert.ok(recipes[0].imageBlob instanceof Blob)
  assert.equal(recipes[0].imageBlob.type, 'image/jpeg')
})

test('选错文件：给人话提示，而不是白屏', () => {
  const cases = [
    ['这不是 JSON', /不是合法的 JSON/],
    ['', /不是合法的 JSON/],
    ['[1,2,3]', null], // 是数组但里面没有菜谱对象，会被跳过而不是报错
    ['"just a string"', /不是一个对象/],
    ['{"foo":1}', /没有 recipes 字段/],
    ['{"recipes":"not-an-array"}', /没有 recipes 字段/],
  ]
  for (const [text, expected] of cases) {
    if (expected === null) {
      assert.doesNotThrow(() => parseBackup(text))
      continue
    }
    assert.throws(() => parseBackup(text), expected, `「${text}」的提示不对`)
  }
})

test('缺 id 或名字的条目被丢掉，并计入 skipped', () => {
  const text = JSON.stringify({
    app: 'family-menu',
    version: 1,
    recipes: [
      RECIPE,
      { ...RECIPE, id: '' }, // 没 id
      { ...RECIPE, name: '   ' }, // 名字是空白
      null,
      'not an object',
    ],
    menus: [],
  })
  const { recipes, skipped } = parseBackup(text)
  assert.equal(recipes.length, 1)
  assert.equal(skipped, 4)
})

test('也接受直接丢一个菜谱数组进来', () => {
  const { recipes, menus } = parseBackup(JSON.stringify([RECIPE]))
  assert.equal(recipes.length, 1)
  assert.deepEqual(menus, [])
})

test('怪字段被修成能用的值，而不是把坏数据带进库', () => {
  const text = JSON.stringify({
    app: 'family-menu',
    version: 1,
    recipes: [
      {
        id: 'x1',
        name: '  两头有空格  ',
        category: 123,
        ingredients: ['盐', '', 42, null, '糖'],
        difficulty: '超难',
        emoji: '',
        note: '',
        createdAt: 'yesterday',
      },
    ],
    menus: [],
  })
  const { recipes } = parseBackup(text)
  const r = recipes[0]
  assert.equal(r.name, '两头有空格')
  assert.equal(r.category, '')
  assert.deepEqual(r.ingredients, ['盐', '糖'], '非字符串和空串要滤掉')
  assert.equal(r.difficulty, '简单', '认不出的难度退回默认值')
  assert.equal(r.emoji, '🍽️', '没图标的给个兜底图标')
  assert.equal(r.note, undefined)
  assert.ok(Number.isFinite(r.createdAt), '坏时间戳要兜底成当前时间')
})

test('日期格式不对的菜单被丢掉，正常的留下', () => {
  const text = JSON.stringify({
    app: 'family-menu',
    version: 1,
    recipes: [RECIPE],
    menus: [
      { date: '2026-09-10', items: ['abc123def456', 42] },
      { date: '2026/09/10', items: ['abc123def456'] }, // 分隔符不对
      { date: '2026-9-10', items: ['abc123def456'] }, // 没补零
      { date: '', items: [] },
      { items: [] }, // 没日期
      null,
    ],
  })
  const { menus } = parseBackup(text)
  assert.equal(menus.length, 1)
  assert.equal(menus[0].date, '2026-09-10')
  assert.deepEqual(menus[0].items, ['abc123def456'], '非字符串的 item 要滤掉')
})

test('没有 menus 字段也能导入（只导出菜谱的场景）', () => {
  const { recipes, menus } = parseBackup(JSON.stringify({ recipes: [RECIPE] }))
  assert.equal(recipes.length, 1)
  assert.deepEqual(menus, [])
})
