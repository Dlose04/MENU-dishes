/** 日期工具。注意：一律用本地时区，绝对不要用 toISOString() 取日期。 */

/**
 * 本地时区的 YYYY-MM-DD。
 * 用 toISOString().slice(0,10) 在东八区会踩坑：凌晨 0~8 点会算成前一天。
 */
export function toDateKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayKey(): string {
  return toDateKey(new Date())
}

/** 'YYYY-MM-DD' -> Date（本地零点） */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function shiftDateKey(key: string, days: number): string {
  const d = fromDateKey(key)
  d.setDate(d.getDate() + days)
  return toDateKey(d)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 把日期键渲染成「9月10日 周三」这种好读的样子。 */
export function formatDateKey(key: string): string {
  const d = fromDateKey(key)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`
}

/** 相对今天的友好描述，用于历史菜单列表。 */
export function describeDateKey(key: string): string {
  const today = todayKey()
  if (key === today) return '今天'
  if (key === shiftDateKey(today, -1)) return '昨天'
  if (key === shiftDateKey(today, 1)) return '明天'
  return formatDateKey(key)
}
