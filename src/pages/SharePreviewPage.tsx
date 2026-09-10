import { useMemo, useState } from 'react'
import type { ShareDish } from '../types'
import { Tape } from '../components/Tape'
import { CIcon } from '../components/icons'
import { createRecipe, setMenuItems, useRecipes } from '../store/appStore'
import { toast } from '../store/toast'
import { todayKey, formatDateKey } from '../lib/date'
import type { TabKey } from '../components/TabBar'

interface SharePreviewPageProps {
  dishes: ShareDish[]
  /** 退出预览，回到自己的手账 */
  onExit: (tab?: TabKey) => void
}

const DEFAULT_CATEGORY = '家常热菜'
const DEFAULT_EMOJI = '🍽️'

export function SharePreviewPage({ dishes, onExit }: SharePreviewPageProps) {
  const recipes = useRecipes()
  const [busy, setBusy] = useState(false)

  const today = todayKey()

  // 哪些菜是本库已有的（按菜名认，分享链接里只有菜名可认）
  const knownNames = useMemo(() => {
    const set = new Set<string>()
    for (const r of recipes) set.add(r.name.trim())
    return set
  }, [recipes])

  const newOnes = dishes.filter((d) => !knownNames.has(d.n.trim()))

  /**
   * 把分享来的菜落到本地：
   *   本库有同名菜 → 直接用它（不重复建，也不改用户已有的数据）
   *   没有 → 建一条精简菜谱（只有名字/分类/emoji，图片和食材留空）
   */
  const resolveLocalIds = async (): Promise<{ ids: string[]; created: number }> => {
    const working = [...recipes]
    const ids: string[] = []
    let created = 0

    for (const dish of dishes) {
      const name = dish.n.trim()
      if (!name) continue
      let hit = working.find((r) => r.name.trim() === name)

      if (!hit) {
        const fresh = await createRecipe({
          name,
          category: dish.c || DEFAULT_CATEGORY,
          ingredients: [],
          difficulty: '简单',
          emoji: dish.e || DEFAULT_EMOJI,
        })
        if (fresh) {
          working.push(fresh)
          hit = fresh
          created++
        }
      }

      if (hit && !ids.includes(hit.id)) ids.push(hit.id)
    }

    return { ids, created }
  }

  const saveToToday = async () => {
    setBusy(true)
    try {
      const { ids } = await resolveLocalIds()
      if (!ids.length) {
        toast('这份菜单是空的')
        return
      }
      await setMenuItems(today, ids)
      toast(`已存到今天的菜单（${ids.length} 道）`)
      onExit('today')
    } finally {
      setBusy(false)
    }
  }

  const saveAllToLibrary = async () => {
    setBusy(true)
    try {
      const { created } = await resolveLocalIds()
      toast(created ? `已加入菜谱库：新增 ${created} 道` : '这些菜你库里都有了')
      onExit('library')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="app-head">
        <h1 className="app-title">分享的菜单</h1>
        <div className="app-head-side">
          <button type="button" className="btn btn-sm" onClick={() => onExit()}>
            回我的手账
          </button>
        </div>
      </header>

      <div className="page" style={{ paddingBottom: 120 }}>
        <div className="notice notice-info">
          <span aria-hidden="true">📬</span>
          <div>
            这是对方分享的菜单，一共 {dishes.length} 道菜。
            <br />
            链接里只带了菜名、分类和图标（图片塞不进网址），所以这里用 emoji 代替。
          </div>
        </div>

        <div className="card" style={{ marginTop: 14 }}>
          <Tape />
          <p style={{ margin: '10px 0 4px', fontSize: 15, color: 'var(--ink-soft)' }}>
            {formatDateKey(today)} 的菜单
          </p>
          {dishes.map((d, i) => (
            <div className="share-item" key={`${d.n}-${i}`}>
              <span className="share-emoji" aria-hidden="true">
                {d.e || DEFAULT_EMOJI}
              </span>
              <span className="share-name">{d.n}</span>
              {d.c && (
                <span className="tag" data-cat={d.c}>
                  {d.c}
                </span>
              )}
            </div>
          ))}
        </div>

        <p className="subtitle" style={{ marginTop: 14 }}>
          其中 {dishes.length - newOnes.length} 道你已经有，{newOnes.length} 道是新的。
        </p>

        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn"
            style={{ flex: '1 1 100%' }}
            onClick={() => onExit()}
          >
            只看一眼，不存
          </button>
        </div>
      </div>

      <div className="bottom-bar">
        <button
          type="button"
          className="btn btn-primary"
          style={{ flex: 1 }}
          disabled={busy}
          onClick={() => void saveToToday()}
        >
          <CIcon name="check" size={16} /> 存到我的今日菜单
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          disabled={busy || newOnes.length === 0}
          onClick={() => void saveAllToLibrary()}
        >
          <CIcon name="download" size={16} />
          全部加入菜谱库
        </button>
      </div>
    </>
  )
}
