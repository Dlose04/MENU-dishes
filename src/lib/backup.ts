/**
 * 菜谱库的导出 / 导入（跨设备同步用）。
 *
 * 图片是 Blob，JSON 里放不下，导出时转成 dataURL 一起带走。
 * 所以文件可能很大（几张图就上 MB），UI 上要提前跟用户说清楚。
 */

import type { Menu, Recipe } from '../types'
import { blobToDataURL, dataURLToBlob } from './image'

export const BACKUP_APP_ID = 'family-menu'
export const BACKUP_VERSION = 1

/** 导出文件里的菜谱：imageBlob 换成了 dataURL 字符串。 */
export interface BackupRecipe extends Omit<Recipe, 'imageBlob'> {
  image?: string
}

export interface BackupFile {
  app: typeof BACKUP_APP_ID
  version: number
  exportedAt: string
  recipes: BackupRecipe[]
  menus: Menu[]
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

function guessMimeFromDataUrl(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl)
  return m ? m[1] : 'image/jpeg'
}

/** 菜谱数组 -> 可下载的备份对象（图片转 base64）。 */
export async function buildBackup(
  recipes: Recipe[],
  menus: Menu[],
): Promise<{ file: BackupFile; text: string; imageCount: number }> {
  let imageCount = 0
  const out: BackupRecipe[] = []

  for (const r of recipes) {
    const { imageBlob, ...rest } = r
    const item: BackupRecipe = { ...rest }
    if (imageBlob) {
      try {
        item.image = await blobToDataURL(imageBlob)
        imageCount++
      } catch {
        // 单张图读失败不该让整次导出失败
      }
    }
    out.push(item)
  }

  const file: BackupFile = {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    recipes: out,
    menus,
  }

  return { file, text: JSON.stringify(file, null, 2), imageCount }
}

export interface ParsedImport {
  recipes: Recipe[]
  menus: Menu[]
  /** 文件里有多少条记录因为格式不对被丢掉 */
  skipped: number
}

function parseRecipe(raw: unknown): Recipe | null {
  if (!isObj(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!id || !name) return null

  const ingredients = Array.isArray(raw.ingredients)
    ? raw.ingredients.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : []

  let imageBlob: Blob | undefined
  if (typeof raw.image === 'string' && raw.image.startsWith('data:')) {
    try {
      imageBlob = dataURLToBlob(raw.image)
      // 修一下 MIME：有些导出工具会把类型写丢
      if (!imageBlob.type || imageBlob.type === 'application/octet-stream') {
        imageBlob = new Blob([imageBlob], { type: guessMimeFromDataUrl(raw.image) })
      }
    } catch {
      imageBlob = undefined
    }
  }

  const difficulty =
    raw.difficulty === '简单' || raw.difficulty === '中等' || raw.difficulty === '较难'
      ? raw.difficulty
      : '简单'

  return {
    id,
    name,
    category: typeof raw.category === 'string' ? raw.category : '',
    ingredients,
    difficulty,
    emoji: typeof raw.emoji === 'string' && raw.emoji ? raw.emoji : '🍽️',
    note: typeof raw.note === 'string' && raw.note ? raw.note : undefined,
    imageBlob,
    createdAt:
      typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now(),
  }
}

/**
 * 解析导入文件。永远不会抛异常 —— 用户可能选错文件，
 * 那种情况应该给一句人话提示，而不是白屏。
 */
export function parseBackup(text: string): ParsedImport {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('这个文件不是合法的 JSON，可能选错了文件')
  }

  if (!isObj(data)) throw new Error('文件内容不是一个对象')

  // 只认自己的导出格式，但允许用户直接丢一个菜谱数组进来
  const rawRecipes = Array.isArray(data.recipes)
    ? data.recipes
    : Array.isArray(data)
      ? (data as unknown[])
      : null

  if (!rawRecipes) {
    throw new Error('文件里没有 recipes 字段，不像是本应用的导出文件')
  }

  const recipes: Recipe[] = []
  let skipped = 0
  for (const raw of rawRecipes) {
    const r = parseRecipe(raw)
    if (r) recipes.push(r)
    else skipped++
  }

  const menus: Menu[] = []
  if (Array.isArray(data.menus)) {
    for (const raw of data.menus) {
      if (!isObj(raw)) continue
      const date = typeof raw.date === 'string' ? raw.date : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      const items = Array.isArray(raw.items)
        ? raw.items.filter((x): x is string => typeof x === 'string')
        : []
      menus.push({ date, items })
    }
  }

  return { recipes, menus, skipped }
}
