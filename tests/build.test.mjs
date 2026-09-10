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
  const { window, root, errors } = await boot()

  assert.deepEqual(errors, [], '跑起来时抛了错')
  assert.equal(window.__handbookMounted, true, '应用没挂载上（看门狗会报「手账没能翻开」）')
  assert.ok(!root.innerHTML.includes('正在翻开手账'), '#root 还停在开屏文案上')
  assert.ok(root.innerHTML.includes('bookcover'), '#root 里没有应用外壳')
})

/**
 * 没有 createObjectURL 也要能起来。
 *
 * 起因：2026-09-10 给预置菜配上照片之后，上面那个用例突然开始失败 ——
 * 应用挂到一半就没了。真因是 `useObjectUrl` 里裸着调 `URL.createObjectURL`，
 * 而 useEffect 抛出的错会一路冒到根上，React 没有 error boundary 时会把
 * **整棵树**卸载：不是那道菜没图，是整个页面白掉。
 *
 * jsdom 恰好没实现这个 API，所以它天然就是那个「缺少 API 的环境」，
 * 一行都不用假装。真实的浏览器基本不会缺，但一张缩略图不该有这个杀伤力。
 *
 * 这条用例故意**不打桩**，就是要走「API 不在」的那条路。
 */
test('浏览器没有 createObjectURL 时，应用照常挂载（缩略图退成 emoji）', { skip }, async () => {
  const { window, root, errors } = await boot({ stubObjectUrl: false })

  assert.ok(
    typeof window.URL.createObjectURL === 'undefined',
    'jsdom 现在实现了这个 API，这条用例得换个办法造出「缺少 API」的环境',
  )
  assert.equal(window.__handbookMounted, true, '应用没挂载上')
  assert.ok(
    root.innerHTML.includes('bookcover'),
    '缺了 createObjectURL 就整个白屏了 —— 一张缩略图不该把应用干掉',
  )
  // 图没了但菜还在，卡片自己退成 emoji
  assert.ok(root.innerHTML.includes('recipe-card'), '菜谱卡片也没了，说明是整棵树被卸载了')
  assert.equal(errors.filter((e) => /createObjectURL/.test(e)).length, 0, '不该往外抛这个错')
})

/**
 * 把产物丢进 jsdom 跑起来，等 React 提交完，返回现场。
 * @param {{stubObjectUrl?: boolean}} options
 */
async function boot({ stubObjectUrl = true } = {}) {
  const { JSDOM, VirtualConsole } = await import('jsdom')
  const vc = new VirtualConsole()
  const errors = []
  vc.on('jsdomError', (e) => errors.push(e.message.split('\n')[0]))
  // React 的报错走 console.error，不是 jsdomError，不接就什么都看不见
  vc.on('error', (...args) => errors.push(args.map(String).join(' ').split('\n')[0]))

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://handbook.test/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    // 必须在解析之前铺好：入口脚本是被降到 <head> 的普通脚本，构造完就已经跑过了。
    // jsdom 不实现 createObjectURL，而预置菜现在带图，卡片一渲染就要用它 ——
    // 不打桩的话这里测的就不是「能不能挂载」，而是上面那条「缺了 API 也能挂载」了。
    beforeParse(window) {
      if (!stubObjectUrl) return
      window.URL.createObjectURL = () => 'blob:stub'
      window.URL.revokeObjectURL = () => {}
    },
  })
  const { window } = dom
  const root = window.document.getElementById('root')

  // 轮询等 React 把 DOM 提交上去。__handbookMounted 是 render() 之后同步置的，
  // 而 React 19 的首次提交是异步的 —— 只等那个标记会拿到空的 #root。
  // 第一次启动要播种 8 道菜（含图，走 localStorage 降级那条约 570KB JSON），
  // 给够预算；真要慢到这个数，说明是逻辑卡住了，不是机器慢。
  const done = () => window.__handbookMounted && root.innerHTML.includes('bookcover')
  for (let i = 0; i < 500 && !done(); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }

  return { window, root, errors }
}

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
