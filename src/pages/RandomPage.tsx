import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { CATEGORIES, type Recipe } from '../types'
import { EmptyBowl } from '../components/EmptyBowl'
import { CIcon } from '../components/icons'
import { tiltOf } from '../components/RecipeCard'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { addToMenu, useRecipes } from '../store/appStore'
import { toast } from '../store/toast'
import { todayKey } from '../lib/date'

/** 老虎机滚动总时长 */
const ROLL_MS = 800
/** 换字间隔，越到后面越慢 */
const TICK_MS = 60

export function RandomPage() {
  const recipes = useRecipes()
  const reducedMotion = usePrefersReducedMotion()

  const [category, setCategory] = useState<string | null>(null)
  const [limitToCategory, setLimitToCategory] = useState(true)
  const [rolling, setRolling] = useState(false)
  const [display, setDisplay] = useState<Recipe | null>(null)
  const [result, setResult] = useState<Recipe | null>(null)

  const timer = useRef<number | null>(null)

  // 组件卸载时一定要清掉定时器，否则会在已卸载的组件上 setState
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current)
    }
  }, [])

  const availableCategories = useMemo(() => {
    const used = new Set(recipes.map((r) => r.category).filter(Boolean))
    return (CATEGORIES as readonly string[]).filter((c) => used.has(c))
  }, [recipes])

  const pool = useMemo(() => {
    if (!category || !limitToCategory) return recipes
    return recipes.filter((r) => r.category === category)
  }, [recipes, category, limitToCategory])

  const roll = useCallback(() => {
    if (rolling || pool.length === 0) return

    // 尽量别连着抽到同一道
    const candidates =
      pool.length > 1 ? pool.filter((r) => r.id !== result?.id) : pool
    const target = candidates[Math.floor(Math.random() * candidates.length)]

    // 系统开了「减弱动态效果」：不滚，直接给结果
    if (reducedMotion) {
      setDisplay(target)
      setResult(target)
      return
    }

    setRolling(true)
    setResult(null)

    const startedAt = Date.now()
    const tick = () => {
      const elapsed = Date.now() - startedAt
      if (elapsed >= ROLL_MS) {
        timer.current = null
        setDisplay(target)
        setResult(target)
        setRolling(false)
        return
      }
      setDisplay(pool[Math.floor(Math.random() * pool.length)])
      // 越接近结束换得越慢，停下来的时候有「减速」的手感
      const progress = elapsed / ROLL_MS
      timer.current = window.setTimeout(tick, TICK_MS + progress * progress * 200)
    }
    timer.current = window.setTimeout(tick, TICK_MS)
  }, [pool, reducedMotion, result, rolling])

  if (recipes.length === 0) {
    return (
      <>
        <header className="app-head">
          <h1 className="app-title">今天吃啥</h1>
        </header>
        <div className="page">
          <div className="empty">
            <EmptyBowl />
            <p className="empty-title">还没有菜可以抽</p>
            <p className="empty-desc">先去菜谱库记几道菜，再回来摇。</p>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <header className="app-head">
        <h1 className="app-title">今天吃啥</h1>
        <div className="app-head-side">
          <span className="subtitle">候选 {pool.length} 道</span>
        </div>
      </header>

      <div className="page">
        <div className={`card slot${rolling ? ' rolling' : ''}${result ? ' settled' : ''}`}>
          {display ? (
            <>
              <span className="slot-emoji" aria-hidden="true">
                {display.emoji}
              </span>
              <span className="slot-name">{display.name}</span>
              <div className="slot-meta">
                {!rolling && result && (
                  <>
                    {result.category && (
                      <span className="tag" data-cat={result.category}>
                        {result.category}
                      </span>
                    )}
                    <span className="tag tag-plain">{result.difficulty}</span>
                  </>
                )}
                {rolling && <span className="subtitle">正在摇…</span>}
              </div>
            </>
          ) : (
            <>
              <span className="slot-emoji" aria-hidden="true">
                🍽️
              </span>
              <span className="slot-name" style={{ fontSize: 22, color: 'var(--ink-soft)' }}>
                还没摇
              </span>
              <span className="subtitle">点下面的按钮，让手账替你决定</span>
            </>
          )}
        </div>

        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          disabled={rolling || pool.length === 0}
          onClick={roll}
        >
          <CIcon name="check" />
          {result ? '再摇一次' : '今天吃啥？'}
        </button>

        {pool.length === 0 && (
          <div className="notice notice-danger" style={{ marginTop: 12 }}>
            <span aria-hidden="true">⚠️</span>
            <div>这个分类下还没有菜，换一个分类或者取消限制。</div>
          </div>
        )}

        {/* 抽中之后的下一步。
            这里**只放「接受这个结果」的动作** —— 摇这件事归上面那个大按钮管，
            抽中之后它的文案就是「再摇一次」。以前这里还并排塞了个「再来一次」，
            和大按钮干的是同一件事、长得还不一样，看着犯嘀咕（2026-09-10 用户报的）。
            以后要加就加新动作，别再往这里放第二个摇的入口。 */}
        {result && !rolling && (
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={async () => {
                const added = await addToMenu(todayKey(), [result.id])
                toast(added ? `已把「${result.name}」加入今日菜单` : '今日菜单里已经有它了')
              }}
            >
              <CIcon name="plus" /> 加入今日菜单
            </button>
          </div>
        )}

        <h3 className="section-title">抽取范围</h3>

        <div className="chip-row">
          <button
            type="button"
            className={`chip${category === null ? ' on' : ''}`}
            onClick={() => setCategory(null)}
          >
            全部 {recipes.length}
          </button>
          {availableCategories.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip${category === c ? ' on' : ''}`}
              data-cat={c}
              style={{ '--tilt': tiltOf(c, 0.8) } as CSSProperties}
              onClick={() => setCategory(category === c ? null : c)}
            >
              {c}
            </button>
          ))}
        </div>

        {category && (
          <button
            type="button"
            className={`check-row${limitToCategory ? ' on' : ''}`}
            onClick={() => setLimitToCategory((v) => !v)}
          >
            <span className="check-box" aria-hidden="true">
              {limitToCategory ? '✓' : ''}
            </span>
            <span className="check-label">只在「{category}」里抽</span>
          </button>
        )}
      </div>
    </>
  )
}
