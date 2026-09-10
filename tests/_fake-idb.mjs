/**
 * 一个小号假 IndexedDB，用来把真的 `IndexedDbDriver` 跑起来。
 *
 * 真机上**所有浏览器都走这条路**（localStorage 只是降级），但 Node 里没有
 * IndexedDB，所以任何「只测了 localStorage 那条路」的用例，等于没测到用户
 * 真正在跑的那条路。原先这份替身只长在 storage.test.mjs 里，现在提出来共用，
 * 让同步写回那条路也能在真形状的库上跑一遍。
 *
 * 两处必须照抄真实行为，否则测了也白测：
 * - **回调一律异步触发**。runRequest 是先 `make(store)` 建好请求、之后才挂
 *   request.onsuccess；同步触发的话回调还没挂上就丢了，测试直接挂死。
 * - **失败时的事件顺序**：request 先带上 error 并触发它的 onerror，接着事务的
 *   onerror（此刻 tx.error 仍是 null），最后事务 abort、tx.error 才有值。
 *   就是中间那一步把真正的原因吃掉的，这里必须一模一样地重演。
 *
 * 注意它也照抄了真实 IndexedDB 的一条关键语义：**`put` 是整条替换，不是字段合并**。
 * 「写回一条没有图片的记录会把图片抹掉」这件事，靠的就是这条语义 ——
 * 如果替身在这里做了合并，那整个同步的图片保护逻辑就测不出来了。
 * 还有 `getAll` 返回的是**结构化克隆**，所以测试里直接看 `data` 里的对象时，
 * 看到的是落库的那份（Blob 会被真 IDB 克隆，这里如实保存引用）。
 */
export function makeFakeIndexedDB({ failPuts = null } = {}) {
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
