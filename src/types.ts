/** 全应用共用的数据类型定义。 */

export const CATEGORIES = [
  '家常热菜',
  '硬菜',
  '素菜',
  '汤羹',
  '凉菜',
  '主食',
  '甜品',
] as const

export type Category = (typeof CATEGORIES)[number]

export const DIFFICULTIES = ['简单', '中等', '较难'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

/** 菜谱库中最常用的 emoji，供用户快速挑一个当兜底图标。 */
export const EMOJI_PALETTE = [
  '🍅', '🥚', '🫑', '🥔', '🌶️', '🥩', '🍗', '🐟', '🍖', '🥦',
  '🫛', '🍲', '🍜', '🍚', '🥟', '🍤', '🍄', '🥬', '🥕', '🌽',
  '🍆', '🥒', '🧄', '🫘', '🍞', '🥛', '🍮', '🍰', '🍵', '🥗',
]

export interface Recipe {
  /** nanoid */
  id: string
  name: string
  category: string
  ingredients: string[]
  difficulty: Difficulty
  /** 没有图片时的兜底图标 */
  emoji: string
  /** 做法备注 */
  note?: string
  /** 用户从相册选的图，压缩后以 Blob 存 IndexedDB */
  imageBlob?: Blob
  createdAt: number
}

/** 新建/编辑表单里的菜谱数据（还没有 id 和创建时间）。 */
export type RecipeDraft = Omit<Recipe, 'id' | 'createdAt'>

export interface Menu {
  /** YYYY-MM-DD（本地时区） */
  date: string
  /** 已选菜谱的 id 数组 */
  items: string[]
}

/**
 * 分享链接里传输的精简菜谱。
 * 刻意只保留三个字段：菜名 / 分类 / emoji。
 * 图片和食材一律不进链接（base64 图片塞进 URL 会超长，微信会截断）。
 */
export interface ShareDish {
  n: string
  c: string
  e: string
}
