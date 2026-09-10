import { resolveConfirm, useConfirmState } from '../store/confirm'

/**
 * 全局唯一的确认框。所有「删除前先问一句」都走这里，
 * 保证不会有哪个删除入口漏掉二次确认。
 */
export function ConfirmHost() {
  const state = useConfirmState()
  if (!state.open) return null

  return (
    <div
      className="mask"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={() => resolveConfirm(false)}
    >
      <div
        className="card dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={state.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">{state.title}</h2>
        {state.message && <p className="dialog-message">{state.message}</p>}
        <div className="btn-row dialog-actions">
          <button
            type="button"
            className="btn"
            onClick={() => resolveConfirm(false)}
          >
            {state.cancelText ?? '取消'}
          </button>
          <button
            type="button"
            className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`}
            autoFocus
            onClick={() => resolveConfirm(true)}
          >
            {state.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
