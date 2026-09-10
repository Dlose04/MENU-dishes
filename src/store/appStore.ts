/**
 * 全局应用状态。
 *
 * 用 useSyncExternalStore 而不是 Context：数据层是被 UI 之外的东西驱动的
 * （分享链接导入、草稿恢复、存储降级探测），一个模块级的 store 比
 * 层层透传 provider 干净，也避免 provider 重渲染整棵树。
 */

import { useSyncExternalStore } from 'react'
import type { Menu, Recipe, RecipeDraft } from '../types'
import {
  initStorage,
  StorageQuotaError,
  type StorageDriver,
  type StorageMode,
} from '../db/storage'
import { buildSeedRecipes, markSeeded, shouldSeed } from '../db/seed'
import { nanoid } from '../lib/nanoid'
import { todayKey } from '../lib/date'
import { buildBackup, parseBackup } from '../lib/backup'
import { toast } from './toast'

export interface AppState {
  ready: boolean
  mode: StorageMode
  /** 降级/受限时的提示文案 */
  warning: string | null
  recipes: Recipe[]
  menus: Menu[]
}

let state: AppState = {
  ready: false,
  mode: 'indexeddb',
  warning: null,
  recipes: [],
  menus: [],
}

let driver: StorageDriver | null = null
const listeners = new Set<() => void>()

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): AppState {
  return state
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useRecipes(): Recipe[] {
  return useAppState().recipes
}

export function getState(): AppState {
  return state
}

/* ------------------------------------------------------------------ */
/* 错误处理                                                            */
/* ------------------------------------------------------------------ */

function reportError(err: unknown, fallbackMessage: string): void {
  console.error('[family-menu]', err)
  if (err instanceof StorageQuotaError) {
    toast(err.message, { duration: 6000 })
    return
  }
  const msg = err instanceof Error ? err.message : ''
  toast(msg && msg.length < 60 ? `${fallbackMessage}：${msg}` : fallbackMessage, {
    duration: 5000,
  })
}

function requireDriver(): StorageDriver {
  if (!driver) throw new Error('存储还没初始化好')
  return driver
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 排序：按 createdAt 升序。
 * 预置菜在播种时拿到的是「播种时刻 + 序号」，所以它们保持原始编排顺序；
 * 用户之后新增的菜时间戳更大，自然排在后面（手账嘛，新的一页写在后面）。
 * 新建保存后会滚动定位到那张卡片，不用担心「加完找不到」。
 */
function sortRecipes(recipes: Recipe[]): Recipe[] {
  return [...recipes].sort((a, b) => a.createdAt - b.createdAt)
}

let initPromise: Promise<void> | null = null

/** 幂等；App 挂载时调一次即可。 */
export function initStore(): Promise<void> {
  if (initPromise) return initPromise

  initPromise = (async () => {
    try {
      const init = await initStorage()
      driver = init.driver

      let recipes = await init.driver.getAllRecipes()
      const menus = await init.driver.getAllMenus()

      // 只在「库是空的」且「没播种过」时写入预置菜。
      // 两个条件缺一不可，详见 db/seed.ts 的注释。
      if (shouldSeed(recipes.length)) {
        const seed = buildSeedRecipes()
        try {
          await init.driver.putRecipes(seed)
          recipes = seed
        } catch (err) {
          // 播种失败不该挡住应用启动
          reportError(err, '预置菜谱写入失败')
        }
        markSeeded()
      } else if (recipes.length === 0) {
        // 空库 + 已播种过（用户自己清空的），不打扰
      }

      setState({
        ready: true,
        mode: init.mode,
        warning: init.warning,
        recipes: sortRecipes(recipes),
        menus,
      })
    } catch (err) {
      // 连兜底存储都挂了：标记 ready，让 UI 至少能显示空状态和错误提示
      console.error('[family-menu] 初始化失败', err)
      setState({
        ready: true,
        mode: 'localstorage',
        warning: '本地存储初始化失败，本次改动可能无法保存。',
        recipes: [],
        menus: [],
      })
    }
  })()

  return initPromise
}

/* ------------------------------------------------------------------ */
/* 菜谱增删改                                                          */
/* ------------------------------------------------------------------ */

export async function createRecipe(draft: RecipeDraft): Promise<Recipe | null> {
  try {
    const recipe: Recipe = {
      ...draft,
      id: nanoid(),
      createdAt: Date.now(),
    }
    await requireDriver().putRecipes([recipe])
    setState({ recipes: sortRecipes([...state.recipes, recipe]) })
    return recipe
  } catch (err) {
    reportError(err, '保存失败')
    return null
  }
}

export async function updateRecipe(
  id: string,
  draft: RecipeDraft,
): Promise<Recipe | null> {
  try {
    const existing = state.recipes.find((r) => r.id === id)
    if (!existing) return null
    // createdAt 和 id 保持不变，否则排序会跳
    const next: Recipe = { ...existing, ...draft, id, createdAt: existing.createdAt }
    await requireDriver().putRecipes([next])
    setState({ recipes: sortRecipes(state.recipes.map((r) => (r.id === id ? next : r))) })
    return next
  } catch (err) {
    reportError(err, '保存失败')
    return null
  }
}

/** 只换图/只改一个字段的轻量更新。 */
export async function patchRecipe(id: string, patch: Partial<Recipe>): Promise<boolean> {
  try {
    const existing = state.recipes.find((r) => r.id === id)
    if (!existing) return false
    const next: Recipe = { ...existing, ...patch, id, createdAt: existing.createdAt }
    await requireDriver().putRecipes([next])
    setState({ recipes: sortRecipes(state.recipes.map((r) => (r.id === id ? next : r))) })
    return true
  } catch (err) {
    reportError(err, '保存失败')
    return false
  }
}

/** 复制一份（做变体用）。返回新菜谱。 */
export async function duplicateRecipe(id: string): Promise<Recipe | null> {
  const src = state.recipes.find((r) => r.id === id)
  if (!src) return null
  return createRecipe({
    name: `${src.name} 2`,
    category: src.category,
    ingredients: [...src.ingredients],
    difficulty: src.difficulty,
    emoji: src.emoji,
    note: src.note,
    imageBlob: src.imageBlob,
  })
}

export interface DeletedPayload {
  recipes: Recipe[]
  /** 删除前这些菜所在的菜单，撤销时一并还原 */
  menus: Menu[]
}

/**
 * 删除菜谱。同时把它们从所有日期的菜单里摘掉，
 * 否则菜单里会留下指向不存在菜谱的 id（分享时就会漏菜）。
 * 返回被删的数据，供「撤销」还原。
 */
export async function deleteRecipes(ids: string[]): Promise<DeletedPayload | null> {
  if (!ids.length) return null
  const drop = new Set(ids)
  const removed = state.recipes.filter((r) => drop.has(r.id))
  if (!removed.length) return null

  const affectedMenus = state.menus.filter((m) => m.items.some((i) => drop.has(i)))
  const nextMenus = state.menus.map((m) =>
    m.items.some((i) => drop.has(i))
      ? { date: m.date, items: m.items.filter((i) => !drop.has(i)) }
      : m,
  )

  try {
    const d = requireDriver()
    await d.deleteRecipes(ids)
    for (const m of nextMenus) {
      if (affectedMenus.some((old) => old.date === m.date)) {
        await d.putMenu(m)
      }
    }
    setState({
      recipes: state.recipes.filter((r) => !drop.has(r.id)),
      menus: nextMenus,
    })
    return { recipes: removed, menus: affectedMenus }
  } catch (err) {
    reportError(err, '删除失败')
    return null
  }
}

/** 撤销删除。 */
export async function restoreDeleted(payload: DeletedPayload): Promise<void> {
  try {
    const d = requireDriver()
    await d.putRecipes(payload.recipes)
    for (const m of payload.menus) await d.putMenu(m)

    const byId = new Map(state.recipes.map((r) => [r.id, r]))
    for (const r of payload.recipes) byId.set(r.id, r)

    const menuByDate = new Map(state.menus.map((m) => [m.date, m]))
    for (const m of payload.menus) menuByDate.set(m.date, m)

    setState({
      recipes: sortRecipes([...byId.values()]),
      menus: [...menuByDate.values()],
    })
  } catch (err) {
    reportError(err, '撤销失败')
  }
}

/** 批量改分类。 */
export async function bulkSetCategory(ids: string[], category: string): Promise<number> {
  const targets = state.recipes.filter((r) => ids.includes(r.id))
  if (!targets.length) return 0
  const next = targets.map((r) => ({ ...r, category }))
  try {
    await requireDriver().putRecipes(next)
    const byId = new Map(next.map((r) => [r.id, r]))
    setState({ recipes: state.recipes.map((r) => byId.get(r.id) ?? r) })
    return next.length
  } catch (err) {
    reportError(err, '批量修改失败')
    return 0
  }
}

/* ------------------------------------------------------------------ */
/* 今日菜单                                                            */
/* ------------------------------------------------------------------ */

export function getMenu(date: string): Menu {
  return state.menus.find((m) => m.date === date) ?? { date, items: [] }
}

async function saveMenu(menu: Menu): Promise<void> {
  try {
    await requireDriver().putMenu(menu)
    const exists = state.menus.some((m) => m.date === menu.date)
    const menus = exists
      ? state.menus.map((m) => (m.date === menu.date ? menu : m))
      : [...state.menus, menu]
    setState({ menus })
  } catch (err) {
    reportError(err, '菜单保存失败')
  }
}

export async function toggleMenuItem(date: string, recipeId: string): Promise<void> {
  const current = getMenu(date)
  const items = current.items.includes(recipeId)
    ? current.items.filter((i) => i !== recipeId)
    : [...current.items, recipeId]
  await saveMenu({ date, items })
}

export async function setMenuItems(date: string, items: string[]): Promise<void> {
  await saveMenu({ date, items })
}

/** 把若干道菜并进某天的菜单（已存在的跳过）。 */
export async function addToMenu(date: string, recipeIds: string[]): Promise<number> {
  const current = getMenu(date)
  const set = new Set(current.items)
  let added = 0
  for (const id of recipeIds) {
    if (!set.has(id) && state.recipes.some((r) => r.id === id)) {
      set.add(id)
      added++
    }
  }
  if (added) await saveMenu({ date, items: [...set] })
  return added
}

export async function clearMenu(date: string): Promise<void> {
  await saveMenu({ date, items: [] })
}

/* ------------------------------------------------------------------ */
/* 导入 / 导出                                                         */
/* ------------------------------------------------------------------ */

export interface ExportResult {
  filename: string
  text: string
  imageCount: number
  bytes: number
}

export async function exportLibrary(): Promise<ExportResult | null> {
  try {
    const { text, imageCount } = await buildBackup(state.recipes, state.menus)
    return {
      filename: `小雨点菜手账-菜谱库-${todayKey()}.json`,
      text,
      imageCount,
      bytes: new Blob([text]).size,
    }
  } catch (err) {
    reportError(err, '导出失败')
    return null
  }
}

export interface ImportResult {
  added: number
  skippedExisting: number
  invalid: number
  menusMerged: number
}

/**
 * 导入菜谱库：按 id 去重合并。
 * 已存在的 id **不覆盖**本地版本 —— 本地是你正在用的那份，
 * 被一个旧备份悄悄改掉是最难排查的一类数据事故。
 */
export async function importLibrary(text: string): Promise<ImportResult | null> {
  try {
    const parsed = parseBackup(text)
    const existingIds = new Set(state.recipes.map((r) => r.id))

    const fresh = parsed.recipes.filter((r) => !existingIds.has(r.id))
    const skippedExisting = parsed.recipes.length - fresh.length

    if (fresh.length) await requireDriver().putRecipes(fresh)

    // 菜单合并：同一天取并集，只保留本地还认识的菜
    const knownIds = new Set([...existingIds, ...fresh.map((r) => r.id)])
    const menuByDate = new Map(state.menus.map((m) => [m.date, m]))
    let menusMerged = 0
    for (const incoming of parsed.menus) {
      const local = menuByDate.get(incoming.date)
      const merged = local
        ? { date: incoming.date, items: [...new Set([...local.items, ...incoming.items])] }
        : { date: incoming.date, items: incoming.items }
      const cleaned = {
        date: merged.date,
        items: merged.items.filter((i) => knownIds.has(i)),
      }
      if (!local || cleaned.items.length !== local.items.length) {
        await requireDriver().putMenu(cleaned)
        menuByDate.set(cleaned.date, cleaned)
        menusMerged++
      }
    }

    setState({
      recipes: sortRecipes([...state.recipes, ...fresh]),
      menus: [...menuByDate.values()],
    })

    return {
      added: fresh.length,
      skippedExisting,
      invalid: parsed.skipped,
      menusMerged,
    }
  } catch (err) {
    // 解析类错误（选错文件）直接把原因告诉用户
    const msg = err instanceof Error ? err.message : '导入失败'
    toast(msg, { duration: 5000 })
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 危险操作                                                            */
/* ------------------------------------------------------------------ */

/**
 * 清空所有数据。**保留 seeded 标记** —— 这正是那个标记存在的意义：
 * 用户清空之后不该再冒出 12 道预置菜。
 * 想回到出厂状态，用「重新载入预置菜谱」那个按钮。
 */
export async function clearAllData(): Promise<void> {
  try {
    await requireDriver().clearAll()
    setState({ recipes: [], menus: [] })
  } catch (err) {
    reportError(err, '清空失败')
  }
}

export interface ReseedResult {
  /** 新补进来的菜 */
  added: number
  /** 同名菜原来没图，这次把预置照片补上了 */
  photoFilled: number
}

/**
 * 重新写入预置菜谱。已存在的同名菜**跳过**，绝不覆盖用户的改动
 * （改过的分类、加过的备注、自己换的照片都得留着）。
 *
 * 唯一的例外是配图：同名菜如果**还没有照片**，而预置菜现在有，就把照片补上。
 *
 * 起因：预置菜从通用家常菜换成了自家那 9 道，而其中「番茄炒蛋」「酸辣土豆丝」
 * 老库里的同名菜会命中「跳过」分支。结果就是用户点完「重新载入预置菜谱」，
 * 新菜都进来了，这两道却还是没图的旧样子 —— 而他现在最想要的恰恰是照片。
 *
 * 只在「本来是空的」时候补：用户自己选过的照片一律不动。
 */
export async function reseedPresets(): Promise<ReseedResult> {
  try {
    const byName = new Map(state.recipes.map((r) => [r.name, r]))
    const added: Recipe[] = []
    const photoPatched: Recipe[] = []

    for (const preset of buildSeedRecipes()) {
      const existing = byName.get(preset.name)
      if (!existing) {
        added.push(preset)
        continue
      }
      if (!existing.imageBlob && preset.imageBlob) {
        photoPatched.push({ ...existing, imageBlob: preset.imageBlob })
      }
    }

    const changed = [...added, ...photoPatched]
    if (changed.length) {
      await requireDriver().putRecipes(changed)
      const patchedById = new Map(photoPatched.map((r) => [r.id, r]))
      const merged = state.recipes.map((r) => patchedById.get(r.id) ?? r)
      setState({ recipes: sortRecipes([...merged, ...added]) })
    }
    markSeeded()
    return { added: added.length, photoFilled: photoPatched.length }
  } catch (err) {
    reportError(err, '载入预置菜谱失败')
    return { added: 0, photoFilled: 0 }
  }
}

