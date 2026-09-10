/**
 * 存储层的回归测试，重点在**图片写入**这条路上。
 *
 * 起因：用户手机上换图报「写入失败」。那条消息是 storage.ts 自己兜底编的 ——
 * IndexedDB 的出错顺序是「request 先报错 → 冒泡到事务 → tx.onerror →
 * 事务 abort → tx.onabort」，而 tx.error 要到 abort 那一步才有值。
 * 原来写的是 `reject(tx.error ?? new Error('写入失败'))`，于是配额满、图太大、
 * iOS 存 Blob 失败……所有原因全被压成同一句话，等于没有信息，排查只能靠猜。
 *
 * 这个文件用一个小号假 IndexedDB 把真实的 IndexedDbDriver 跑起来，钉住两件事：
 *   1. 图片落库时是 ArrayBuffer（iOS/WKWebView 存 Blob 不可靠），读回来是 Blob；
 *      而且**老数据里直接存的 Blob 也照样读得出来**。
 *   2. 写失败时报的是真原因，不再是那句「写入失败」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubLocalStorage } from './_bundle.mjs'

/**
 * 只实现 storage.ts 用到的那点功能的 IndexedDB 替身。
 *
 * 两处必须照抄真实行为，否则测了也白测：
 * - **回调一律异步触发**。runRequest 是先 `make(store)` 建好请求、之后才挂
 *   request.onsuccess；同步触发的话回调还没挂上就丢了，测试直接挂死。
 * - **失败时的事件顺序**：request 先带上 error 并触发它的 onerror，接着事务的
 *   onerror（此刻 tx.error 仍是 null），最后事务 abort、tx.error 才有值。
 *   就是中间那一步把真正的原因吃掉的，这里必须一模一样地重演。
 */
function makeFakeIndexedDB({ failPuts = null } = {}) {
  const data = new Map() // storeName -> Map(key -> value)

  class FakeRequest {
    constructor() {
      this.result = undefined
      this.error = null
      this.onsuccess = null
      this.onerror = null
    }
  }

  function makeTransaction(nameOrNames) {
    const ops = []
    const tx = { error: null, oncomplete: null, onabort: null, onerror: null }

    tx.objectStore = (name) => {
      const add = (kind, extra) => {
        const request = new FakeRequest()
        ops.push({ request, kind, name, ...extra })
        return request
      }
      return {
        put: (value) => add('put', { value }),
        getAll: () => add('getAll'),
        delete: (id) => add('delete', { value: id }),
        clear: () => add('clear'),
      }
    }

    void nameOrNames
    queueMicrotask(() => {
      for (const op of ops) {
        if (op.kind === 'put' && failPuts) {
          const err = new DOMException('模拟写入失败', failPuts)
          op.request.error = err
          op.request.onerror?.({ target: op.request })
          tx.error = null // ← 关键：轮到 tx.onerror 时，原因还在 request 上
          tx.onerror?.({ target: op.request })
          tx.error = err
          tx.onabort?.({ target: op.request })
          return
        }
        const rows = data.get(op.name)
        if (op.kind === 'put') rows.set(op.value.id ?? op.value.date, op.value)
        else if (op.kind === 'getAll') op.request.result = [...rows.values()]
        else if (op.kind === 'delete') rows.delete(op.value)
        else if (op.kind === 'clear') rows.clear()
        op.request.onsuccess?.({ target: op.request })
      }
      tx.oncomplete?.()
    })

    return tx
  }

  const db = {
    objectStoreNames: { contains: (n) => data.has(n) },
    createObjectStore: (n) => {
      if (!data.has(n)) data.set(n, new Map())
    },
    transaction: (n) => makeTransaction(n),
    close: () => {},
  }

  globalThis.indexedDB = {
    open() {
      const req = new FakeRequest()
      req.result = db
      queueMicrotask(() => {
        req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }

  return { data }
}

const RECIPE = {
  id: 'r1',
  name: '番茄炒蛋',
  category: '家常热菜',
  ingredients: ['番茄', '鸡蛋'],
  difficulty: '简单',
  emoji: '🍅',
  note: '',
  createdAt: 1,
}

test('图片以 ArrayBuffer 落库，读回来还是能用的 Blob', async () => {
  stubLocalStorage()
  const fake = makeFakeIndexedDB()
  const { initStorage } = await load(src('db/storage.ts'))
  const { driver, mode } = await initStorage()
  assert.equal(mode, 'indexeddb', '假 IDB 应该被用上')

  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  await driver.putRecipes([{ ...RECIPE, imageBlob: new Blob([bytes], { type: 'image/jpeg' }) }])

  const [raw] = [...fake.data.get('recipes').values()]
  assert.ok(raw.imageBuffer instanceof ArrayBuffer, '落库的应该是 ArrayBuffer')
  assert.equal(raw.imageBlob, undefined, '不该把 Blob 直接存进去 —— iOS/WKWebView 上不可靠')
  assert.equal(raw.imageType, 'image/jpeg', 'MIME 要一起存，读回来才好还原')

  const [got] = await driver.getAllRecipes()
  assert.ok(got.imageBlob instanceof Blob, '读回来要是 Blob，组件直接拿去当图用')
  assert.equal(got.imageBlob.type, 'image/jpeg')
  assert.deepEqual([...new Uint8Array(await got.imageBlob.arrayBuffer())], [...bytes])
  assert.equal(got.name, '番茄炒蛋', '其余字段不能丢')
})

test('老数据里直接存的 Blob 仍然读得出来（换了写法不能读不了旧库）', async () => {
  stubLocalStorage()
  const fake = makeFakeIndexedDB()
  const { initStorage } = await load(src('db/storage.ts'))
  const { driver } = await initStorage()

  fake.data.get('recipes').set('r1', {
    ...RECIPE,
    imageBlob: new Blob([new Uint8Array([9, 9])], { type: 'image/png' }),
  })

  const [got] = await driver.getAllRecipes()
  assert.ok(got.imageBlob instanceof Blob, '旧格式的 Blob 读不出来就糟了')
  assert.deepEqual([...new Uint8Array(await got.imageBlob.arrayBuffer())], [9, 9])
})

test('写入失败时报出真原因，不再是那句没用的「写入失败」', async () => {
  stubLocalStorage()
  makeFakeIndexedDB({ failPuts: 'QuotaExceededError' })
  const { initStorage, StorageQuotaError } = await load(src('db/storage.ts'))
  const { driver } = await initStorage()

  await assert.rejects(
    () => driver.putRecipes([{ ...RECIPE }]),
    (err) => {
      assert.ok(!/写入失败$/.test(err.message), `还是那句没信息的老话：${err.message}`)
      assert.ok(err instanceof StorageQuotaError, `配额错误要单独分类，实际是 ${err.name}`)
      assert.match(err.message, /存储空间/, '要告诉用户是空间不够了')
      return true
    },
  )
})

test('非配额的写入失败也要带上错误名', async () => {
  stubLocalStorage()
  makeFakeIndexedDB({ failPuts: 'UnknownError' })
  const { initStorage } = await load(src('db/storage.ts'))
  const { driver } = await initStorage()

  await assert.rejects(
    () => driver.putRecipes([{ ...RECIPE }]),
    (err) => {
      assert.match(err.message, /UnknownError/, `错误名丢了，排查时又只能猜：${err.message}`)
      return true
    },
  )
})
