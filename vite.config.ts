import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

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
  plugins: [react(), viteSingleFile(), classicScript()],
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
