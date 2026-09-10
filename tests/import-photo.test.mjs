/**
 * 「照片怎么跟着菜到别的设备」—— 导入备份时的补图。
 *
 * 起因：用户 2026-09-10 报「每台设备同步过一次之后，菜品就变成不带照片的样子」。
 * 跨设备同步**刻意不搬图片**（见 sync/merge.ts），所以照片想到别的设备上去
 * 只有导出/导入备份这一条路。而这条路一直是断的：
 *
 * 备份里每道菜的 id 和本地**是同一个**（同一条记录同步过去的），于是整批命中
 * 「已存在就跳过」。用户拿着一个明明带照片的备份导进去，一张图也没回来，
 * 界面上还只写着「跳过 N 道已存在」，看起来一切正常。
 *
 * 现在开的口子只有一个：**本地没图、备份里有**，就把图补上，其余字段一律不动。
 * 这个文件把这条口子的三个边界都钉住 —— 尤其是「本地已经有图时绝不覆盖」，
 * 那是用户自己选的图，比备份里的新。
 *
 * 用例跑在 IndexedDB 那条路上（真机上所有浏览器走的都是它），
 * 因为「图有没有真的落库」和「界面上有没有图」是两件事，两边都要查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubLocalStorage, stubBrowserApis } from './_bundle.mjs'
import { makeFakeIndexedDB } from './_fake-idb.mjs'

stubBrowserApis()
stubLocalStorage()
const fake = makeFakeIndexedDB()

const store = await load(src('store/appStore.ts'))
const { buildBackup } = await load(src('lib/backup.ts'))

const rawById = (id) => fake.data.get('recipes').get(id)

/**
 * 造一张「图片」。只是几个字节 —— 导出/导入这条路上没人会去解码它，
 * 这里要验的是「字节有没有原样搬到另一台设备」，不是「图能不能显示」。
 * 用不同的字节序列，是为了能分辨导入前后是不是同一张图。
 */
const blob = (...bytes) => new Blob([new Uint8Array(bytes)], { type: 'image/png' })

/** 把一组菜谱做成备份文件的内容。 */
async function backupWith(recipes) {
  const { text } = await buildBackup(recipes, [])
  return text
}

/** 备份里那道菜：把本地记录原样抄一份，只换掉图片。 */
function withPhoto(recipe, image) {
  return { ...recipe, imageBlob: image }
}

await store.initStore()

const FIRST = () => store.getState().recipes[0]

test('前提：这次跑的是 IndexedDB 那条路，而且第一道菜本来是有图的', () => {
  assert.equal(store.getState().mode, 'indexeddb', '假 IDB 没被用上，测的就不是真机那条路')
  const r = FIRST()
  assert.ok(r.imageBlob instanceof Blob, '前提：预置菜带照片')
  assert.ok(rawById(r.id).imageBuffer instanceof ArrayBuffer, '前提：照片确实落库了')
})

test('本地有这道菜但没图时，导入备份会把图补上（这条否则就是断的）', async () => {
  const target = FIRST()

  // 用户把这道菜的图移除了（编辑器里的「移除图片」走的就是这条路）
  await store.patchRecipe(target.id, { imageBlob: undefined })
  const stripped = store.getState().recipes.find((r) => r.id === target.id)
  assert.equal(stripped.imageBlob, undefined, '前提：这道菜现在没图')
  assert.equal(rawById(target.id).imageBuffer, undefined, '前提：库里也没图了')

  // 补图**不该**动时间戳，所以这里量的是「移除图片之后、导入之前」那个值
  const stampBefore = stripped.updatedAt ?? stripped.createdAt

  const IMAGE = blob(1, 2, 3, 4)
  const res = await store.importLibrary(await backupWith([withPhoto(target, IMAGE)]))
  assert.ok(res, '导入失败了')

  assert.equal(res.added, 0, '这不是新菜，不该算新增')
  assert.equal(res.photoFilled, 1, `应该补 1 张图，实际 ${res.photoFilled} —— 从别的设备搬照片只有这条路`)
  assert.equal(res.skippedExisting, 1)

  const after = store.getState().recipes.find((r) => r.id === target.id)
  assert.ok(after.imageBlob instanceof Blob, '界面上还是没有图')
  assert.deepEqual([...new Uint8Array(await after.imageBlob.arrayBuffer())], [1, 2, 3, 4])

  // 只补图，不能顺手把这条记录变成「最新」—— 那会在别的设备上把更新的改动顶掉
  assert.equal(after.updatedAt ?? after.createdAt, stampBefore, '补图改动了时间戳')
  assert.equal(after.name, target.name, '补图把别的字段也改了')

  // 落库的也必须是图：界面上有、库里没有的话，下次启动又没了
  assert.ok(rawById(target.id).imageBuffer instanceof ArrayBuffer, '补的图没有落库')
})

test('本地已经有图时，导入不会覆盖用户自己选的那张', async () => {
  const target = FIRST()
  assert.ok(target.imageBlob instanceof Blob, '前提：上一轮已经补回图了')

  const res = await store.importLibrary(await backupWith([withPhoto(target, blob(9, 9, 9))]))
  assert.ok(res)
  assert.equal(res.photoFilled, 0, '本地有图还去补，会把用户自己选的图顶掉')

  const after = store.getState().recipes.find((r) => r.id === target.id)
  assert.deepEqual(
    [...new Uint8Array(await after.imageBlob.arrayBuffer())],
    [1, 2, 3, 4],
    '用户自己选的图被备份里那张覆盖了',
  )
})

test('备份里那条同样没图时，本地这张图不会因为导入而丢掉', async () => {
  const target = FIRST()
  const before = [...new Uint8Array(await target.imageBlob.arrayBuffer())]

  const res = await store.importLibrary(await backupWith([{ ...target, imageBlob: undefined }]))
  assert.ok(res)
  assert.equal(res.photoFilled, 0)

  const after = store.getState().recipes.find((r) => r.id === target.id)
  assert.ok(after.imageBlob instanceof Blob, '本地照片被一条没图的同名记录冲掉了')
  assert.deepEqual([...new Uint8Array(await after.imageBlob.arrayBuffer())], before)
})

test('备份里的新菜照常新增，而且带图', async () => {
  const before = store.getState().recipes.length
  const fresh = {
    id: 'from-backup',
    name: '另一台设备记的菜',
    category: '家常热菜',
    ingredients: ['盐'],
    difficulty: '简单',
    emoji: '🍲',
    createdAt: 1000,
  }

  const res = await store.importLibrary(await backupWith([withPhoto(fresh, blob(7, 7, 7, 7, 7))]))
  assert.ok(res)
  assert.equal(res.added, 1, '新菜没进来')
  assert.equal(res.photoFilled, 0)

  const added = store.getState().recipes.find((r) => r.id === 'from-backup')
  assert.ok(added, '新菜不在列表里')
  assert.ok(added.imageBlob instanceof Blob, '新菜进来时图没跟着')
  assert.ok(rawById('from-backup').imageBuffer instanceof ArrayBuffer, '新菜的图没落库')
  assert.equal(store.getState().recipes.length, before + 1)
})
