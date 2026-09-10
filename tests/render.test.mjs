/**
 * 外壳渲染冒烟测试。
 *
 * 起因：换皮时新加的封面组件本来叫 `.cover`，而编辑器的大图区域早就占用了
 * 这个类名 —— 两个规则互相覆盖，`tsc` 和构建都不会报错，只有真的把页面
 * 渲染出来才看得出来。这个文件就是干这个的：在 jsdom 里把 App 挂起来，
 * 断言新外壳的关键结构确实在 DOM 里。
 *
 * 覆盖范围刻意保持「外壳」级别：封面、标签栏、纸面、页脚、三个页签。
 * 交互细节（长按、返回键、键盘）jsdom 里测不了，别在这里假装测了。
 *
 * 两个坑，写在这里省得下次再踩：
 * 1. react / react-dom 必须显式 external。Vite 的 lib 模式默认把依赖打进去，
 *    不 external 的话产物里会有一份自己的 React，和测试里 import 的那份不是
 *    同一个实例，一渲染就是 Invalid hook call。
 * 2. 不要用 react 的 act()。Vite 构建会把 NODE_ENV 置成 production，React 的
 *    CJS 入口据此载入 react.production.js 并被 Node 的模块缓存记住 —— 之后的
 *    import('react') 拿到的就是这份，而 act 是 dev 专属的，会是 undefined。
 *    直接 render + 轮询等 store 落定，比跟它较劲简单。
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, 'tests/.tmp')
const BUNDLE = path.join(TMP, 'app.mjs')

let App
let createElement
let createRoot

before(async () => {
  // ---- 1. 把 App.tsx 编成一个能 import 的 ESM 文件 ----
  // 写在项目目录里（不是系统临时目录），这样 react 这些裸包名能正常解析到。
  const out = await build({
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    plugins: [react()],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(ROOT, 'src/App.tsx'),
        formats: ['es'],
        fileName: 'app',
      },
      rollupOptions: {
        external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
      },
    },
  })
  const code = out[0].output[0].code
  assert.ok(/from\s*"react"/.test(code), 'React 没被 external，产物里会有第二份 React')
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(BUNDLE, code, 'utf8')

  // ---- 2. 搭一个 jsdom 环境，并把 App 里会用到的浏览器 API 补上 ----
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'https://handbook.test/', pretendToBeVisual: true },
  )

  // 浏览器里这些是 window 的属性，所以裸写就能用；Node 里得手动铺到 global 上
  const g = globalThis
  g.window = dom.window
  g.document = dom.window.document
  for (const key of [
    'navigator',
    'location',
    'history',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'matchMedia',
    'scrollTo',
    // URL 必须一起换掉。jsdom 的 URL 和 Node 的 URL 是两个对象，
    // 应用里裸写 URL.createObjectURL(...) 拿到的是 Node 那份 —— 它只认 Node 的
    // Blob，喂进去一个 jsdom 的 File 会直接 ERR_INVALID_ARG_TYPE。
    // （以前没有带图的菜谱渲染出来，所以一直没暴露。）
    'URL',
  ]) {
    if (!(key in dom.window)) continue
    Object.defineProperty(g, key, {
      value: typeof dom.window[key] === 'function' && key === 'getComputedStyle'
        ? dom.window[key].bind(dom.window)
        : dom.window[key],
      configurable: true,
      writable: true,
    })
  }

  // jsdom 没有 IndexedDB，正好走「降级到 localStorage」那条路
  g.localStorage = dom.window.localStorage

  // useObjectUrl 会调它；jsdom 不实现
  if (!dom.window.URL.createObjectURL) {
    dom.window.URL.createObjectURL = () => 'blob:stub'
    dom.window.URL.revokeObjectURL = () => {}
  }

  const [reactMod, domClient, appMod] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import(pathToFileURL(BUNDLE).href),
  ])
  createElement = reactMod.createElement
  createRoot = domClient.createRoot
  App = appMod.App
})

/** 上一个挂载的 root，下一次 mountApp 之前先卸掉。 */
let currentRoot = null

/**
 * 挂载 App，等 store 初始化（异步探测 IndexedDB → 降级 → 播种）落定。
 * 轮询而不是死等固定轮数：机器快就快，慢也不会假阴性。
 */
async function mountApp() {
  const container = document.getElementById('root')
  // 先把上一个 root 卸掉再清容器。直接 innerHTML='' 的话 React 手上还攥着
  // 旧的父子指针，之后一提交就报 "The node to be removed is not a child of this node"。
  // （以前的用例只是看看 HTML，不点任何东西，所以一直没触发。）
  currentRoot?.unmount()
  container.innerHTML = ''
  const root = createRoot(container)
  currentRoot = root
  root.render(createElement(App))

  for (let i = 0; i < 100; i++) {
    if (container.innerHTML.includes('bookcover')) break
    await new Promise((r) => setTimeout(r, 10))
  }
  return container.innerHTML
}

/** 让 React 把一次点击引发的状态更新提交完（离散事件是同步 flush，等一个宏任务足够）。 */
async function settle() {
  await new Promise((r) => setTimeout(r, 0))
}

test('外壳能挂载，并且画出了封面 / 标签栏 / 纸面 / 页脚', async () => {
  assert.ok(App, 'App 没能从打包产物里导出来')

  const html = await mountApp()

  // 启动态没有被卡住（ready 为 false 时只有 #boot）
  assert.ok(!html.includes('正在翻开手账'), 'store 没初始化完，App 停在开屏态')

  assert.ok(html.includes('bookcover'), '缺封面')
  assert.ok(html.includes('dateline'), '封面缺日期便签')
  assert.ok(html.includes('class="tabbar"'), '缺标签栏')
  assert.ok(html.includes('class="book"'), '缺纸面容器')
  assert.ok(html.includes('class="footer"'), '缺页脚')
  assert.ok(html.includes('class="wrap"'), '缺居中容器')
})

test('三个页签是菜谱本 / 今日菜单 / 抽签点菜，设置不在里面', async () => {
  const html = await mountApp()

  for (const label of ['菜谱本', '今日菜单', '抽签点菜']) {
    assert.ok(html.includes(label), `标签栏缺「${label}」`)
  }

  // 设置挪到页脚了，不该再占一个页签
  const tabbar = /<nav class="tabbar"[\s\S]*?<\/nav>/.exec(html)
  assert.ok(tabbar, '抓不到标签栏')
  assert.ok(!tabbar[0].includes('设置'), '设置还留在标签栏里')
  assert.ok(html.includes('设置'), '页脚缺设置入口')
})

test('封面用的不是编辑器那个 .cover 类名（两个规则会互相覆盖）', async () => {
  const html = await mountApp()

  // .cover 是编辑器/详情页的大图区域，封面必须避开它
  assert.ok(!/class="cover"/.test(html), '封面用了 .cover，会和编辑器的大图区域打架')
  assert.ok(html.includes('bookcover'), '封面应该用 .bookcover')
})

test('预置菜渲染成了卡片：有胶带、有分类标签、难度是星星', async () => {
  const html = await mountApp()

  assert.ok(html.includes('recipe-card'), '没渲染出菜谱卡片')
  assert.ok(html.includes('class="tape'), '卡片缺胶带装饰')
  assert.ok(html.includes('data-cat='), '卡片缺分类标签')
  assert.ok(html.includes('class="stars"'), '难度没画成星星')
  // 分类标签贴在缩略图里，不是堆在下面的 meta 行
  assert.ok(
    /class="recipe-thumb[^"]*"[\s\S]*?data-cat=/.test(html),
    '分类标签应该贴在 .recipe-thumb 里',
  )
})

/**
 * 换图：文件选择器必须一直挂在文档上。
 *
 * 起因：用户报「无法更换菜品图片」—— 选完照片什么也没发生。
 * 真因不在压缩、不在存储，而在 DOM：点「从相册选」是先 input.click()
 * 再关弹层，而 BottomSheet 是 `if (!open) return null`，于是系统选择器刚弹出来，
 * 承载它的 `<input type=file>` 就被 React 卸载了。原生 change 事件对游离节点
 * 照样触发（在 input 上直接 addEventListener 收得到），但 React 17+ 把事件
 * 委托挂在根容器上，脱离文档的节点冒泡不到那儿 —— onChange 一次都不跑。
 * 所以这个测试盯的不是「有没有提示」，而是「input 还在不在文档里」，
 * 最后再真的派发一次 change，确认整条链路通到卡片上。
 *
 * 顺带一提：设置页的「导入」一直没事，因为它走 lib/io.ts 的 pickFile ——
 * 自己 addEventListener，用完才把节点摘掉。
 */
test('换图：选完文件后 input 仍挂在文档上（否则 React 收不到 change）', async () => {
  const container = document.getElementById('root')
  await mountApp()

  // 走用户点出来的那条路：卡片「···」→ 换图
  container.querySelector('.card-more').click()
  await settle()
  const entry = [...document.querySelectorAll('.sheet-item')].find((b) =>
    b.textContent.includes('换图'),
  )
  assert.ok(entry, '操作单里没有「换图」')
  entry.click()
  await settle()

  const input = document.querySelector('input[type="file"]:not([capture])')
  assert.ok(input, '换图弹层里没有从相册选图的 input')
  assert.ok(input.isConnected, '弹层还没点呢，input 就不在文档里了')

  const pick = [...document.querySelectorAll('.sheet-item')].find((b) =>
    b.textContent.includes('从相册选'),
  )
  assert.ok(pick, '弹层里没有「从相册选」')
  pick.click()
  await settle()

  assert.ok(
    input.isConnected,
    '点了「从相册选」之后 file input 被卸载了 —— change 事件到不了 React，选完图不会有任何反应',
  )
  assert.ok(container.contains(input), 'file input 脱离了 React 树的根容器')

  // 真选一张图，确认整条链路通到卡片上（jsdom 里压缩会降级成存原图，不影响）
  const file = new window.File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new window.Event('change', { bubbles: true }))

  for (let i = 0; i < 100; i++) {
    if (container.querySelector('.recipe-thumb img')) break
    await settle()
  }
  assert.ok(
    container.querySelector('.recipe-thumb img'),
    '选完图后卡片上没有出现图片，说明 onChange 根本没跑',
  )
})

/** 同一个毛病的第二个入口：编辑页的大图区域。改了一处别忘了另一处。 */
test('编辑页换图：大图区域的文件选择器也不随弹层卸载', async () => {
  const container = document.getElementById('root')
  await mountApp()

  container.querySelector('.card-more').click()
  await settle()
  const edit = [...document.querySelectorAll('.sheet-item')].find((b) =>
    b.textContent.includes('编辑'),
  )
  assert.ok(edit, '操作单里没有「编辑」')
  edit.click()
  await settle()

  const editor = document.querySelector('.editor')
  assert.ok(editor, '编辑页没打开')

  // 通用不变式：任何 file input 都不许待在 .sheet 里。
  // BottomSheet 是 `if (!open) return null`，弹层一关 input 就卸载，
  // change 事件冒泡不到 React 根容器 —— 这是上面那个 bug 的根，不是个别位置的问题。
  for (const el of document.querySelectorAll('input[type="file"]')) {
    assert.ok(!el.closest('.sheet'), '有 file input 被塞进了弹层，选完图 React 收不到 change')
  }

  // 编辑页自己那两个也是常驻的（弹层还没开就该在）
  const input = editor.nextElementSibling
  assert.ok(
    input instanceof window.HTMLInputElement && input.type === 'file' && !input.hasAttribute('capture'),
    '编辑页没有把选图 input 放在弹层外面',
  )
  assert.ok(input.isConnected, '编辑页的选图 input 不在文档里')

  editor.querySelector('.cover').click()
  await settle()
  const pick = [...document.querySelectorAll('.sheet-item')].find((b) =>
    b.textContent.includes('从相册选'),
  )
  assert.ok(pick, '编辑页的图片操作单里没有「从相册选」')
  pick.click()
  await settle()

  assert.ok(
    input.isConnected,
    '编辑页点完「从相册选」后 file input 被卸载了 —— 和列表页那个是同一个坑',
  )
})

/**
 * 抽签页只该有一个「摇」的入口。
 *
 * 起因：用户截图报「随机抽取菜品这里有两个再来一次」—— 大按钮抽中之后变成
 * 「再摇一次」，下面那行又并排摆了个「再来一次」，两个干的是同一件事、
 * 样式还不一样。这类重复在代码里看不出来（一个在按钮文案里、一个在下面的
 * 条件块里），只有真的抽一次才会同时出现在屏幕上。
 */
test('抽签页只有一个摇的入口：抽中后不该再冒出第二个「再来一次」', async () => {
  const container = document.getElementById('root')
  await mountApp()

  const tab = [...document.querySelectorAll('.tabbar button')].find((b) =>
    b.textContent.includes('抽签点菜'),
  )
  assert.ok(tab, '标签栏里没有「抽签点菜」')
  tab.click()
  await settle()

  const big = [...container.querySelectorAll('button')].find((b) =>
    b.textContent.includes('今天吃啥？'),
  )
  assert.ok(big, '抽签页没有大摇号按钮')
  big.click()

  // jsdom 里 matchMedia 一律 matches:false，所以走的是带动画那条路：
  // 老虎机滚 ROLL_MS = 800ms 才落定，这里给它留够。
  for (let i = 0; i < 200; i++) {
    if (container.textContent.includes('再摇一次')) break
    await new Promise((r) => setTimeout(r, 20))
  }

  assert.ok(container.textContent.includes('再摇一次'), '摇完之后大按钮没变成「再摇一次」')
  assert.ok(container.textContent.includes('加入今日菜单'), '摇完之后没有「加入今日菜单」')

  // 这一条就是这个用例存在的理由
  assert.ok(
    !container.textContent.includes('再来一次'),
    '大按钮已经能再摇一次了，下面又摆了一个「再来一次」—— 两个入口干同一件事',
  )

  // 更通用的不变式：抽中之后，摇的入口有且只有那一个。
  // 以后往结果卡片加动作（收藏、换图……）随便加，但别再加摇的按钮。
  const rollers = [...container.querySelectorAll('button')].filter((b) =>
    /摇/.test(b.textContent),
  )
  assert.equal(rollers.length, 1, `摇的入口不止一个（${rollers.length} 个）`)
})
