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
  /**
   * 最后修改时间（本地时钟）。跨设备同步靠它判新旧：同一道菜两边都有时，
   * 时间戳大的那个赢。
   *
   * **可选**：这个字段是后加的，老数据里没有。读的时候一律按
   * `updatedAt ?? createdAt` 处理（见 lib/stamp.ts），所以不需要数据迁移，
   * 也不会因为某条记录缺字段就判不出新旧。
   */
  updatedAt?: number
  /**
   * 删除墓碑。有值 = 这条已经删了，但「删除」这个动作本身还得同步给别的设备，
   * 所以记录留在库里（**图片会被剥掉**，只剩几个字节）。
   *
   * 没有它的话：你在手机上删了一道菜，平板上那份会在下次同步时把它加回来 ——
   * 这是同步最经典、也最让用户困惑的一个 bug。
   */
  deletedAt?: number
}

/** 新建/编辑表单里的菜谱数据（还没有 id 和创建时间）。 */
export type RecipeDraft = Omit<Recipe, 'id' | 'createdAt'>

export interface Menu {
  /** YYYY-MM-DD（本地时区） */
  date: string
  /** 已选菜谱的 id 数组 */
  items: string[]
  /**
   * 最后修改时间。菜单**不需要墓碑** —— 清空菜单是「items 变成空数组」，
   * 一份空菜单配上更新的时间戳，天然就能把「清空」这个动作带过去。
   */
  updatedAt?: number
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
