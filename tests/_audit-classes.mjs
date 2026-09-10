/**
 * 一次性小工具（不是测试）：把组件里用到的 className 和 global.css 里定义过的
 * 选择器对一遍，揪出「代码里用了但样式里没写」的类 —— .dialog 就是这么漏掉的。
 * 动态拼接的类名会被误报，需要人工判断。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(ROOT, 'src/styles/global.css'), 'utf8')
const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.tsx?$/.test(p)) files.push(p)
  }
})(path.join(ROOT, 'src'))

const used = new Map()
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  const rel = path.relative(ROOT, f).split(path.sep).join('/')
  for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? ''
    for (const c of raw.match(/[a-zA-Z][\w-]*/g) ?? []) {
      if (!used.has(c)) used.set(c, new Set())
      used.get(c).add(rel)
    }
  }
}

const missing = [...used].filter(([c]) => !defined.has(c)).sort((a, b) => a[0].localeCompare(b[0]))
if (!missing.length) {
  console.log('✔ 所有 className 都在 global.css 里有定义')
} else {
  console.log('以下类名在 CSS 里没找到（动态拼接的会误报，人工判断）：')
  for (const [c, where] of missing) console.log(`  ${c.padEnd(22)} ${[...where].join(', ')}`)
}
