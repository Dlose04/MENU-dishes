import { useEffect, useState } from 'react'

/**
 * 把 Blob 变成可以喂给 <img src> 的 object URL，并在 Blob 变化/组件卸载时释放。
 * 不释放的话，用户来回编辑几十张图就会把内存吃光。
 */
export function useObjectUrl(blob?: Blob | null): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!blob) {
      setUrl(undefined)
      return
    }
    let next: string
    try {
      next = URL.createObjectURL(blob)
    } catch {
      // 造不出 object URL 就当这张图不存在，卡片自己退成 emoji。
      //
      // 这个 try 是有来历的：以前它裸着，而 useEffect 里抛出去的错会一路冒到
      // 根上 —— React 没有 error boundary 时会把整棵树卸载。也就是说
      // **一张缩略图有能力把整个应用干成白屏**（不是那道菜没图，是整个页面没了）。
      // 2026-09-10 换预置菜照片时撞上的：jsdom 没实现 createObjectURL，
      // 一给预置菜配上图，构建产物就再也挂载不起来了，而控制台里那句
      // 「URL.createObjectURL is not a function」和「应用白屏」看着毫无关系。
      // 真实浏览器基本不会缺这个 API，但代价太不对称，不值得赌。
      setUrl(undefined)
      return
    }
    setUrl(next)
    return () => {
      try {
        URL.revokeObjectURL(next)
      } catch {
        /* 释放失败不影响显示，不该因此把渲染搞崩 */
      }
    }
  }, [blob])

  return url
}
