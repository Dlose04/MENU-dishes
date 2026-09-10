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

/**
 * 挂载 App，等 store 初始化（异步探测 IndexedDB → 降级 → 播种）落定。
 * 轮询而不是死等固定轮数：机器快就快，慢也不会假阴性。
 */
async function mountApp() {
  const container = document.getElementById('root')
  container.innerHTML = ''
  const root = createRoot(container)
  root.render(createElement(App))

  for (let i = 0; i < 100; i++) {
    if (container.innerHTML.includes('bookcover')) break
    await new Promise((r) => setTimeout(r, 10))
  }
  return container.innerHTML
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
