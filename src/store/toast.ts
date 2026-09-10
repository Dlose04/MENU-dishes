import { useSyncExternalStore } from 'react'
import { nanoid } from '../lib/nanoid'

export interface ToastItem {
  id: string
  text: string
  actionLabel?: string
  onAction?: () => void
  /** 毫秒；带撤销按钮的会久一点 */
  duration: number
}

const DEFAULT_DURATION = 2400
const ACTION_DURATION = 10_000

let toasts: ToastItem[] = []
const listeners = new Set<() => void>()
const timers = new Map<string, number>()

function emit() {
  // 必须换新数组引用，useSyncExternalStore 才认得出变化
  toasts = [...toasts]
  listeners.forEach((l) => l())
}

function clearTimer(id: string) {
  const t = timers.get(id)
  if (t !== undefined) {
    window.clearTimeout(t)
    timers.delete(id)
  }
}

export function dismissToast(id: string): void {
  clearTimer(id)
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export interface ToastOptions {
  actionLabel?: string
  onAction?: () => void
  duration?: number
}

export function toast(text: string, options: ToastOptions = {}): string {
  const id = nanoid(8)

  // 没有 DOM 就直接返回。toast 是纯 UI 副作用，而调用它的地方往往是
  // 「先落库、后提示」—— 在 Node 里跑 store 的用例时，window 不存在，
  // 让它抛出去的话，一次成功的归并/删除会表现得像失败了
  // （提示本身没发出来，业务逻辑却被异常打断）。
  if (typeof window === 'undefined') return id

  const duration =
    options.duration ?? (options.actionLabel ? ACTION_DURATION : DEFAULT_DURATION)

  const item: ToastItem = {
    id,
    text,
    actionLabel: options.actionLabel,
    onAction: options.onAction,
    duration,
  }

  // 同屏最多 3 条，多了直接顶掉最老的，避免糊满屏幕
  toasts = [...toasts, item].slice(-3)
  emit()

  const timer = window.setTimeout(() => dismissToast(id), duration)
  timers.set(id, timer)
  return id
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ToastItem[] {
  return toasts
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
