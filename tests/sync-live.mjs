/**
 * 打真实云函数的两设备联调。
 *
 * 【为什么单独一个文件，而且不叫 *.test.mjs】
 * `npm test` 必须能在**断网**的情况下全绿 —— 这是个离线优先的应用，
 * 测试却依赖公网服务，本身就说不通，而且云函数到期（体验版 6 个月）
 * 之后整个测试套件会跟着红掉，看起来像代码坏了。
 * 所以它是手动跑的：文件名叫 sync-live.mjs，不在 `*.test.mjs` 的收集范围里。
 *
 * 跑法（口令和地址从环境变量来，绝不写进文件 —— 这个文件要进公开仓库）：
 *
 *   MENU_SYNC_LIVE=1 \
 *   MENU_SYNC_URL='https://xxx.ap-shanghai.app.tcloudbase.com/sync' \
 *   MENU_PASS='口令' node tests/sync-live.mjs
 *
 * ⚠️ **会往云端那份文档里写测试菜**（红烧肉、番茄炒蛋这些）。
 * 所以 MENU_SYNC_LIVE=1 是必须的显式确认，而且别拿家里真实口令跑 ——
 * 跑完云端会留下几道测试菜，家里其他设备一同步就会拉到。
 * 正经用途是：新环境部署完、或者改过合并逻辑之后，验一遍这条链还是通的。
 *
 * 【它验的是什么】
 * 单元测试已经分别验过合并算法、重试循环、store 的写回。这里验的是中间那条缝：
 * 「客户端序列化出来的形状 → HTTP 请求头 → 服务端校验 → 乐观锁比对 → 解析回来」
 * 这条链上任何一处对不上（字段名、请求头、baseRev 语义、编码），
 * 单测全绿也照样同步不了。
 *
 * 【两台设备是怎么模拟的】
 * 一个进程里跑两份内存数据 + 两份真实的 converge/httpTransport。
 * 存储用内存数组替身（真实的那份 appStore 是模块级单例，一个进程里没法有两台设备，
 * 而 store 和 converge 之间的接缝已经由 sync-store.test.mjs 覆盖了）。
 * 合并、序列化、HTTP、重试用的都是**真代码**。
 */
import { load, src, stubLocalStorage } from './_bundle.mjs'

const URL_ = process.env.MENU_SYNC_URL
const PASS = process.env.MENU_PASS

if (!URL_ || !PASS) {
  console.log('跳过：需要 MENU_SYNC_URL 和 MENU_PASS 两个环境变量。')
  process.exit(0)
}
if (process.env.MENU_SYNC_LIVE !== '1') {
  console.log('跳过：这个脚本会往云端写测试菜，要跑请显式加上 MENU_SYNC_LIVE=1。')
  process.exit(0)
}
console.log('⚠️  正在往云端的真实文档里写测试数据（红烧肉等）。别拿家里真实口令跑。\n')

stubLocalStorage()
// 模块级会读 localStorage 拿配置，所以桩要先装好
const { converge } = await load(src('sync/converge.ts'))
const { httpTransport } = await load(src('sync/client.ts'))
const { toSyncPayload } = await load(src('sync/merge.ts'))

let failures = 0
function ok(label, cond, extra = '') {
  if (!cond) failures++
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
}

/**
 * 时间戳：从**真实当前时间**起算，每次加一。
 *
 * 别图省事从 1000 开始 —— converge 里会调 `pruneTombstones(…, Date.now())`，
 * 清掉超过 180 天的墓碑。而 1000 (1970 年) 在 Date.now() 眼里是几十亿毫秒前，
 * 于是每个墓碑一建出来就被判过期清掉，删除永远传不过去，
 * 看起来像「墓碑功能坏了」。基准必须是真实的现在。
 *
 * 用共享计数器而不是各自的时钟，是为了让 LWW 的胜负只由写入顺序决定 ——
 * 真实设备之间时钟会偏，那是另一个话题（家庭应用里几秒的偏差可以忽略）。
 */
let clock = Date.now()
const tick = () => ++clock

function makeDevice(name) {
  let records = []
  let menus = []
  return {
    name,
    get recipes() {
      return records.filter((r) => !r.deletedAt)
    },
    get raw() {
      return records
    },
    get menus() {
      return menus
    },
    /** 记一道新菜。字段照 appStore.createRecipe 的样子给。 */
    add(id, name_, extra = {}) {
      const stamp = tick()
      records.push({
        id,
        name: name_,
        category: '家常热菜',
        ingredients: [],
        steps: [],
        difficulty: 2,
        emoji: '🍽️',
        createdAt: stamp,
        updatedAt: stamp,
        ...extra,
      })
      return this
    },
    /** 改一道菜（模拟 updateRecipe：更新 updatedAt，撞车时靠它定胜负）。 */
    edit(id, patch) {
      const r = records.find((x) => x.id === id)
      Object.assign(r, patch, { updatedAt: tick() })
      return this
    },
    /** 删一道菜（模拟 deleteRecipes：软删除，留墓碑）。 */
    del(id) {
      const r = records.find((x) => x.id === id)
      const stamp = tick()
      r.updatedAt = stamp
      r.deletedAt = stamp
      return this
    },
    setMenu(date, items) {
      const stamp = tick()
      const i = menus.findIndex((m) => m.date === date)
      const menu = { date, items: [...items], updatedAt: stamp }
      if (i >= 0) menus[i] = menu
      else menus.push(menu)
      return this
    },
    sync() {
      return converge({
        transport: httpTransport({ url: URL_, pass: PASS }),
        readLocal: async () => toSyncPayload(records, menus),
        // 合并结果整体接管本地 —— 结果里本来就含了两边的内容
        writeLocal: async (payload) => {
          records = payload.recipes
          menus = payload.menus
        },
      })
    },
  }
}

const A = makeDevice('A（手机）')
const B = makeDevice('B（平板）')

/* ------------------------------------------------------------------ */

console.log('— 1. A 记一道菜，推上云 —')
A.add('r1', '红烧肉')
const s1 = await A.sync()
ok('A 推送成功', s1.pushed === true && s1.rev > 0, `rev=${s1.rev} rounds=${s1.rounds}`)

console.log('\n— 2. B 空库拉取 —')
const s2 = await B.sync()
ok('B 没有推送（云端已经包含 A 的数据）', s2.pushed === false, `rev=${s2.rev}`)
ok('B 拿到了 A 的菜', B.recipes.some((r) => r.id === 'r1' && r.name === '红烧肉'))
ok('B 的菜名没有被编码搞坏', B.recipes.find((r) => r.id === 'r1')?.name === '红烧肉')

console.log('\n— 3. B 记一道，A 再拉 —')
B.add('r2', '番茄炒蛋·少放盐')
await B.sync()
await A.sync()
ok('A 拿到 B 的菜（含中文与间隔号）', A.recipes.find((r) => r.id === 'r2')?.name === '番茄炒蛋·少放盐')
ok('A 自己那道还在', A.recipes.some((r) => r.id === 'r1'))

console.log('\n— 4. 两边真正同时同步（并发撞车，走 409 重试那条路）—')
A.edit('r1', { note: 'A 的改法' })
B.edit('r1', { note: 'B 的改法' }) // 时间戳更晚 → 应该赢
// 必须并发发起，才能让两边基于同一个 rev 各自推送、真的撞上。
// 串行 await 的话第二个早拿到新版本了，永远撞不上，409 那条路一次都走不到。
const [ra, rb] = await Promise.all([A.sync(), B.sync()])
await A.sync() // A 把 B 的最终结果拉回去
const winnerA = A.recipes.find((r) => r.id === 'r1')?.note
const winnerB = B.recipes.find((r) => r.id === 'r1')?.note
ok('两台设备对同一道菜的看法一致', winnerA === winnerB, `A="${winnerA}" B="${winnerB}"`)
ok('时间戳更晚的那次改动赢了（LWW）', winnerA === 'B 的改法', `实际是 "${winnerA}"`)
// 上面那次是概率性的：撞不上不算失败，但也不该假装测过了，如实报出来。
const raced = ra.rounds > 1 || rb.rounds > 1
console.log(`ℹ️ 第 1 轮并发：A rounds=${ra.rounds} B rounds=${rb.rounds}${raced ? '（撞上了）' : ''}`)

// 一次撞不上说明不了什么，多来几轮看**从来没撞过**还是只是这次赶巧。
// 如果几轮下来一次都不撞，那要么是本地时序天然错开了（无害），
// 要么是服务端把请求串行化了（那就会影响真实的两设备并发，值得知道）。
let collided = 0
for (let i = 1; i <= 4; i++) {
  A.edit('r1', { note: `A-${i}` })
  B.edit('r1', { note: `B-${i}` }) // B 的时间戳总是更晚 → 每轮都该是 B 赢
  const [x, y] = await Promise.all([A.sync(), B.sync()])
  if (x.rounds > 1 || y.rounds > 1) collided++
  await A.sync()
  await B.sync()
  const na = A.recipes.find((r) => r.id === 'r1')?.note
  const nb = B.recipes.find((r) => r.id === 'r1')?.note
  ok(`第 ${i + 1} 轮并发后两台设备仍然一致`, na === nb && na === `B-${i}`, `A="${na}" B="${nb}"`)
}
console.log(`ℹ️ 5 轮自然并发里真的撞上 ${collided} 轮（撞上才有机会走 409 重试；下面 4b 确定性地补上这条路）`)

// 撞车不能靠运气 —— 上面没撞上，409 那条路就等于没验。这里**确定性地**撞一次：
// 拿一个刚刚被消费掉的 rev 再推一次，服务端必须拒绝并回带它当前那份。
console.log('\n— 4b. 确定性的版本冲突（直接用真实传输层）—')
const t = httpTransport({ url: URL_, pass: PASS })
const cur = await t.pull()
const first = await t.push(cur.rev, cur.payload) // 先占掉这个版本号
const stalePush = await t.push(cur.rev, cur.payload) // 同一个 rev 再推 → 必冲突
ok('占版本成功', first.ok === true, `rev ${cur.rev}→${first.rev}`)
ok('过期 baseRev 被拒（409）', stalePush.ok === false && stalePush.conflict === true)
ok('409 回带的 rev 是服务端当前版本', stalePush.ok === false && stalePush.remote.rev === first.rev, `回带 rev=${stalePush.ok === false ? stalePush.remote.rev : '?'}，期望 ${first.rev}`)
ok('409 回带了当前数据（客户端不用再拉一次）', stalePush.ok === false && Array.isArray(stalePush.remote.payload.recipes))

console.log('\n— 5. 删除要能传过去（墓碑）—')
A.del('r2')
await A.sync()
await B.sync()
ok('A 本地已看不到 r2', !A.recipes.some((r) => r.id === 'r2'))
ok('B 那边也跟着没了（墓碑起作用）', !B.recipes.some((r) => r.id === 'r2'))
ok('墓碑本身还留在库里（否则会被别的设备复活）', B.raw.some((r) => r.id === 'r2' && r.deletedAt))

console.log('\n— 6. 再同步一轮不会把删掉的菜拉回来 —')
const s6 = await B.sync()
const s6a = await A.sync()
ok('B 第二轮没有改动要推', s6.pushed === false)
ok('A 第二轮也没有改动要推', s6a.pushed === false)
ok('r2 没有被复活', !A.recipes.some((r) => r.id === 'r2') && !B.recipes.some((r) => r.id === 'r2'))

console.log('\n— 7. 菜单同步 —')
A.setMenu('2026-09-10', ['r1'])
await A.sync()
await B.sync()
const menuB = B.menus.find((m) => m.date === '2026-09-10')
ok('菜单传过去了', !!menuB && menuB.items[0] === 'r1', JSON.stringify(menuB))

console.log('\n— 8. 收敛之后必须稳定（合并幂等，否则会永远互相推）—')
const f1 = await A.sync()
const f2 = await B.sync()
const f3 = await A.sync()
ok('A 稳定', f1.pushed === false, `rounds=${f1.rounds}`)
ok('B 稳定', f2.pushed === false, `rounds=${f2.rounds}`)
ok('A 再跑还是稳定', f3.pushed === false)
ok('两台设备最终状态完全一致', JSON.stringify(A.raw.map((r) => [r.id, r.name, r.updatedAt, r.deletedAt ?? null])) === JSON.stringify(B.raw.map((r) => [r.id, r.name, r.updatedAt, r.deletedAt ?? null])))

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
