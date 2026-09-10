/**
 * 构建产物的回归测试。
 *
 * 这个文件的存在理由：微信 iOS 里点开本地 html 一直停在开屏页，
 * 排查半天才发现内联脚本是 `<script type="module">` —— 不透明源的文档里
 * WebKit 拒绝执行 module 脚本，HTML 渲染了但 JS 一行没跑。
 * 这类故障在桌面上完全复现不出来，只有真的在微信里点开才暴露，
 * 所以用断言把它钉住：产物里不许再出现 module 脚本。
 *
 * dist 不存在时整个文件跳过（跑测试不该强制先构建）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist/index.html')
const built = fs.existsSync(DIST)
const html = built ? fs.readFileSync(DIST, 'utf8') : ''
const skip = built ? false : '还没有 dist/index.html，先跑 npm run build'

test('产物里没有 module 脚本（微信/不透明源下会整包不执行）', { skip }, () => {
  assert.ok(!/type=["']module["']/.test(html), '出现了 type="module"，微信里会白屏')
  assert.ok(!/import\.meta/.test(html), '出现了 import.meta，普通脚本里会语法报错')
  // 内联脚本要能被当成普通脚本解析
  for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new vm.Script(code), '内联脚本不是合法的普通脚本')
  }
})

test('应用是自包含的：没有任何外部 script / stylesheet 引用', { skip }, () => {
  for (const [, tag] of html.matchAll(/<(script|link)\b[^>]*>/g)) {
    const src = /\b(?:src|href)=["']([^"']*)["']/.exec(tag)
    if (!src) continue
    const url = src[1]
    if (url.startsWith('data:') || url.startsWith('./') || url.startsWith('#')) continue
    assert.fail(`引用了外部资源：${url}`)
  }
})

test('挂载点、启动看门狗、挂载信标都在', { skip }, () => {
  assert.ok(html.includes('id="root"'), '缺 #root 挂载点')
  assert.ok(html.includes('id="boot"'), '缺首屏兜底文案')
  assert.ok(html.includes('__handbookMounted'), '缺挂载信标，看门狗会误报')
  assert.ok(html.includes('手账没能翻开'), '缺启动失败提示，出错时用户看不到原因')
})

test('把产物真的跑起来，应用能挂载上（不是停在开屏页）', { skip }, async () => {
  // 这个测试的由来：入口脚本被 Vite 提到了 <head>，而它已经被降级成普通
  // 脚本（没有 module 的 defer 语义），于是在 <body> 之前同步执行，
  // getElementById('root') 拿到 null，应用挂在第一行。
  //
  // **前面所有断言都发现不了它**：产物里确实没有 type="module"，确实是自包含的，
  // 启动看门狗确实在 —— 每一条都通过。只有真的把 JS 执行一遍才看得出来。
  const { JSDOM, VirtualConsole } = await import('jsdom')
  const vc = new VirtualConsole()
  const errors = []
  vc.on('jsdomError', (e) => errors.push(e.message.split('\n')[0]))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://handbook.test/',
    pretendToBeVisual: true,
    virtualConsole: vc,
  })
  const { window } = dom
  const root = window.document.getElementById('root')

  // 轮询等 React 把 DOM 提交上去。__handbookMounted 是 render() 之后同步置的，
  // 而 React 19 的首次提交是异步的 —— 只等那个标记会拿到空的 #root。
  const done = () => window.__handbookMounted && root.innerHTML.includes('bookcover')
  for (let i = 0; i < 300 && !done(); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }

  assert.deepEqual(errors, [], '跑起来时抛了错')
  assert.equal(window.__handbookMounted, true, '应用没挂载上（看门狗会报「手账没能翻开」）')
  assert.ok(!root.innerHTML.includes('正在翻开手账'), '#root 还停在开屏文案上')
  assert.ok(root.innerHTML.includes('bookcover'), '#root 里没有应用外壳')
})

test('Service Worker 的缓存名带上了构建哈希', { skip }, () => {
  const sw = path.join(ROOT, 'dist/sw.js')
  assert.ok(fs.existsSync(sw), 'dist 里没有 sw.js')
  const code = fs.readFileSync(sw, 'utf8')

  // 占位符没被替换掉，说明 stampServiceWorker() 没跑
  assert.ok(!code.includes('__BUILD_HASH__'), 'sw.js 里的 __BUILD_HASH__ 占位符没被替换')

  // 缓存名必须随 index.html 的内容变。写死成 'family-menu-v1' 那种的话，
  // sw.js 字节永远不会变 → 浏览器不重装 SW → activate 不跑 → 旧的
  // index.html 永远留在缓存里，装过应用的人再也看不到新版本。
  const m = /const CACHE = '([^']+)'/.exec(code)
  assert.ok(m, 'sw.js 里找不到 CACHE 常量')
  const expected = createHash('sha256').update(html).digest('hex').slice(0, 10)
  assert.equal(
    m[1],
    `family-menu-${expected}`,
    '缓存名和当前 index.html 的内容对不上，构建后忘了重新打哈希',
  )
})

test('PWA 元信息齐全（添加到主屏幕要用）', { skip }, () => {
  assert.ok(html.includes('rel="manifest"'))
  assert.ok(html.includes('apple-mobile-web-app-capable'))
  assert.ok(html.includes('apple-touch-icon'))
  assert.ok(html.includes('viewport-fit=cover'), '缺 viewport-fit=cover，刘海会挡内容')
})
