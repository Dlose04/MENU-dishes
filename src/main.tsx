import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

function mount() {
  const container = document.getElementById('root')
  if (!container) throw new Error('找不到 #root 挂载点')

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  // 告诉 index.html 里的启动看门狗「我起来了」，别再报启动失败。
  // 放在 render 之后：只要走到这行，说明整个模块图已经执行完毕，
  // 之后即使某个交互抛错，也不该再显示「手账没能翻开」。
  ;(window as Window & { __handbookMounted?: boolean }).__handbookMounted = true
}

// 等 DOM 解析完再挂载，别假设 #root 已经在了。
//
// 起因：打包成单文件后入口脚本必是普通脚本（微信 iOS 不执行 module，
// 见 vite.config.ts 的 classicScript）。而 Vite 会把 module 脚本提到
// <head> —— module 本来有「延迟到文档解析完再执行」的语义，换成普通脚本
// 就没了，于是脚本在 <body> 之前同步执行，getElementById('root') 拿到 null，
// 整个应用挂在第一行。更坑的是这时候诊断脚本还没来得及注册 onerror，
// 屏幕上只剩 8 秒后那句「应用脚本似乎完全没有执行」，看不出真因。
//
// 构建那边也会把入口脚本放回 </body> 前面，这里是第二道保险：
// 不管以后工具链怎么重排，挂载都不会再依赖脚本的位置。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true })
} else {
  mount()
}
