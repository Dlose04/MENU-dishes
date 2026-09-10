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
import { dataURLToBlob } from '../lib/image'
import { SEED_PHOTOS } from './seed-photos'

interface PresetRecipe {
  name: string
  category: string
  ingredients: string[]
  difficulty: Difficulty
  emoji: string
}

/**
 * 自家常做的那几道。
 *
 * 照片不写在这儿，而是按**菜名**去 SEED_PHOTOS 里取（那份文件由
 * scripts/make-seed-photos.mjs 从 seed-photos/ 生成）。这样菜名一改，
 * 照片对不上就会自然落空，不会串到别的菜身上。
 *
 * 加菜/改菜时记得两边一起改：seed-photos/ 里的文件名序号 → 这个数组的下标。
 */
export const PRESET_RECIPES: PresetRecipe[] = [
  { name: '番茄炒蛋', category: '家常热菜', ingredients: ['番茄', '鸡蛋'], difficulty: '简单', emoji: '🍅' },
  { name: '酸辣土豆丝', category: '素菜', ingredients: ['土豆', '青辣椒', '红辣椒'], difficulty: '简单', emoji: '🥔' },
  { name: '炒香干', category: '素菜', ingredients: ['豆干', '辣椒'], difficulty: '简单', emoji: '🫘' },
  { name: '意祥一碗香', category: '家常热菜', ingredients: ['鸡蛋', '猪肉', '辣椒'], difficulty: '中等', emoji: '🍲' },
  { name: '红烧豆腐', category: '家常热菜', ingredients: ['豆腐', '辣椒'], difficulty: '简单', emoji: '🥘' },
  { name: '干锅包菜', category: '家常热菜', ingredients: ['猪肉', '包菜', '干辣椒'], difficulty: '中等', emoji: '🥬' },
  { name: '辣椒炒肉', category: '家常热菜', ingredients: ['辣椒', '猪肉'], difficulty: '简单', emoji: '🌶️' },
  { name: '火腿炒蛋', category: '家常热菜', ingredients: ['火腿', '鸡蛋'], difficulty: '简单', emoji: '🍳' },
  { name: '美味速食', category: '主食', ingredients: ['螺蛳粉', '火鸡面', '泡面'], difficulty: '简单', emoji: '🍜' },
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

/**
 * 取预置菜的配图。没有就返回 undefined（图比菜少是允许的，卡片会退成 emoji）。
 *
 * 解码失败也当没有：base64 是生成出来的，正常情况下不会坏；真坏了也不该
 * 让整次播种挂掉 —— 丢一张图远比丢一道菜轻。
 */
function presetPhoto(name: string): Blob | undefined {
  const dataUrl = SEED_PHOTOS[name]
  if (!dataUrl) return undefined
  try {
    return dataURLToBlob(dataUrl)
  } catch {
    return undefined
  }
}

/**
 * 预置菜的 id。**必须每台设备算出来都一样**，所以不能随机。
 *
 * 早先用的是 `nanoid()`，代价是：两台设备各自装一遍，同一个「番茄炒蛋」在
 * 两边是两条 id 不同的记录 —— 同步是按 id 认「是不是同一条菜」的，于是
 * 合并之后变成两条重名的菜，照片还各在各的设备上（同步不搬图片）。
 * 用户 2026-09-10 就是这么撞上的。
 *
 * 改成按菜名派生之后，所有设备上「番茄炒蛋」永远是同一条，合并时认得出，
 * 不会重复；「重新载入预置菜谱」也就能在哪台设备上跑都安全。
 *
 * 副作用：改菜名等于换了另一道菜（旧的那条会留在库里）。这可以接受 ——
 * 菜名是用户看得见的东西，改了名字本来就该当成另一道菜。
 */
function presetId(name: string): string {
  return `preset-${name}`
}

/** 生成预置菜谱。id 稳定，所以多台设备/多次调用得到的是**同一批**记录。 */
export function buildSeedRecipes(): Recipe[] {
  const now = Date.now()
  return PRESET_RECIPES.map((p, i) => ({
    id: presetId(p.name),
    name: p.name,
    category: p.category,
    ingredients: [...p.ingredients],
    difficulty: p.difficulty,
    emoji: p.emoji,
    imageBlob: presetPhoto(p.name),
    // 预置菜之间保持稳定顺序
    createdAt: now + i,
  }))
}

/** 播种完成后打标记。 */
export function markSeeded(): void {
  writeSeededFlag()
}
