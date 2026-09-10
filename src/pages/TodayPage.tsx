import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Recipe, ShareDish } from '../types'
import { EmptyBowl } from '../components/EmptyBowl'
import { CIcon } from '../components/icons'
import { tiltOf } from '../components/RecipeCard'
import {
  clearMenu,
  getMenu,
  toggleMenuItem,
  useAppState,
  useRecipes,
} from '../store/appStore'
import { confirmDialog } from '../store/confirm'
import { toast } from '../store/toast'
import { buildShareUrl, MAX_SHARE_URL_LENGTH } from '../lib/share'
import { shareOrCopy } from '../lib/io'
import {
  describeDateKey,
  formatDateKey,
  shiftDateKey,
  todayKey,
} from '../lib/date'

export function TodayPage() {
  const recipes = useRecipes()
  const { menus } = useAppState()

  const [date, setDate] = useState(todayKey())
  const [query, setQuery] = useState('')
  const [sharing, setSharing] = useState(false)

  const menu = getMenu(date)
  const selectedSet = useMemo(() => new Set(menu.items), [menu.items])

  const selectedRecipes = useMemo(
    () =>
      menu.items
        .map((id) => recipes.find((r) => r.id === id))
        .filter((r): r is Recipe => Boolean(r)),
    [menu.items, recipes],
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return recipes
    return recipes.filter((r) =>
      `${r.name} ${r.ingredients.join(' ')}`.toLowerCase().includes(q),
    )
  }, [recipes, query])

  const history = useMemo(
    () =>
      [...menus]
        .filter((m) => m.items.length > 0)
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, 30),
    [menus],
  )

  /* ---------------- 分享 ---------------- */

  const share = async () => {
    if (!selectedRecipes.length) return
    setSharing(true)
    try {
      // 链接里只带菜名/分类/emoji：图片塞不进 URL，微信会把超长链接截断
      const dishes: ShareDish[] = selectedRecipes.map((r) => ({
        n: r.name,
        c: r.category,
        e: r.emoji,
      }))

      const { url, length, tooLong } = buildShareUrl(dishes)

      if (tooLong) {
        const ok = await confirmDialog({
          title: '菜单有点长',
          message:
            `生成的链接有 ${length} 个字符，超过了 ${MAX_SHARE_URL_LENGTH} 的安全长度` +
            `（微信、QQ 可能会截断）。建议少选几道菜，或者分两次分享。仍然要分享吗？`,
          confirmText: '仍然分享',
        })
        if (!ok) return
      }

      const outcome = await shareOrCopy({
        title: `${describeDateKey(date)}的菜单`,
        text: `我家的菜单：${selectedRecipes.map((r) => r.name).join('、')}`,
        url,
      })

      if (outcome === 'copied') toast('链接已复制，粘贴给家人就行')
      else if (outcome === 'failed') toast('分享失败，可以到设置页看看浏览器限制')
      // 'shared' 由系统面板自己给反馈；'cancelled' 是用户主动取消，不打扰
    } finally {
      setSharing(false)
    }
  }

  /* ---------------- 渲染 ---------------- */

  if (recipes.length === 0) {
    return (
      <>
        <header className="app-head">
          <h1 className="app-title">今日菜单</h1>
        </header>
        <div className="page">
          <div className="empty">
            <EmptyBowl />
            <p className="empty-title">菜谱库还是空的</p>
            <p className="empty-desc">先记几道菜，再来排今天的菜单。</p>
          </div>
        </div>
      </>
    )
  }

  const isToday = date === todayKey()

  return (
    <>
      <header className="app-head">
        <h1 className="app-title">今日菜单</h1>
        <div className="app-head-side">
          {menu.items.length > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: '清空这一天的菜单？',
                  message: '菜谱库不会受影响。',
                  confirmText: '清空',
                  danger: true,
                })
                if (!ok) return
                await clearMenu(date)
                toast('已清空')
              }}
            >
              清空
            </button>
          )}
        </div>
      </header>

      <div className="page">
        {/* 日期切换 */}
        <div className="card card-warm" style={{ marginTop: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="前一天"
              onClick={() => setDate((d) => shiftDateKey(d, -1))}
            >
              ←
            </button>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 19, fontWeight: 700 }}>{formatDateKey(date)}</div>
              <div className="subtitle">
                {isToday ? '就是今天' : describeDateKey(date)} · 已选 {menu.items.length} 道
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="后一天"
              onClick={() => setDate((d) => shiftDateKey(d, 1))}
            >
              →
            </button>
          </div>
          {!isToday && (
            <button
              type="button"
              className="btn btn-sm btn-block"
              style={{ marginTop: 10 }}
              onClick={() => setDate(todayKey())}
            >
              回到今天
            </button>
          )}
        </div>

        {/* 已选 */}
        {menu.items.length > 0 && (
          <>
            <h3 className="section-title">这天吃什么</h3>
            <div className="chip-row" style={{ flexWrap: 'wrap', overflowX: 'visible' }}>
              {selectedRecipes.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="chip on"
                  data-cat={r.category}
                  style={{ '--tilt': tiltOf(r.id, 0.8) } as CSSProperties}
                  aria-label={`从菜单里移除 ${r.name}`}
                  onClick={() => void toggleMenuItem(date, r.id)}
                >
                  <span aria-hidden="true">{r.emoji}</span> {r.name} ×
                </button>
              ))}
            </div>
          </>
        )}

        {/* 勾选清单 */}
        <h3 className="section-title">勾一下今天想吃的</h3>

        {recipes.length > 10 && (
          <div className="search">
            <span className="search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              className="input"
              type="search"
              value={query}
              placeholder="搜菜名或食材"
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        {visible.length === 0 ? (
          <p className="subtitle">没找到匹配的菜。</p>
        ) : (
          <div>
            {visible.map((r) => {
              const on = selectedSet.has(r.id)
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`check-row${on ? ' on' : ''}`}
                  aria-pressed={on}
                  onClick={() => void toggleMenuItem(date, r.id)}
                >
                  <span className="check-box" aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                  <span style={{ fontSize: 20, flex: 'none' }} aria-hidden="true">
                    {r.emoji}
                  </span>
                  <span className="check-label" style={{ flex: 1, minWidth: 0 }}>
                    {r.name}
                  </span>
                  {r.category && (
                    <span className="tag" data-cat={r.category}>
                      {r.category}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* 历史 */}
        <h3 className="section-title">往日菜单</h3>
        {history.length === 0 ? (
          <p className="subtitle">还没有存过菜单。</p>
        ) : (
          history.map((m) => {
            const names = m.items
              .map((id) => recipes.find((r) => r.id === id)?.name)
              .filter(Boolean)
            return (
              <button
                key={m.date}
                type="button"
                className="check-row"
                onClick={() => setDate(m.date)}
                style={{ alignItems: 'flex-start' }}
              >
                <span style={{ flex: 'none', width: 78, fontWeight: 700 }}>
                  {describeDateKey(m.date)}
                </span>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--ink-soft)', fontSize: 14 }}>
                  {names.length ? names.join('、') : '（菜谱已删除）'}
                </span>
                <span className="subtitle" style={{ flex: 'none' }}>
                  {m.items.length} 道
                </span>
              </button>
            )
          })
        )}
      </div>

      {/* 底部：已选数量 + 分享 */}
      <div className="bottom-bar">
        <span className="count">
          已选 <strong style={{ fontSize: 18 }}>{menu.items.length}</strong> 道
        </span>
        <div className="grow" />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!menu.items.length || sharing}
          onClick={() => void share()}
        >
          <CIcon name="share" size={16} />
          {sharing ? '生成中…' : '分享这份菜单'}
        </button>
      </div>
    </>
  )
}
