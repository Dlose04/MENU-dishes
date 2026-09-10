import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useCompositionGuard } from '../hooks/useCompositionGuard'

interface ChipInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  /** 单个条目的最大长度，防止粘贴一整段进去 */
  maxLength?: number
}

const DEFAULT_MAX = 12
const MAX_ITEMS = 40

/** 用一个稳定的角度让每个 chip 歪得不一样，但重渲染不会乱跳。 */
function tiltFor(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return `${((Math.abs(h) % 5) - 2) * 0.8}deg`
}

/**
 * 食材输入：输入 + 回车变成可删除的 chip。
 *
 * 关键点是中文输入法的回车。用拼音打「番茄」时按回车是选字，
 * 这里必须放行给输入法，不能当成「加一个食材」——
 * 否则每选一次字就多一个 chip。防护逻辑在 useCompositionGuard 里。
 */
export function ChipInput({
  value,
  onChange,
  placeholder = '输入食材后回车',
  maxLength = DEFAULT_MAX,
}: ChipInputProps) {
  const [draft, setDraft] = useState('')
  const { isComposing, compositionProps } = useCompositionGuard()

  const commit = (raw: string) => {
    const text = raw.trim().slice(0, maxLength)
    if (!text) return
    if (value.includes(text)) {
      setDraft('')
      return
    }
    if (value.length >= MAX_ITEMS) return
    onChange([...value, text])
    setDraft('')
  }

  const remove = (item: string) => {
    onChange(value.filter((v) => v !== item))
  }

  return (
    <div>
      <div className="chip-input">
        <input
          className="input"
          type="text"
          value={draft}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          maxLength={maxLength}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // 输入法正在组合（选字阶段）——这个回车是给输入法的，别拦
            if (isComposing(e)) return

            if (e.key === 'Enter') {
              e.preventDefault()
              commit(draft)
              return
            }
            // 空输入时按退格，删掉最后一个 chip（手机上没有别的办法删）
            if (e.key === 'Backspace' && draft === '' && value.length) {
              onChange(value.slice(0, -1))
            }
          }}
          {...compositionProps}
        />
        <button
          type="button"
          className="btn chip-add"
          aria-label="添加食材"
          disabled={!draft.trim()}
          onPointerDown={(e) => {
            // 防止点击按钮时输入框先失焦导致输入法收起、内容错乱
            e.preventDefault()
          }}
          onClick={() => commit(draft)}
        >
          +
        </button>
      </div>

      {value.length > 0 && (
        <div className="chip-list">
          {value.map((item) => (
            <span className="chip-item" key={item} style={{ '--tilt': tiltFor(item) } as CSSProperties}>
              {item}
              <button
                type="button"
                aria-label={`删除食材 ${item}`}
                onClick={() => remove(item)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {value.length > 0 && (
        <p className="subtitle" style={{ marginTop: 8 }}>
          共 {value.length} 样。点 × 可以删掉。
        </p>
      )}
    </div>
  )
}
