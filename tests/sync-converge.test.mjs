/**
 * 一次同步的编排（converge.ts）的测试。
 *
 * 这里用一个内存里的假服务器，把「版本撞车」这件事变得可复现 ——
 * 真实世界里两台设备同时推的窗口只有几十毫秒，靠手动测试根本撞不上，
 * 而这恰恰是最容易写错、错了又最难查的一段（表现是「两边数据偶尔对不上」，
 * 没有任何报错）。
 *
 * converge 不碰 fetch / localStorage / DOM，所以这些用例跑得很快。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src } from './_bundle.mjs'

const { converge } = await load(src('sync/converge.ts'))

function recipe(id, updatedAt, extra = {}) {
  return {
    id,
    name: `菜-${id}`,
    category: '家常热菜',
    ingredients: [],
    difficulty: '简单',
    emoji: '🍲',
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  }
}

/**
 * 内存假服务器。行为照着真服务端来：校验 baseRev，对不上就回 409
 * 并把当前那份数据一起给它。
 */
function fakeServer(initial = { recipes: [], menus: [] }, rev = 1) {
  let state = { rev, payload: initial }
  let pushes = 0
  /** 还差几次推送会撞车（Infinity = 永远撞） */
  let conflictsLeft = 0
  let conflictPayload = null

  return {
    transport: {
      async pull() {
        return { rev: state.rev, payload: state.payload }
      },
      async push(baseRev, payload) {
        pushes++
        if (conflictsLeft > 0) {
          conflictsLeft--
          // 模拟「这中间另一台设备推过」：服务端版本前进，数据也变了
          state = { rev: state.rev + 1, payload: conflictPayload ?? state.payload }
          return { ok: false, conflict: true, remote: state }
        }
        if (baseRev !== state.rev) return { ok: false, conflict: true, remote: state }
        state = { rev: state.rev + 1, payload }
        return { ok: true, rev: state.rev }
      },
    },
    get rev() {
      return state.rev
    },
    get payload() {
      return state.payload
    },
    get pushes() {
      return pushes
    },
    /** 让接下来 n 次推送都撞车，期间服务端的数据换成 conflictPayload */
    forceConflict(n, payload = null) {
      conflictsLeft = n
      conflictPayload = payload
    },
  }
}

/** 跑一次同步，本地数据是变量，writeLocal 会把它更新成合并结果。 */
async function runSync(server, local) {
  const box = { local }
  const result = await converge({
    transport: server.transport,
    readLocal: async () => box.local,
    writeLocal: async (p) => {
      box.local = p
    },
  })
  return { result, local: box.local }
}

test('两边都已经一致时不推送，一次网络请求就结束', async () => {
  const data = { recipes: [recipe('a', 100)], menus: [] }
  const server = fakeServer(data)
  const { result } = await runSync(server, data)

  assert.equal(server.pushes, 0, '没有任何变化却推了一次 —— 白白多一次请求')
  assert.equal(result.pushed, false)
  assert.equal(result.rounds, 1)
})

test('本地新增的菜会推上去', async () => {
  const server = fakeServer({ recipes: [], menus: [] })
  const { result } = await runSync(server, { recipes: [recipe('a', 100)], menus: [] })

  assert.equal(result.pushed, true)
  assert.deepEqual(
    server.payload.recipes.map((r) => r.id),
    ['a'],
  )
  assert.equal(server.rev, 2, '版本号没往前走')
})

test('云端有而本地没有的，拉下来；合完就没差别了，不必再推', async () => {
  const server = fakeServer({ recipes: [recipe('b', 200)], menus: [] })
  const { result, local } = await runSync(server, { recipes: [], menus: [] })

  assert.deepEqual(
    local.recipes.map((r) => r.id),
    ['b'],
    '本地没拿到云端的数据',
  )
  assert.equal(result.pushed, false)
  assert.equal(server.pushes, 0, '合并结果和云端一样，多推一次纯属浪费流量')
})

test('推送撞车了：拿对方最新的数据重来一轮，两边的改动都不丢', async () => {
  // 场景：本地加了 a，推的途中另一台设备已经把 b 推上去了
  const server = fakeServer({ recipes: [], menus: [] })
  server.forceConflict(1, { recipes: [recipe('b', 200)], menus: [] })

  const { result, local } = await runSync(server, { recipes: [recipe('a', 100)], menus: [] })

  assert.equal(result.rounds, 2, '没重试，直接放弃了')
  assert.equal(server.pushes, 2)
  assert.deepEqual(
    server.payload.recipes.map((r) => r.id).sort(),
    ['a', 'b'],
    '重试之后把本地那次改动丢了 —— 用户会觉得「我记的菜没了」',
  )
  assert.deepEqual(
    local.recipes.map((r) => r.id).sort(),
    ['a', 'b'],
    '本地没有收敛到和服务端一致',
  )
})

test('一直撞车也不会无限循环，有限次之后报错', async () => {
  const server = fakeServer({ recipes: [], menus: [] })
  server.forceConflict(Infinity, { recipes: [recipe('b', 200)], menus: [] })

  await assert.rejects(
    () => runSync(server, { recipes: [recipe('a', 100)], menus: [] }),
    /同时修改/,
    '没有把无限重试兜住 —— 手机流量和电量会被烧在一个转不出来的循环上',
  )
  assert.ok(server.pushes <= 6, `推了 ${server.pushes} 次，重试次数没有上限`)
})

test('推送失败前本地就已经对齐了（合并结果包含两边）', async () => {
  // 断网/口令过期时推送会抛错，但那次同步不该白跑 —— 本地已经拿到云端的数据了
  const server = fakeServer({ recipes: [recipe('b', 200)], menus: [] })
  const box = { local: { recipes: [recipe('a', 100)], menus: [] } }

  await assert.rejects(() =>
    converge({
      transport: {
        pull: () => server.transport.pull(),
        push: async () => {
          throw new Error('断网了')
        },
      },
      readLocal: async () => box.local,
      writeLocal: async (p) => {
        box.local = p
      },
    }),
  )

  assert.deepEqual(
    box.local.recipes.map((r) => r.id).sort(),
    ['a', 'b'],
    '推送失败连本地都没合上，这次同步等于完全白跑',
  )
})

test('过期的墓碑在推送时被清掉（云端文档不会一直长）', async () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 1_800_000_000_000
  const server = fakeServer({ recipes: [], menus: [] })

  const box = {
    local: {
      recipes: [
        recipe('old', now - 200 * DAY, { deletedAt: now - 200 * DAY }), // 删了两百天
        recipe('fresh', now - 1000, { deletedAt: now - 1000 }), // 刚删的
      ],
      menus: [],
    },
  }
  await converge({
    transport: server.transport,
    readLocal: async () => box.local,
    writeLocal: async (p) => {
      box.local = p
    },
    now: () => now,
  })

  assert.deepEqual(
    server.payload.recipes.map((r) => r.id),
    ['fresh'],
    '过期墓碑没清，云端的记录会越积越多',
  )
  assert.equal(server.payload.recipes[0].deletedAt, now - 1000, '新墓碑不能一起清掉，否则删除传不到别的设备')
})
