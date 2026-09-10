import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

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
