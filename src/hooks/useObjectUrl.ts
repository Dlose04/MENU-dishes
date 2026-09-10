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
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])

  return url
}
