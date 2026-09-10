/** 浏览器能力封装：下载文件、选文件、复制、分享。全部带降级。 */

/** 触发一次文件下载。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 立刻 revoke 在部分浏览器上会打断下载，给一点缓冲
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 打开系统文件选择器；用户取消时 resolve(null)，不会 reject。 */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)

    let settled = false
    const done = (file: File | null) => {
      if (settled) return
      settled = true
      input.remove()
      window.removeEventListener('focus', onFocus)
      resolve(file)
    }

    input.addEventListener('change', () => done(input.files?.[0] ?? null))
    // 取消选择没有可靠事件：iOS/Chrome 在关闭选择器后会让 window 重新获得焦点
    const onFocus = () => setTimeout(() => done(input.files?.[0] ?? null), 500)
    window.addEventListener('focus', onFocus)

    input.click()
  })
}

/** 复制到剪贴板。返回是否成功。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 继续走下面的兜底 */
  }
  // 兜底：非 https / 老浏览器没有 clipboard API
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed'

export interface ShareOptions {
  title?: string
  text?: string
  url: string
}

/**
 * 优先用系统分享面板（手机上能直接分享到微信）；
 * 不支持就退回复制链接。用户主动取消分享面板时返回 'cancelled'，
 * UI 不应该再弹「复制成功」打扰他。
 */
export async function shareOrCopy(opts: ShareOptions): Promise<ShareOutcome> {
  const nav = navigator as Navigator & {
    share?: (data: ShareData) => Promise<void>
    canShare?: (data: ShareData) => boolean
  }

  if (typeof nav.share === 'function') {
    try {
      const data: ShareData = { title: opts.title, text: opts.text, url: opts.url }
      if (typeof nav.canShare === 'function' && !nav.canShare(data)) {
        throw new Error('canShare=false')
      }
      await nav.share(data)
      return 'shared'
    } catch (err) {
      // 用户点了取消
      if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
        return 'cancelled'
      }
      // 其他错误（比如桌面端 Chrome 分享面板初始化失败）→ 退回复制
    }
  }

  const ok = await copyText(opts.url)
  return ok ? 'copied' : 'failed'
}
