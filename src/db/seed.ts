/**
 * 首次使用的预置菜谱。
 *
 * 两个关键点，都是踩过坑的：
 *
 * 1. 判断依据是「数据库为空」而不是「第一次启动」—— 用户可能手动清空了菜谱，
 *    也可能换了浏览器，这两种情况数据库都是空的。
 * 2. 另外在 localStorage 里存一个 seeded 标记，保证**只播种一次**。
 *    没有这个标记的话，用户把预置菜全删了，下次打开又会全部冒出来。
 *
 * 播种进去之后就是普通数据：能改名、能换分类、能换图、能删除，
 * 不会被下一次启动覆盖。
 */

import type { Difficulty, Recipe } from '../types'
import { nanoid } from '../lib/nanoid'

interface PresetRecipe {
  name: string
  category: string
  ingredients: string[]
  difficulty: Difficulty
  emoji: string
}

export const PRESET_RECIPES: PresetRecipe[] = [
  { name: '番茄炒蛋', category: '家常热菜', ingredients: ['番茄', '鸡蛋', '小葱'], difficulty: '简单', emoji: '🍅' },
  { name: '青椒肉丝', category: '家常热菜', ingredients: ['青椒', '猪里脊', '蒜'], difficulty: '简单', emoji: '🫑' },
  { name: '酸辣土豆丝', category: '家常热菜', ingredients: ['土豆', '干辣椒', '陈醋'], difficulty: '简单', emoji: '🥔' },
  { name: '麻婆豆腐', category: '家常热菜', ingredients: ['嫩豆腐', '牛肉末', '豆瓣酱', '花椒'], difficulty: '中等', emoji: '🌶️' },
  { name: '红烧肉', category: '硬菜', ingredients: ['五花肉', '冰糖', '八角', '生抽'], difficulty: '中等', emoji: '🥩' },
  { name: '宫保鸡丁', category: '硬菜', ingredients: ['鸡胸肉', '花生米', '干辣椒'], difficulty: '中等', emoji: '🍗' },
  { name: '可乐鸡翅', category: '硬菜', ingredients: ['鸡中翅', '可乐', '姜片'], difficulty: '简单', emoji: '🥤' },
  { name: '清蒸鲈鱼', category: '硬菜', ingredients: ['鲈鱼', '葱姜', '蒸鱼豉油'], difficulty: '中等', emoji: '🐟' },
  { name: '糖醋排骨', category: '硬菜', ingredients: ['肋排', '香醋', '冰糖'], difficulty: '较难', emoji: '🍖' },
  { name: '蒜蓉西兰花', category: '素菜', ingredients: ['西兰花', '蒜'], difficulty: '简单', emoji: '🥦' },
  { name: '干煸四季豆', category: '素菜', ingredients: ['四季豆', '肉末', '干辣椒'], difficulty: '中等', emoji: '🫛' },
  { name: '紫菜蛋花汤', category: '汤羹', ingredients: ['紫菜', '鸡蛋', '虾皮'], difficulty: '简单', emoji: '🍲' },
]

const SEEDED_KEY = 'family-menu:seeded'

function readSeededFlag(): boolean {
  try {
    return localStorage.getItem(SEEDED_KEY) === '1'
  } catch {
    // 读不到 localStorage（完全禁用的极端情况）：退化成「看数据库空不空」
    return false
  }
}

function writeSeededFlag(): void {
  try {
    localStorage.setItem(SEEDED_KEY, '1')
  } catch {
    /* 写不进去就算了，不影响使用 */
  }
}

/**
 * 要不要写入预置数据。
 * @param existingRecipeCount 当前数据库里的菜谱条数
 */
export function shouldSeed(existingRecipeCount: number): boolean {
  if (existingRecipeCount > 0) return false
  return !readSeededFlag()
}

/** 生成预置菜谱（每次调用 id 都不同，所以只在真正播种时调用一次）。 */
export function buildSeedRecipes(): Recipe[] {
  const now = Date.now()
  return PRESET_RECIPES.map((p, i) => ({
    id: nanoid(),
    name: p.name,
    category: p.category,
    ingredients: [...p.ingredients],
    difficulty: p.difficulty,
    emoji: p.emoji,
    // 预置菜之间保持稳定顺序
    createdAt: now + i,
  }))
}

/** 播种完成后打标记。 */
export function markSeeded(): void {
  writeSeededFlag()
}
