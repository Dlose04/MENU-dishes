import { dismissToast, useToasts } from '../store/toast'

/** Toast 只在这里渲染一次，任何地方调 toast() 都能弹出来。 */
export function ToastHost() {
  const toasts = useToasts()
  if (!toasts.length) return null

  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.text}</span>
          {t.actionLabel && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismissToast(t.id)
                t.onAction?.()
              }}
            >
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
