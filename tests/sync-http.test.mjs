/**
 * 同步的 HTTP 层（client.ts 里的 httpTransport）的测试。
 *
 * 钉两件事：
 *   1. 云端返回的东西认不出来时**必须报错，绝不能当成空数据** ——
 *      当成空的话客户端会开开心心地把「空」合并进去再推回云端，
 *      一次返回格式出错就足以把全家人的菜谱清空。
 *   2. 各种失败状态码要翻译成人话。「401」对用户没有任何意义，
 *      「家族口令不对」才有。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src, stubLocalStorage } from './_bundle.mjs'

stubLocalStorage()
const { httpTransport, SyncError } = await load(src('sync/client.ts'))

const CFG = { url: 'https://example.test/sync', pass: '家里的口令' }

/** 把 fetch 换成一次性替身，返回指定的状态码和 body。 */
function stubFetch(status, body, sink = {}) {
  globalThis.fetch = async (url, init) => {
    sink.url = url
    sink.init = init
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    }
  }
  return sink
}

const PAYLOAD = { recipes: [{ id: 'a', name: '菜', createdAt: 1, updatedAt: 1 }], menus: [] }

test('正常拉取：拿到版本号和数据', async () => {
  stubFetch(200, { ok: true, rev: 7, payload: PAYLOAD })
  const remote = await httpTransport(CFG).pull()
  assert.equal(remote.rev, 7)
  assert.equal(remote.payload.recipes[0].id, 'a')
})

test('口令走请求头，绝不进 URL（URL 会进日志和浏览器历史）', async () => {
  const sink = stubFetch(200, { ok: true, rev: 1, payload: PAYLOAD })
  await httpTransport(CFG).pull()

  assert.equal(sink.init.headers['x-menu-pass'], '家里的口令')
  assert.equal(sink.url.includes('家里的口令'), false, '口令出现在 URL 里了')
  assert.equal(sink.url.includes('pass'), false)
})

test('云端返回的格式认不出来时抛错', async () => {
  for (const bad of [null, {}, { recipes: 'nope', menus: [] }, { recipes: [], menus: 3 }]) {
    stubFetch(200, { ok: true, rev: 1, payload: bad })
    await assert.rejects(
      () => httpTransport(CFG).pull(),
      (err) => {
        assert.ok(err instanceof SyncError, `${JSON.stringify(bad)} 没被拦住`)
        assert.equal(err.code, 'bad-remote')
        return true
      },
      `${JSON.stringify(bad)} 被当成正常数据了 —— 那样会把空数据推回云端，清空全家菜谱`,
    )
  }
})

test('推送撞车（409）时把对方当前那份数据带回来', async () => {
  stubFetch(409, { ok: false, error: 'conflict', rev: 9, payload: { recipes: [], menus: [] } })
  const result = await httpTransport(CFG).push(3, PAYLOAD)

  assert.equal(result.ok, false)
  assert.equal(result.conflict, true)
  assert.equal(result.remote.rev, 9, '拿不到对方版本号就没法重新合一轮')
})

test('409 但对方数据格式也不对时，同样不许继续', async () => {
  stubFetch(409, { ok: false, rev: 9, payload: 'garbage' })
  await assert.rejects(
    () => httpTransport(CFG).push(3, PAYLOAD),
    (err) => err instanceof SyncError && err.code === 'bad-remote',
  )
})

test('口令不对：说人话，并且标上 bad-pass（界面上不必再重试）', async () => {
  stubFetch(401, { ok: false, error: 'bad-pass' })
  await assert.rejects(
    () => httpTransport(CFG).pull(),
    (err) => {
      assert.equal(err.code, 'bad-pass')
      assert.match(err.message, /口令/, `用户看到的是「${err.message}」，他不知道该改什么`)
      return true
    },
  )
})

test('地址填错（404）时提示指向设置里的地址，而不是网络问题', async () => {
  stubFetch(404, '')
  await assert.rejects(
    () => httpTransport(CFG).pull(),
    (err) => {
      assert.equal(err.code, 'not-found')
      assert.match(err.message, /地址/)
      return true
    },
  )
})

test('云端 5xx 归类成「稍后重试」，不吓唬用户', async () => {
  stubFetch(502, '')
  await assert.rejects(
    () => httpTransport(CFG).pull(),
    (err) => err instanceof SyncError && err.code === 'server',
  )
})

test('连不上时说网络问题', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }
  await assert.rejects(
    () => httpTransport(CFG).pull(),
    (err) => {
      assert.equal(err.code, 'network')
      assert.match(err.message, /网络/)
      return true
    },
  )
})

test('推送成功时返回新版本号', async () => {
  stubFetch(200, { ok: true, rev: 12 })
  const result = await httpTransport(CFG).push(11, PAYLOAD)
  assert.deepEqual(result, { ok: true, rev: 12 })
})

test('服务端没给版本号时也能兜住（不至于让整个同步崩掉）', async () => {
  stubFetch(200, { ok: true })
  const pushed = await httpTransport(CFG).push(11, PAYLOAD)
  assert.equal(pushed.ok, true)
  assert.equal(pushed.rev, 12, '至少要比 baseRev 大，否则下次推送会一直撞车')
})
