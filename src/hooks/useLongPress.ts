import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  onContextMenu: (e: { preventDefault: () => void }) => void
}

/**
 * 长按 500ms 触发（移动端习惯：长按卡片直接进编辑）。
 *
 * 手指滑动超过 10px 就取消 —— 否则用户在列表里上下滚，会一路误触编辑。
 * 触发后把 longPressed 置位，调用方在 onClick 里检查它并复位，
 * 避免「长按进编辑」之后又跟一个 click 把详情页也打开了。
 */
export function useLongPress(onLongPress: () => void, ms = 500) {
  const timer = useRef<number | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const longPressed = useRef(false)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    start.current = null
  }, [])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse') return // 鼠标右键/长按不掺和
      longPressed.current = false
      start.current = { x: e.clientX, y: e.clientY }
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        longPressed.current = true
        timer.current = null
        onLongPress()
      }, ms)
    },
    [ms, onLongPress],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!start.current) return
      const dx = e.clientX - start.current.x
      const dy = e.clientY - start.current.y
      if (Math.hypot(dx, dy) > 10) clear()
    },
    [clear],
  )

  const onPointerUp = useCallback(() => clear(), [clear])
  const onPointerCancel = useCallback(() => clear(), [clear])

  const onContextMenu = useCallback((e: { preventDefault: () => void }) => {
    // 长按在移动端会顺带弹系统菜单，屏蔽掉
    e.preventDefault()
  }, [])

  const handlers: LongPressHandlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onContextMenu,
  }

  return { handlers, longPressed }
}
