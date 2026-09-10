/**
 * 时间戳语义。跨设备同步的全部新旧判断都从这里取，**不要在各处自己写
 * `r.updatedAt ?? r.createdAt`** —— 那样迟早有一处写漏，而写漏的表现是
 * 「某条数据在某些设备上同步不动」，极难排查。
 *
 * 为什么 updatedAt 是可选的：它是后加的字段。老用户的 IndexedDB 里、
 * 以及之前导出的备份文件里，都没有这个字段。做成必填的话要么得写迁移，
 * 要么读旧数据时到处是 undefined 比较 —— 两者都比「读的时候兜底一次」差。
 */

import type { Menu, Recipe } from '../types'

/** 菜谱的最后修改时间，缺字段的老数据按创建时间算。 */
export function recipeStamp(recipe: Pick<Recipe, 'createdAt' | 'updatedAt'>): number {
  return recipe.updatedAt ?? recipe.createdAt
}

/** 菜单的最后修改时间。老菜单没有这个字段，算作 0（最旧，让任何改动都赢它）。 */
export function menuStamp(menu: Pick<Menu, 'updatedAt'>, fallback = 0): number {
  return menu.updatedAt ?? fallback
}

/**
 * 打上「刚刚改过」的时间戳。
 *
 * 为什么单调递增：同一台设备上连着改两次，`Date.now()` 有可能返回相同的毫秒
 * （浏览器的时间精度被隐私设置降级时尤其常见），于是两条记录时间戳相同，
 * 合并时就得靠兜底规则分胜负 —— 那等于把确定性交给了运气。
 * 这里保证每次改都比上一条大 1 毫秒，代价只是时间戳最多比真实时间快几毫秒。
 */
let lastStamp = 0

export function nextStamp(now = Date.now()): number {
  lastStamp = now > lastStamp ? now : lastStamp + 1
  return lastStamp
}

/** 测试用：重置单调时钟。 */
export function resetStampClock(): void {
  lastStamp = 0
}
