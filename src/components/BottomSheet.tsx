import { useEffect } from 'react'
import type { ReactNode } from 'react'

interface BottomSheetProps {
  open: boolean
  title?: string
  onClose: () => void
  children: ReactNode
}

/**
 * 底部抽屉。点遮罩、按 Esc 都能关。
 * 手机上比居中弹窗好按（拇指够得着），所以除了确认框以外的弹层都用它。
 */
export function BottomSheet({ open, title, onClose, children }: BottomSheetProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="mask" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        {title && <p className="sheet-title">{title}</p>}
        {children}
        <button type="button" className="btn btn-block sheet-cancel" onClick={onClose}>
          取消
        </button>
      </div>
    </>
  )
}

export interface SheetAction {
  key: string
  label: string
  icon?: string
  danger?: boolean
  onSelect: () => void
}

/** 操作单：卡片右上角「···」弹出来的那个。 */
export function ActionSheet({
  open,
  title,
  actions,
  onClose,
}: {
  open: boolean
  title?: string
  actions: SheetAction[]
  onClose: () => void
}) {
  return (
    <BottomSheet open={open} title={title} onClose={onClose}>
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          className={`sheet-item${a.danger ? ' danger' : ''}`}
          onClick={() => {
            onClose()
            a.onSelect()
          }}
        >
          {a.icon && <span aria-hidden="true">{a.icon}</span>}
          <span>{a.label}</span>
        </button>
      ))}
    </BottomSheet>
  )
}
