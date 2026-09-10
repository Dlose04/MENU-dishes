import { useSyncExternalStore } from 'react'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作（删除、清空）用红色确认按钮 */
  danger?: boolean
}

export interface ConfirmState extends ConfirmOptions {
  open: boolean
}

const CLOSED: ConfirmState = { open: false, title: '' }

let state: ConfirmState = CLOSED
let resolver: ((ok: boolean) => void) | null = null
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

/**
 * 命令式确认框：
 *   if (await confirmDialog({ title: '删除这道菜？' })) { ... }
 *
 * 比在每个组件里各写一个 <Modal> 省事，也让「删除前必须二次确认」
 * 这条规则只有一个实现，不会漏。
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // 上一个还没关就被新的顶掉：当作取消处理，避免 promise 永远悬着
  resolver?.(false)
  return new Promise<boolean>((resolve) => {
    resolver = resolve
    state = { ...options, open: true }
    emit()
  })
}

export function resolveConfirm(ok: boolean): void {
  const r = resolver
  resolver = null
  state = CLOSED
  emit()
  r?.(ok)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ConfirmState {
  return state
}

export function useConfirmState(): ConfirmState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
