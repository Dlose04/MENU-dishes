/** 标签栏的三个页签。设置不在里面，它挂在页脚上（见 Footer.tsx）。 */
export type TabKey = 'library' | 'today' | 'random'

const TABS: Array<{ key: TabKey; label: string; emoji: string }> = [
  { key: 'library', label: '菜谱本', emoji: '📖' },
  { key: 'today', label: '今日菜单', emoji: '🍽️' },
  { key: 'random', label: '抽签点菜', emoji: '🎲' },
]

export function TabBar({
  tab,
  onChange,
}: {
  tab: TabKey
  onChange: (key: TabKey) => void
}) {
  return (
    <nav className="tabbar" aria-label="主导航">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`tab${tab === t.key ? ' active' : ''}`}
          aria-current={tab === t.key ? 'page' : undefined}
          onClick={() => onChange(t.key)}
        >
          <span className="tab-emoji" aria-hidden="true">
            {t.emoji}
          </span>
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
