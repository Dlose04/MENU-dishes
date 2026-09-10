import { useCallback, useMemo, useRef } from 'react'
import type { CompositionEvent, KeyboardEvent } from 'react'

/**
 * 中文输入法「回车」防护。
 *
 * 用拼音打「番茄」时按回车是**选字**，不是提交。如果不处理，
 * 每敲一个字按回车都会误加一个食材 chip —— 这个坑在英文输入法下测不出来，
 * 只有真机中文输入才会暴露。
 *
 * 两道防线：
 *   1. 组合期间（compositionstart ~ compositionend）忽略 Enter；
 *   2. Safari 有时会先触发 compositionend 再补一个 isComposing=false 的 keydown，
 *      所以 compositionend 之后再宽限 60ms，把那个「确认候选词」的回车吃掉。
 */
const GRACE_MS = 60

export function useCompositionGuard() {
  const composing = useRef(false)
  const justEndedAt = useRef(0)

  const onCompositionStart = useCallback(() => {
    composing.current = true
  }, [])

  const onCompositionEnd = useCallback(() => {
    composing.current = false
    justEndedAt.current = Date.now()
  }, [])

  /** 这次按键是不是「还在组合输入中 / 刚刚组合结束」，是的话就别当提交处理。 */
  const isComposing = useCallback((e: KeyboardEvent<HTMLElement>): boolean => {
    if (composing.current) return true
    const native = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number }
    if (native?.isComposing) return true
    // 229 是各家浏览器表示「这个按键被输入法吃掉了」的约定值
    if (native?.keyCode === 229) return true
    if (Date.now() - justEndedAt.current < GRACE_MS) return true
    return false
  }, [])

  return useMemo(
    () => ({
      composing,
      isComposing,
      compositionProps: {
        onCompositionStart: onCompositionStart as (e: CompositionEvent<HTMLElement>) => void,
        onCompositionEnd: onCompositionEnd as (e: CompositionEvent<HTMLElement>) => void,
      },
    }),
    [isComposing, onCompositionEnd, onCompositionStart],
  )
}
