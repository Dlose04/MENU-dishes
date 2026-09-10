import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ChangeEvent } from 'react'
import {
  CATEGORIES,
  DIFFICULTIES,
  EMOJI_PALETTE,
  type Difficulty,
  type Recipe,
  type RecipeDraft,
} from '../types'
import { CIcon } from './icons'
import { ChipInput } from './ChipInput'
import { BottomSheet } from './BottomSheet'
import { useVisualViewport } from '../hooks/useVisualViewport'
import { useObjectUrl } from '../hooks/useObjectUrl'
import { useBackGuard } from '../hooks/useBackGuard'
import { compressImage, blobToDataURL, dataURLToBlob, formatBytes } from '../lib/image'
import { confirmDialog } from '../store/confirm'
import { toast } from '../store/toast'

/* ------------------------------------------------------------------ */
/* 草稿：编辑中息屏/切后台不丢                                        */
/* ------------------------------------------------------------------ */

const DRAFT_KEY = 'family-menu:editor-draft'

interface DraftPayload {
  name: string
  category: string
  difficulty: Difficulty
  emoji: string
  ingredients: string[]
  note: string
  /** 压缩后的图，dataURL 形式（sessionStorage 放不下 Blob） */
  image?: string
  /** 用户是否主动删掉了图片 */
  imageCleared: boolean
}

interface StoredDraft {
  /** 这份草稿属于谁：'new' 或 'edit:{id}' */
  key: string
  payload: DraftPayload
  savedAt: number
}

function readDraft(): StoredDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredDraft
    if (!parsed?.key || !parsed.payload) return null
    return parsed
  } catch {
    return null
  }
}

function writeDraft(draft: StoredDraft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // 图片太大塞不进 sessionStorage：退一步，只存文字部分
    try {
      const withoutImage: StoredDraft = {
        ...draft,
        payload: { ...draft.payload, image: undefined },
      }
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(withoutImage))
    } catch {
      /* 还是不行就算了，不影响正常保存 */
    }
  }
}

function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 表单状态                                                            */
/* ------------------------------------------------------------------ */

interface FormState {
  name: string
  category: string
  difficulty: Difficulty
  emoji: string
  ingredients: string[]
  note: string
  imageBlob?: Blob
}

/** 图片处理结果的提示（压缩成功 / 降级存原图） */
interface ImageNotice {
  kind: 'ok' | 'warn'
  text: string
}

export interface RecipeEditorProps {
  /** null = 新建 */
  recipe: Recipe | null
  /** 预填内容（从分享预览「加入菜谱库」进来时会带） */
  initialDraft?: RecipeDraft
  onClose: () => void
  /** 返回保存后的菜谱，id 可能和传入的不同（另存为会新建一条） */
  onSaved: (recipe: Recipe, mode: 'create' | 'update') => void
}

const pickTilt = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `${((Math.abs(h) % 5) - 2) * 0.7}deg`
}

export function RecipeEditor({
  recipe,
  initialDraft,
  onClose,
  onSaved,
}: RecipeEditorProps) {
  const isEditing = recipe !== null
  const draftKey = recipe ? `edit:${recipe.id}` : 'new'

  const original: FormState = useMemo(
    () => ({
      name: recipe?.name ?? initialDraft?.name ?? '',
      category: recipe?.category ?? initialDraft?.category ?? CATEGORIES[0],
      difficulty: recipe?.difficulty ?? initialDraft?.difficulty ?? '简单',
      emoji: recipe?.emoji ?? initialDraft?.emoji ?? '🍽️',
      ingredients: recipe?.ingredients ?? initialDraft?.ingredients ?? [],
      note: recipe?.note ?? initialDraft?.note ?? '',
      imageBlob: recipe?.imageBlob,
    }),
    [recipe, initialDraft],
  )

  // 挂载时同步恢复草稿。sessionStorage 是同步 API，所以这里能直接在
  // useState 初始化里做完，不用先渲染一遍空表单再闪一下。
  const [restoreState] = useState(() => {
    const stored = readDraft()
    if (!stored || stored.key !== draftKey) {
      if (stored) clearDraft()
      return { form: null as FormState | null, savedAt: 0 }
    }
    const p = stored.payload
    let imageBlob: Blob | undefined
    if (p.image) {
      try {
        imageBlob = dataURLToBlob(p.image)
      } catch {
        imageBlob = undefined
      }
    }
    return {
      form: {
        name: p.name,
        category: p.category,
        difficulty: p.difficulty,
        emoji: p.emoji,
        ingredients: p.ingredients,
        note: p.note,
        imageBlob: p.imageCleared ? undefined : (imageBlob ?? original.imageBlob),
      } as FormState,
      savedAt: stored.savedAt,
    }
  })

  const [form, setForm] = useState<FormState>(restoreState.form ?? original)
  const [restoredNotice, setRestoredNotice] = useState(restoreState.form !== null)
  const [imageNotice, setImageNotice] = useState<ImageNotice | null>(null)
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState<'image' | 'emoji' | null>(null)

  const galleryInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  // 键盘弹起时把弹层高度收到「还能看见的那块」，聚焦的输入框才不会被盖住
  const vp = useVisualViewport(true)

  const imageUrl = useObjectUrl(form.imageBlob)

  const dirty = useMemo(() => {
    if (form.name !== original.name) return true
    if (form.category !== original.category) return true
    if (form.difficulty !== original.difficulty) return true
    if (form.emoji !== original.emoji) return true
    if (form.note !== original.note) return true
    if (form.imageBlob !== original.imageBlob) return true
    if (form.ingredients.length !== original.ingredients.length) return true
    return form.ingredients.some((x, i) => x !== original.ingredients[i])
  }, [form, original])

  const canSave = form.name.trim().length > 0

  const patch = useCallback((p: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...p }))
  }, [])

  /* ---------------- 草稿持久化 ---------------- */

  useEffect(() => {
    if (!dirty) {
      clearDraft()
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      let image: string | undefined
      if (form.imageBlob) {
        try {
          image = await blobToDataURL(form.imageBlob)
        } catch {
          image = undefined
        }
      }
      if (cancelled) return
      writeDraft({
        key: draftKey,
        savedAt: Date.now(),
        payload: {
          name: form.name,
          category: form.category,
          difficulty: form.difficulty,
          emoji: form.emoji,
          ingredients: form.ingredients,
          note: form.note,
          image,
          imageCleared: !form.imageBlob,
        },
      })
    }, 350)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [draftKey, dirty, form])

  // 切后台 / 息屏 / 直接杀进程：立刻落一次草稿（不等防抖）
  useEffect(() => {
    const flush = () => {
      if (!dirty) return
      // 这里同步写，来不及转 dataURL 就先不写图，保住文字
      writeDraft({
        key: draftKey,
        savedAt: Date.now(),
        payload: {
          name: form.name,
          category: form.category,
          difficulty: form.difficulty,
          emoji: form.emoji,
          ingredients: form.ingredients,
          note: form.note,
          imageCleared: !form.imageBlob,
        },
      })
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
    }
  }, [draftKey, dirty, form])

  /* ---------------- 备注框自适应高度 ---------------- */

  useEffect(() => {
    const el = noteRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(140, Math.max(56, el.scrollHeight))}px`
  }, [form.note])

  /* ---------------- 聚焦时把输入框滚进可视区 ---------------- */

  const onBodyFocus = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (!/^(INPUT|TEXTAREA)$/.test(target.tagName)) return
    // 等键盘弹起、容器高度调整完再滚，否则算出来的位置是错的
    window.setTimeout(() => {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 280)
  }, [])

  /* ---------------- 图片 ---------------- */

  const handleFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // 清空 value，否则同一张图连选两次不会触发 change
      e.target.value = ''
      if (!file) return

      setBusy(true)
      setImageNotice(null)
      try {
        const result = await compressImage(file)
        patch({ imageBlob: result.blob })
        if (result.compressed) {
          setImageNotice({
            kind: 'ok',
            text: `已压缩：${formatBytes(file.size)} → ${formatBytes(result.blob.size)}（${result.width}×${result.height}）`,
          })
        } else {
          setImageNotice({
            kind: 'warn',
            text: `这张图没能压缩（${result.reason ?? '格式不支持'}），按原图保存。图片较大，可能占用较多空间。`,
          })
        }
      } catch {
        setImageNotice({ kind: 'warn', text: '这张图读不出来，换一张试试。' })
      } finally {
        setBusy(false)
      }
    },
    [patch],
  )

  /* ---------------- 保存 ---------------- */

  const buildDraft = useCallback((): RecipeDraft => {
    return {
      name: form.name.trim(),
      category: form.category,
      difficulty: form.difficulty,
      emoji: form.emoji || '🍽️',
      ingredients: form.ingredients,
      note: form.note.trim() || undefined,
      imageBlob: form.imageBlob,
    }
  }, [form])

  const doSave = useCallback(
    (mode: 'create' | 'update') => {
      const draft = buildDraft()
      if (!draft.name) {
        toast('先给这道菜起个名字')
        return
      }
      clearDraft()
      onSaved(
        // id/createdAt 由 store 负责；这里塞占位值只为满足类型
        { ...draft, id: recipe?.id ?? '', createdAt: recipe?.createdAt ?? 0 },
        mode,
      )
    },
    [buildDraft, onSaved, recipe],
  )

  /** 返回 true 表示确实关掉了（供 useBackGuard 判断要不要把历史补回去） */
  const requestClose = useCallback(async (): Promise<boolean> => {
    if (!dirty) {
      clearDraft()
      onClose()
      return true
    }
    const ok = await confirmDialog({
      title: '放弃这些修改？',
      message: '刚才改的内容还没保存，离开就没了。',
      confirmText: '放弃',
      cancelText: '继续编辑',
      danger: true,
    })
    if (ok) {
      clearDraft()
      onClose()
    }
    return ok
  }, [dirty, onClose])

  // 安卓返回键 / iOS 侧滑也要走同一个确认，不能直接退出应用
  useBackGuard(requestClose)

  // 安卓返回键 / 浏览器后退：拦一次，别让用户莫名其妙丢内容
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const categories = useMemo(() => {
    const list = [...CATEGORIES] as string[]
    if (form.category && !list.includes(form.category)) list.push(form.category)
    return list
  }, [form.category])

  return (
    <>
      <div
        className="editor"
        style={{ top: vp.offsetTop, height: vp.height, bottom: 'auto' }}
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? '编辑菜谱' : '新增菜谱'}
      >
        <div className="editor-bar editor-bar-top-safe">
          <button type="button" className="btn btn-ghost" onClick={() => void requestClose()}>
            取消
          </button>
          <div className="editor-bar-title">{isEditing ? '编辑菜谱' : '新增菜谱'}</div>
          <button
            type="button"
            className="btn btn-primary save"
            disabled={!dirty || !canSave}
            onClick={() => doSave(isEditing ? 'update' : 'create')}
          >
            保存
          </button>
        </div>

        <div className="editor-body" ref={bodyRef} onFocus={onBodyFocus}>
          {restoredNotice && (
            <div className="notice">
              <span aria-hidden="true">📝</span>
              <div style={{ flex: 1 }}>
                已恢复未保存的修改。
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setForm(original)
                    setRestoredNotice(false)
                    clearDraft()
                    setImageNotice(null)
                  }}
                >
                  丢弃草稿
                </button>
              </div>
            </div>
          )}

          {/* 图片 */}
          <div className="field">
            <span className="field-label">图片</span>
            <div
              className="cover"
              role="button"
              tabIndex={0}
              onClick={() => setSheet('image')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSheet('image')
                }
              }}
            >
              {imageUrl ? (
                <img src={imageUrl} alt="" />
              ) : (
                <>
                  <span style={{ fontSize: 44 }} aria-hidden="true">
                    {form.emoji}
                  </span>
                  <span>点我从相册选图</span>
                </>
              )}
              <span className="cover-hint">
                {busy ? '正在处理图片…' : imageUrl ? '点一下可以换图或删除' : '还没有图片'}
              </span>
            </div>
            {imageNotice && (
              <div
                className={`notice${imageNotice.kind === 'warn' ? ' notice-danger' : ' notice-info'}`}
                style={{ marginTop: 10 }}
              >
                <span aria-hidden="true">{imageNotice.kind === 'warn' ? '⚠️' : '🖼️'}</span>
                <div style={{ flex: 1 }}>{imageNotice.text}</div>
              </div>
            )}
          </div>

          {/* 菜名 */}
          <div className="field">
            <label className="field-label" htmlFor="r-name">
              菜名
            </label>
            <input
              id="r-name"
              className="input"
              type="text"
              value={form.name}
              placeholder="例如：番茄炒蛋"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="next"
              maxLength={30}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          {/* 分类 */}
          <div className="field">
            <span className="field-label">分类</span>
            <div className="chip-row">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chip${form.category === c ? ' on' : ''}`}
                  data-cat={c}
                  style={{ '--tilt': pickTilt(c) } as CSSProperties}
                  onClick={() => patch({ category: c })}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* 难度 */}
          <div className="field">
            <span className="field-label">难度</span>
            <div className="segmented">
              {DIFFICULTIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`seg${form.difficulty === d ? ' on' : ''}`}
                  onClick={() => patch({ difficulty: d })}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* 食材 */}
          <div className="field">
            <span className="field-label">食材</span>
            <ChipInput
              value={form.ingredients}
              onChange={(next) => patch({ ingredients: next })}
            />
          </div>

          {/* 备注 */}
          <div className="field">
            <label className="field-label" htmlFor="r-note">
              备注（做法要点，可不填）
            </label>
            <textarea
              id="r-note"
              ref={noteRef}
              className="textarea"
              value={form.note}
              placeholder="例如：番茄先去皮，鸡蛋炒到半熟就盛出来"
              rows={2}
              maxLength={500}
              onChange={(e) => patch({ note: e.target.value })}
            />
          </div>

          {/* emoji 兜底图标 */}
          <div className="field">
            <span className="field-label">没有图片时显示的小图标</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 34 }} aria-hidden="true">
                {form.emoji}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setSheet('emoji')}
              >
                换一个
              </button>
            </div>
          </div>

          {isEditing && (
            <button
              type="button"
              className="btn btn-block"
              style={{ marginTop: 8 }}
              onClick={() => doSave('create')}
            >
              <CIcon name="copy" /> 另存为新菜谱
            </button>
          )}
        </div>
      </div>

      {/* 图片操作单 */}
      <BottomSheet
        open={sheet === 'image'}
        title="图片"
        onClose={() => setSheet(null)}
      >
        <input
          ref={galleryInput}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <button
          type="button"
          className="sheet-item"
          onClick={() => {
            // 必须在用户手势里同步触发，否则 iOS 会拦掉文件选择器
            galleryInput.current?.click()
            setSheet(null)
          }}
        >
          <span aria-hidden="true">🖼️</span> 从相册选
        </button>
        <button
          type="button"
          className="sheet-item"
          onClick={() => {
            cameraInput.current?.click()
            setSheet(null)
          }}
        >
          <span aria-hidden="true">📷</span> 拍照
        </button>
        {form.imageBlob && (
          <button
            type="button"
            className="sheet-item danger"
            onClick={() => {
              patch({ imageBlob: undefined })
              setImageNotice(null)
              setSheet(null)
            }}
          >
            <span aria-hidden="true">🗑️</span> 删除图片
          </button>
        )}
      </BottomSheet>

      {/* emoji 选择 */}
      <BottomSheet
        open={sheet === 'emoji'}
        title="挑一个图标"
        onClose={() => setSheet(null)}
      >
        <div className="chip-row" style={{ flexWrap: 'wrap', overflowX: 'visible' }}>
          {EMOJI_PALETTE.map((e) => (
            <button
              key={e}
              type="button"
              className={`chip${form.emoji === e ? ' on' : ''}`}
              style={{ fontSize: 22, padding: '6px 10px' }}
              onClick={() => {
                patch({ emoji: e })
                setSheet(null)
              }}
            >
              {e}
            </button>
          ))}
        </div>
      </BottomSheet>
    </>
  )
}
