import { formatDateKey, todayKey } from '../lib/date'

/** 封面：行楷大标题 + 波浪红线 + 一张斜贴的日期便签。 */
export function BookCover() {
  // formatDateKey 一律走本地时区，不会像 toISOString 那样在东八区凌晨差一天
  const dateline = formatDateKey(todayKey())

  return (
    <header className="bookcover">
      <span className="sticker s1" aria-hidden="true">
        🍳
      </span>
      <span className="sticker s2" aria-hidden="true">
        🥢
      </span>

      <h1>家庭点菜手账</h1>
      <p className="sub">今天吃点什么好呢</p>

      <span className="dateline">{dateline}</span>
    </header>
  )
}
