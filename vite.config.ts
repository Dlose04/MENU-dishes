import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

const ROOT = import.meta.dirname
const PUBLIC = path.resolve(ROOT, 'public')

/**
 * 把 PWA 清单和图标内联进 HTML。
 *
 * 起因：这个应用要能「只拿走一个 index.html」用 `file://` 双击跑起来，
 * 而 `file://` 下拿不到同目录的 manifest.webmanifest 和 png，所以这两样
 * 必须写成 data: URI 才有效。但手写 base64 就意味着**同一份图标有两份副本**，
 * 改了 public/ 里的图，内联的那份不会跟着变 —— 之前 public/icon-512.png
 * 是 180×180 的复制品，内联清单里的两个图标也都指着这张 180 的图，
 * 就是这么攒出来的。
 *
 * 所以这里改成构建时生成：`public/manifest.webmanifest` 是唯一的真源，
 * 内联那份由它派生，图标按 src 去 public/ 里读文件转成 base64。
 * 改图标只要跑 `npm run icons`，不用再手动同步任何东西。
 *
 * 只在 build 时生效。开发时（vite dev）public/ 是被直接伺服的真文件，
 * 用相对路径更利于调试。
 */
function inlinePwaAssets(): Plugin {
  const toDataUri = (src: string) => {
    const file = path.join(PUBLIC, src.replace(/^\.?\//, ''))
    const buf = fs.readFileSync(file)
    const mime = file.endsWith('.webmanifest')
      ? 'application/manifest+json'
      : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  }

  return {
    name: 'family-menu:inline-pwa-assets',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      const manifestPath = path.join(PUBLIC, 'manifest.webmanifest')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

      // 清单里的图标路径换成内联数据；其余字段原样保留
      const inlined = {
        ...manifest,
        icons: manifest.icons.map((icon: { src: string }) => ({
          ...icon,
          src: toDataUri(icon.src),
        })),
      }

      const swap = (re: RegExp, value: string, label: string) => {
        if (!re.test(html)) {
          throw new Error(`index.html 里找不到 ${label}，内联 PWA 资源失败`)
        }
        return html.replace(re, `$1${value}$2`)
      }

      html = swap(
        /(<link\s+id="app-manifest"[\s\S]*?href=")[^"]*(")/,
        `data:application/manifest+json,${encodeURIComponent(JSON.stringify(inlined))}`,
        '清单链接（id="app-manifest"）',
      )
      html = swap(
        /(<link\s+id="app-icon"[\s\S]*?href=")[^"]*(")/,
        toDataUri('./icon-180.png'),
        '图标链接（id="app-icon"）',
      )
      return html
    },
  }
}

/**
 * 给 Service Worker 的缓存名打上构建哈希。
 *
 * 起因：SW 对导航请求是「缓存优先」，而缓存名原本写死成 'family-menu-v1'。
 * 只要 sw.js 自身的字节没变，浏览器就不会重装 SW，install/activate 都不跑，
 * 缓存里的旧 index.html 永远删不掉 —— 也就是说**装过应用的人永远看不到新版本**，
 * 发多少次版都一样。这次改图标就正好撞上：页面更新了，但到不了已经
 * 「添加到主屏幕」的人手里。
 *
 * 做法：把缓存名绑到构建产物（index.html）的内容摘要上。内容一变，
 * sw.js 跟着变，浏览器重装 SW，activate 里那段「删掉所有旧缓存」就生效了。
 *
 * 用 closeBundle 而不是 generateBundle：public/ 下的文件是 Vite 在构建末尾
 * 直接拷进 dist 的，不走 rollup 的 bundle，所以只能在文件落盘之后改。
 */
function stampServiceWorker(): Plugin {
  return {
    name: 'family-menu:stamp-service-worker',
    apply: 'build',
    closeBundle() {
      const outDir = path.resolve(ROOT, 'dist')
      const swPath = path.join(outDir, 'sw.js')
      const htmlPath = path.join(outDir, 'index.html')
      if (!fs.existsSync(swPath) || !fs.existsSync(htmlPath)) return

      const hash = createHash('sha256')
        .update(fs.readFileSync(htmlPath))
        .digest('hex')
        .slice(0, 10)

      const sw = fs.readFileSync(swPath, 'utf8')
      if (!sw.includes('__BUILD_HASH__')) {
        throw new Error('dist/sw.js 里没有 __BUILD_HASH__ 占位符，缓存名没法更新')
      }
      fs.writeFileSync(swPath, sw.replace('__BUILD_HASH__', hash))
    },
  }
}

/**
 * 兜底：把内联后的 `<script type="module" crossorigin>` 降级成普通 `<script>`。
 *
 * 打包格式已经设成 iife 了，正常情况下 Vite 不会再写 type="module"；
 * 但这是「微信里整个应用白屏」级别的故障，值得再钉一颗钉子 ——
 * 万一以后升级 Vite 改了输出行为，构建产物也不会悄悄变回 module。
 */
function classicScript(): Plugin {
  return {
    name: 'family-menu:classic-script',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.html')) continue
        const before = String(file.source)
        const after = before.replace(/<script\s+type="module"(\s+crossorigin)?\s*>/g, '<script>')
        if (after !== before) file.source = after
      }
    },
  }
}

// 目标：`vite build` 之后 dist/index.html 是一个自包含的单文件应用，
// 双击（file://）能跑，丢到任意静态托管也能跑。
// 因此这里关掉代码分割、把资源内联阈值拉满。
export default defineConfig({
  // 相对路径，保证部署在 GitHub Pages 子目录 / 任意子路径下都能正确加载
  base: './',
  plugins: [
    react(),
    viteSingleFile(),
    inlinePwaAssets(),
    classicScript(),
    stampServiceWorker(),
  ],
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    chunkSizeWarningLimit: 4096,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        // 打包成 IIFE（普通脚本）而不是 ES module。
        // 原因：微信 iOS 里点开本地 html 时，文档处于「不透明源」
        // （custom scheme / 沙箱 WKWebView），WebKit 会拒绝执行 type="module"
        // 的内联脚本 —— HTML 渲染出来了，JS 一行不跑，永远停在开屏文案上。
        // 单文件应用本来就没有 import/export 需要保留，降级成普通脚本零成本。
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
})
