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

test('PWA 元信息齐全（添加到主屏幕要用）', { skip }, () => {
  assert.ok(html.includes('rel="manifest"'))
  assert.ok(html.includes('apple-mobile-web-app-capable'))
  assert.ok(html.includes('apple-touch-icon'))
  assert.ok(html.includes('viewport-fit=cover'), '缺 viewport-fit=cover，刘海会挡内容')
})
