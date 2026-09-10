/**
 * 跨设备同步的云端部分。
 *
 * 【它有多小是故意的】
 * 这个函数只做三件事：核对口令、存一份数据、比对版本号。**合并逻辑一点都没有** ——
 * 合并全在各自的手机上算（见 src/sync/merge.ts）。这样：
 *   · 服务端简单到几乎没有出错的余地；
 *   · 两台设备跑的是同一份合并算法，不存在「改了一边忘另一边」；
 *   · 服务器上躺的是明文菜谱，但它本来就只是个中转站，不参与任何决策。
 *
 * 【为什么是 HTTP 云函数而不是事件函数】
 * 两者写法完全不通用。HTTP（Web）函数必须 http.createServer 并**监听 9000 端口**，
 * 还需要一个没有扩展名的 scf_bootstrap。写成 exports.main 的话进程里没有服务
 * 在监听，网关只会拿到超时。
 *
 * 【配置全靠环境变量，代码里不写死任何秘密】
 *   MENU_PASS_SHA256  家族口令的 sha256 十六进制。存哈希不存明文：
 *                     函数配置容易被看到（截图、日志、控制台），
 *                     存明文等于把那句口令直接摊开。
 *   TCB_ENV           环境 ID（公开信息，写死也行）
 */

const http = require('node:http')
const crypto = require('node:crypto')
const tcb = require('@cloudbase/node-sdk')

const PORT = 9000 // CloudBase HTTP 云函数的硬性要求
const HOST = '0.0.0.0'

const COLLECTION = 'menu_sync'
const DOC_ID = 'family'

/**
 * 请求体上限。家庭菜谱库（不含图片）通常几十 KB，给到 2MB 是极宽松的余量。
 * 有上限是为了：口令万一泄露，作恶的人也没法拿这个库当免费网盘用。
 */
const MAX_BODY = 2 * 1024 * 1024

const ENV_ID = process.env.TCB_ENV || 'xyxx-d8gphvdlh0cac3968'
const PASS_HASH = (process.env.MENU_PASS_SHA256 || '').toLowerCase()

const app = tcb.init({ env: ENV_ID })
const db = app.database()

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let tooBig = false
    req.on('data', (chunk) => {
      if (tooBig) return
      raw += chunk
      if (raw.length > MAX_BODY) {
        tooBig = true
        raw = ''
        req.destroy()
      }
    })
    req.on('end', () => resolve(tooBig ? null : raw))
    req.on('error', () => resolve(null))
  })
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 口令比对。
 *
 * 用 timingSafeEqual 而不是 `===`：字符串比较会在第一个不同的字符处返回，
 * 比较耗时随「猜对了几个字符」变化，理论上能被用来一位一位地试出口令。
 * 家庭应用里这属于过度小心，但代价是一行代码。
 *
 * 两边长度不等时直接判否 —— timingSafeEqual 遇到长度不同的输入会抛异常。
 */
function passMatches(provided) {
  if (!PASS_HASH) return false
  if (typeof provided !== 'string' || !provided) return false
  const a = Buffer.from(sha256Hex(provided), 'utf8')
  const b = Buffer.from(PASS_HASH, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function corsHeaders(origin) {
  // 回显 Origin 而不用 `*`。口令走的是自定义请求头而不是 Cookie，
  // 所以别的网站就算能发请求也拿不到我们 localStorage 里的口令，
  // 真正的门是口令本身；这里回显只是为了让浏览器放行。
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    // 必须把我们自己的头名列出来，否则浏览器预检就把请求拦下了
    'access-control-allow-headers': 'content-type,x-menu-pass',
    'access-control-max-age': '86400',
    vary: 'Origin',
  }
}

function send(res, status, body, origin) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    ...corsHeaders(origin),
  })
  res.end(json)
}

/**
 * 严格校验客户端推上来的数据。
 *
 * 只认形状不认内容 —— 内容对不对是客户端合并算法的事。这里挡住的是
 * 「有人拿口令往库里塞别的东西」。
 */
function validPayload(p) {
  if (!p || typeof p !== 'object') return false
  if (!Array.isArray(p.recipes) || !Array.isArray(p.menus)) return false
  if (p.recipes.length > 5000 || p.menus.length > 5000) return false
  return true
}

/* ------------------------------------------------------------------ */
/* 数据存取                                                            */
/* ------------------------------------------------------------------ */

const EMPTY = { recipes: [], menus: [] }

async function readDocOnce() {
  const res = await db.collection(COLLECTION).doc(DOC_ID).get()
  const doc = Array.isArray(res.data) ? res.data[0] : res.data
  if (!doc) return { rev: 0, payload: EMPTY }
  return {
    rev: typeof doc.rev === 'number' ? doc.rev : 0,
    payload: validPayload(doc.payload) ? doc.payload : EMPTY,
  }
}

/**
 * 读当前那份。
 *
 * 【为什么读不出来时**不能**当成空库】
 * 这里踩过一个坑：早先的写法是 catch 住任何异常都 `return {rev:0, payload:EMPTY}`，
 * 理由是「新环境下集合还不存在」。但「集合不存在」和「数据库临时抽风」在代码里
 * 长得一模一样，一律当成空的，等于把一个**假的、比真库更旧的版本**告诉客户端：
 * 客户端会拿它去合并，然后推回来。乐观锁能挡住覆盖（baseRev=0 时 add 会因 _id
 * 冲突失败），数据不会丢 —— 但用户看到的是一个莫名其妙的冲突或者 500，而不是
 * 「云端暂时读不了」。数据没坏，可**判断错了**，这种错最难查。
 *
 * 所以：先试着把集合建出来（新环境第一次用，这一步就够了），再读一遍；
 * 还是读不到就如实抛出去，让客户端看到「服务器出错了」，而不是「云端是空的」。
 */
async function readDoc() {
  try {
    return await readDocOnce()
  } catch {
    // 集合不存在时建一次。已经存在的话这里也会抛，忽略即可 ——
    // 紧接着的那次重读会给出真正的答案。
    try {
      await db.createCollection(COLLECTION)
    } catch {
      /* 已存在（或者这个 SDK 没有这个方法），都不影响下一步 */
    }
    try {
      return await readDocOnce()
    } catch (err) {
      throw new Error(`读取失败：${errDetail(err)}`)
    }
  }
}

/**
 * 带着版本号写入 —— 这就是乐观锁。
 *
 * 关键在于「比对版本号」和「写入」必须是**同一次操作**。先读出来判断
 * `doc.rev === baseRev`、再另外发一条更新，两条之间另一台设备完全可以插进来,
 * 两边都判断通过、都写成功，后写的把先写的覆盖掉，而且双方都以为同步成功了。
 * 所以这里用 `where({rev: baseRev}).update(...)`，判断条件在服务端一次完成。
 */
async function writeDoc(baseRev, payload) {
  const now = Date.now()
  const nextRev = baseRev + 1

  if (baseRev === 0) {
    // 首次写入：直接建文档。已经存在说明别人抢先了 → _id 冲突 → 冲突
    try {
      await db.collection(COLLECTION).add({ _id: DOC_ID, rev: 1, payload, updatedAt: now })
      return { ok: true, rev: 1 }
    } catch (err) {
      console.log('[sync] 首次写入失败：', err && err.message)
      return { ok: false, reason: 'create-failed', detail: errDetail(err) }
    }
  }

  const res = await db
    .collection(COLLECTION)
    .where({ _id: DOC_ID, rev: baseRev })
    .update({ rev: nextRev, payload, updatedAt: now })

  // updated === 0 表示条件没匹配上 —— 版本已经被人推过了
  if (res && res.updated === 1) return { ok: true, rev: nextRev }
  return { ok: false, reason: 'conflict' }
}

/**
 * 错误摘要。这个环境**没开日志服务**（`tcb fn log` 直接回 topic not exist），
 * 出了错在本地完全看不到原因，所以只能把摘要放进响应里。反正响应只发给
 * 已经通过口令校验的人，而里面只有数据库的错误名和一句话，不含任何菜谱内容。
 */
function errDetail(err) {
  if (!err) return 'unknown'
  return `${err.code || err.name || 'Error'}: ${err.message || String(err)}`
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || null

  // 预检不校验口令：浏览器发 OPTIONS 时不带自定义头，校验必然失败，
  // 那样所有请求都会被挡在门外，看起来像「跨域没配好」。
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin))
    res.end()
    return
  }

  if (!PASS_HASH) {
    console.error('[sync] 没有配置 MENU_PASS_SHA256，拒绝所有请求')
    send(res, 500, { ok: false, error: 'server-unconfigured' }, origin)
    return
  }

  if (!passMatches(req.headers['x-menu-pass'])) {
    // 只记「有人试过」，绝不记口令本身
    console.warn('[sync] 口令不对，来自', req.headers['x-forwarded-for'] || '未知来源')
    send(res, 401, { ok: false, error: 'bad-pass' }, origin)
    return
  }

  try {
    if (req.method === 'GET') {
      const { rev, payload } = await readDoc()
      send(res, 200, { ok: true, rev, payload }, origin)
      return
    }

    if (req.method === 'POST') {
      const raw = await readBody(req)
      if (raw === null) {
        send(res, 413, { ok: false, error: 'too-large' }, origin)
        return
      }

      let body
      try {
        body = JSON.parse(raw)
      } catch {
        send(res, 400, { ok: false, error: 'bad-json' }, origin)
        return
      }

      const baseRev = typeof body.baseRev === 'number' && body.baseRev >= 0 ? body.baseRev : -1
      if (baseRev < 0 || !validPayload(body.payload)) {
        send(res, 400, { ok: false, error: 'bad-request' }, origin)
        return
      }

      const result = await writeDoc(baseRev, body.payload)
      if (result.ok) {
        send(res, 200, { ok: true, rev: result.rev }, origin)
        return
      }
      if (result.reason !== 'conflict') {
        send(res, 500, { ok: false, error: 'server-error', detail: result.detail }, origin)
        return
      }

      // 撞车：把当前那份一起回给客户端，它拿回去重新合一轮就不用再多请求一次
      const current = await readDoc()
      send(res, 409, { ok: false, error: 'conflict', rev: current.rev, payload: current.payload }, origin)
      return
    }

    send(res, 405, { ok: false, error: 'method-not-allowed' }, origin)
  } catch (err) {
    console.error('[sync] 处理请求出错：', err)
    send(res, 500, { ok: false, error: 'server-error', detail: errDetail(err) }, origin)
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[sync] listening on http://${HOST}:${PORT}，环境 ${ENV_ID}`)
})
