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
import { nextStamp } from '../lib/stamp'
import { buildBackup, parseBackup } from '../lib/backup'
import { mergePayload, toSyncRecipe, type SyncPayload } from '../sync/merge'
import { consolidateByName } from '../sync/consolidate'
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
/** 只关心「用户真的改了数据」的那些订阅者（目前是同步模块）。 */
const changeListeners = new Set<() => void>()

/**
 * `local: false` 表示这次状态变化**不是**用户改的 —— 目前只有两种：
 * 启动时载入、以及同步把合并结果写回来。同步模块靠这个标记决定要不要
 * 安排一次推送，不区分的话「同步写回」会触发「再推一次」，转个不停。
 */
function setState(patch: Partial<AppState>, opts: { local?: boolean } = {}): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
  if (opts.local !== false) changeListeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 用户改动了数据（同步模块用它安排推送）。返回取消订阅的函数。 */
export function subscribeLocalChanges(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
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

/**
 * 去掉墓碑。**只在这一处过滤**，UI 层拿到的 recipes 永远是「活着的菜」。
 *
 * 墓碑（`deletedAt`）是给同步用的：删除这个动作本身也要能传到别的设备，
 * 所以被删的记录留在库里。但它对用户已经不存在了 —— 让它漏进 UI，
 * 表现就是「删掉的菜又出现在列表里」，而且各种计数都会对不上。
 * 统一在这里滤掉，比让每个页面自己记得过滤可靠得多。
 */
function liveRecipes(all: Recipe[]): Recipe[] {
  return all.filter((r) => !r.deletedAt)
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
      let menus = await init.driver.getAllMenus()

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

      // 同一个菜名只留一条（详见 sync/consolidate.ts）。
      // 放在启动时，是因为这个坏状态**已经在库里了** —— 用户不点同步、
      // 断网、云函数到期，都得能自己好。没有重名时它是个纯粹的 no-op，
      // 一条记录都不写。
      try {
        const tidy = consolidateByName(recipes, menus, { stamp: nextStamp() })
        if (tidy.recipeWrites.length || tidy.menuWrites.length) {
          await init.driver.putRecipes(tidy.recipeWrites)
          for (const m of tidy.menuWrites) await init.driver.putMenu(m)
          recipes = tidy.recipes
          menus = tidy.menus
        }
        if (tidy.mergedGroups) {
          toast(`合并了 ${tidy.mergedGroups} 组重名的菜`, { duration: 6000 })
        }
      } catch (err) {
        // 归并失败不该挡住应用启动：最多是列表里还留着重复的菜
        console.error('[family-menu] 同名归并失败', err)
      }

      // local: false —— 这是「载入」，不是用户改的，不该触发一次推送
      setState(
        {
          ready: true,
          mode: init.mode,
          warning: init.warning,
          recipes: sortRecipes(liveRecipes(recipes)),
          menus,
        },
        { local: false },
      )
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
    const stamp = nextStamp()
    const recipe: Recipe = {
      ...draft,
      id: nanoid(),
      createdAt: stamp,
      updatedAt: stamp,
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
    const next: Recipe = {
      ...existing,
      ...draft,
      id,
      createdAt: existing.createdAt,
      updatedAt: nextStamp(),
    }
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
    const next: Recipe = {
      ...existing,
      ...patch,
      id,
      createdAt: existing.createdAt,
      updatedAt: nextStamp(),
    }
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
 *
 * 【为什么不是真删，而是留一条墓碑】
 * 真删的话，另一台设备下回同步会拿着它那份副本把菜加回来 —— 用户在手机上
 * 删的，在平板上又活了。所以删除要留下 `deletedAt` 这个「墓碑」记录，
 * 把「删除」这个动作本身也当数据同步出去。墓碑没有图片，只有几十个字节，
 * 并且**移动端和在设置里清空数据时，用户感知到的仍然是立刻消失**。
 */
export async function deleteRecipes(ids: string[]): Promise<DeletedPayload | null> {
  if (!ids.length) return null
  const drop = new Set(ids)
  const removed = state.recipes.filter((r) => drop.has(r.id))
  if (!removed.length) return null

  const stamp = nextStamp()

  // 墓碑剥掉图片：它唯一的作用是把「这条删了」带到别的设备，
  // 带着照片纯属白占空间（照片是存储占用的大头）。
  const tombstones: Recipe[] = removed.map((r) => {
    const { imageBlob: _imageBlob, ...rest } = r
    return { ...rest, updatedAt: stamp, deletedAt: stamp }
  })

  const affectedMenus = state.menus.filter((m) => m.items.some((i) => drop.has(i)))
  const nextMenus = state.menus.map((m) =>
    m.items.some((i) => drop.has(i))
      ? { date: m.date, items: m.items.filter((i) => !drop.has(i)), updatedAt: stamp }
      : m,
  )

  try {
    const d = requireDriver()
    await d.putRecipes(tombstones)
    for (const m of nextMenus) {
      if (affectedMenus.some((old) => old.date === m.date)) await d.putMenu(m)
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

/**
 * 撤销删除。= 把墓碑撤掉。
 *
 * 必须同时打上**新的** updatedAt：只清 deletedAt 的话，这条记录的时间戳
 * 还停在删除那一刻，而别的设备上（从云端拿到的）那份墓碑时间戳一样 ——
 * 合并时打平，而打平时是「墓碑赢」，于是撤销会被同步反向撤销掉，
 * 菜在下次同步后又没了。
 */
export async function restoreDeleted(payload: DeletedPayload): Promise<void> {
  try {
    const stamp = nextStamp()
    const revived: Recipe[] = payload.recipes.map((r) => {
      const { deletedAt: _deletedAt, ...rest } = r
      return { ...rest, updatedAt: stamp }
    })
    const menus = payload.menus.map((m) => ({ ...m, updatedAt: stamp }))

    const d = requireDriver()
    await d.putRecipes(revived)
    for (const m of menus) await d.putMenu(m)

    const byId = new Map(state.recipes.map((r) => [r.id, r]))
    for (const r of revived) byId.set(r.id, r)

    const menuByDate = new Map(state.menus.map((m) => [m.date, m]))
    for (const m of menus) menuByDate.set(m.date, m)

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
  // 一次批量操作共用一个时间戳：它们本来就是「同一件事」
  const stamp = nextStamp()
  const next = targets.map((r) => ({ ...r, category, updatedAt: stamp }))
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
  // 时间戳在这里统一打上：菜单的每个写入口（勾选、设值、清空、批量加）
  // 都走这个函数，所以不存在「某条路径忘了打时间戳」导致同步不动的情况。
  const stamped: Menu = { ...menu, updatedAt: nextStamp() }
  try {
    await requireDriver().putMenu(stamped)
    const exists = state.menus.some((m) => m.date === stamped.date)
    const menus = exists
      ? state.menus.map((m) => (m.date === stamped.date ? stamped : m))
      : [...state.menus, stamped]
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
  /** 本地有这道菜、但本来没图，这次从备份里补上了 */
  photoFilled: number
  invalid: number
  menusMerged: number
}

/**
 * 导入菜谱库：按 id 去重合并。
 * 已存在的 id **不覆盖**本地版本 —— 本地是你正在用的那份，
 * 被一个旧备份悄悄改掉是最难排查的一类数据事故。
 *
 * 【唯一的例外：补图】
 *
 * 本地有这道菜、但**没有照片**，而备份里有，就把照片补上。其余字段一律不动。
 *
 * 为什么非开这个口子：跨设备同步刻意不搬图片（见 sync/merge.ts），
 * 「照片跟着菜一起到别的设备」唯一走得通的路就是导出/导入备份。
 * 而备份里每道菜的 id 和本地**是同一个**（同一条记录同步过），
 * 于是整批命中「已存在就跳过」—— 用户拿着一个明明带照片的备份，
 * 导完还是一张图都没有，而那句「跳过 N 道已存在」看起来还挺正常。
 *
 * 补图**不改时间戳**：这还是同一份数据、同一个版本，只是把本机缺的那张图
 * 补上。改时间戳会让这条记录无谓地变成「最新」，在别的设备上把人家更新的
 * 改动顶掉。
 */
export async function importLibrary(text: string): Promise<ImportResult | null> {
  try {
    const parsed = parseBackup(text)
    const localById = new Map(state.recipes.map((r) => [r.id, r]))

    const fresh = parsed.recipes.filter((r) => !localById.has(r.id))
    const skippedExisting = parsed.recipes.length - fresh.length

    // 本地这条没图、备份里有 -> 只把图补上。已经有图的一律不动：
    // 那是用户自己选的，比备份里的新。
    const photoFilled = parsed.recipes
      .filter((r) => {
        const local = localById.get(r.id)
        return !!local && !local.imageBlob && !!r.imageBlob
      })
      .map((r) => ({ ...localById.get(r.id)!, imageBlob: r.imageBlob }))

    const toWrite = [...fresh, ...photoFilled]
    if (toWrite.length) await requireDriver().putRecipes(toWrite)

    // 菜单合并：同一天取并集，只保留本地还认识的菜。
    // 这里是**显式导入**，用户要的就是「把备份里的东西并进来」，
    // 所以取并集（而不是同步那套整条 LWW）—— 不会像同步那样
    // 出现「另一台设备的旧列表把删除带回来」的问题，因为来源是用户自己选的。
    const knownIds = new Set([...localById.keys(), ...fresh.map((r) => r.id)])
    const menuByDate = new Map(state.menus.map((m) => [m.date, m]))
    let menusMerged = 0
    for (const incoming of parsed.menus) {
      const local = menuByDate.get(incoming.date)
      const merged = local
        ? { date: incoming.date, items: [...new Set([...local.items, ...incoming.items])] }
        : { date: incoming.date, items: incoming.items }
      const cleaned: Menu = {
        date: merged.date,
        items: merged.items.filter((i) => knownIds.has(i)),
        // 必须打新时间戳：不打的话这条菜单的 updatedAt 停留在导入前的值，
        // 下次同步会被别处的旧版本直接顶掉，导入进来的菜凭空消失。
        updatedAt: nextStamp(),
      }
      if (!local || cleaned.items.length !== local.items.length) {
        await requireDriver().putMenu(cleaned)
        menuByDate.set(cleaned.date, cleaned)
        menusMerged++
      }
    }

    // 补过图的那几条要换成本次的新对象，否则界面还拿着导入前那个没图的
    const filledById = new Map(photoFilled.map((r) => [r.id, r]))

    setState({
      // liveRecipes 是防御性的：万一导入的文件里带着墓碑（手改过的备份），
      // 也不能让它出现在列表里
      recipes: sortRecipes(liveRecipes([...state.recipes, ...fresh])).map(
        (r) => filledById.get(r.id) ?? r,
      ),
      menus: [...menuByDate.values()],
    })

    return {
      added: fresh.length,
      skippedExisting,
      photoFilled: photoFilled.length,
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
 *
 * 【为什么不是 driver.clearAll() 一把清光】
 * 配了跨设备同步的话，物理清空等于「本地什么都没有」，别的设备下次同步
 * 会把它那一整库推回来 —— 用户点完「清空所有数据」，过了几秒菜又全回来了，
 * 只会以为应用坏了。所以这里走的还是墓碑那条路：给每道菜留一条删除记录、
 * 每天的菜单清成空数组，让「清空」这个动作本身能同步出去。
 * 没有配同步的时候，墓碑只是库里几十条几十字节的记录，用户看不到。
 */
export async function clearAllData(): Promise<void> {
  try {
    const d = requireDriver()
    const stamp = nextStamp()

    const all = await d.getAllRecipes()
    const tombstones: Recipe[] = all
      .filter((r) => !r.deletedAt)
      .map((r) => {
        const { imageBlob: _imageBlob, ...rest } = r
        return { ...rest, updatedAt: stamp, deletedAt: stamp }
      })
    if (tombstones.length) await d.putRecipes(tombstones)

    const emptied: Menu[] = []
    for (const m of state.menus) {
      if (!m.items.length) continue
      const blank: Menu = { date: m.date, items: [], updatedAt: stamp }
      await d.putMenu(blank)
      emptied.push(blank)
    }

    const blankByDate = new Map(emptied.map((m) => [m.date, m]))
    setState({
      recipes: [],
      menus: state.menus.map((m) => blankByDate.get(m.date) ?? m),
    })
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
 *
 * 【同名菜可能不止一条，每一条都得看】
 * 预置菜 id 还是随机的时候，两台设备各播一遍再同步，同一个菜名会变成两条
 * 记录（见 db/seed.ts 里 presetId 那段）。只取「同名里的一条」来补的话，
 * 补到哪条取决于库里的顺序 —— 用户点了按钮有时候管用、有时候不管用，
 * 而这种偶发性最难排查。所以同名有几条就查几条，谁没图给谁补。
 */
export async function reseedPresets(): Promise<ReseedResult> {
  try {
    const byName = new Map<string, Recipe[]>()
    for (const r of state.recipes) {
      const list = byName.get(r.name)
      if (list) list.push(r)
      else byName.set(r.name, [r])
    }
    const added: Recipe[] = []
    const photoPatched: Recipe[] = []
    const stamp = nextStamp()

    for (const preset of buildSeedRecipes()) {
      const existing = byName.get(preset.name)
      if (!existing || !existing.length) {
        added.push(preset)
        continue
      }
      for (const one of existing) {
        if (one.imageBlob || !preset.imageBlob) continue
        // 补图也算一次改动，得打时间戳，否则同步时这条会被别的设备的旧版本顶掉
        photoPatched.push({ ...one, imageBlob: preset.imageBlob, updatedAt: stamp })
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

/* ------------------------------------------------------------------ */
/* 跨设备同步的读写口子                                                */
/* ------------------------------------------------------------------ */

/**
 * 同步用：读出**全部**记录，**包含墓碑**。
 *
 * 和 `getState().recipes` 的区别就在墓碑上 —— UI 永远不该看到墓碑，
 * 但同步必须看到：不知道「哪些被删了」，就没法把删除传到别的设备。
 */
export async function readAllRecords(): Promise<{ recipes: Recipe[]; menus: Menu[] }> {
  const d = requireDriver()
  return { recipes: await d.getAllRecipes(), menus: await d.getAllMenus() }
}

/**
 * 把合并好的结果写回本地并刷新界面。
 *
 * 【一】写回之前要拿**当前的**本地状态再合一次，不能用 payload 整份覆盖。
 * 一次同步是「读本地 → 走网络 → 合并 → 写回」，中间隔着一段真实的网络时间。
 * 用户完全可能在这段时间里刚记了一道新菜 —— 整份覆盖会把那道菜**连同磁盘上
 * 的记录一起抹掉**，而且没有任何报错。合并本身是可交换、幂等、结合的
 * （见 sync/merge.ts），所以「拿最新的本地状态再合一次」既安全又不会跑偏，
 * 顺便让这个函数自己也可以被重复调用。
 *
 * 【二】同步数据里**没有图片**（见 sync/merge.ts），写回时必须把本地照片按 id
 * 接回去。直接 `putRecipes(payload.recipes)` 会用一份没有 imageBlob 的记录覆盖
 * 掉本地那条带照片的 —— **用户的照片会被无声地清空**，而且因为列表里图片位置
 * 有 emoji 兜底，肉眼还不一定立刻发现。
 * 墓碑是唯一的例外：墓碑存在的意义之一就是释放空间，不该把照片接回来。
 */
export async function applySyncPayload(payload: SyncPayload): Promise<void> {
  const d = requireDriver()
  const local = await d.getAllRecipes()
  const localMenus = await d.getAllMenus()

  const merged = mergePayload(
    { recipes: local.map(toSyncRecipe), menus: localMenus },
    payload,
  )

  const imageById = new Map<string, Blob>()
  for (const r of local) {
    if (r.imageBlob) imageById.set(r.id, r.imageBlob)
  }

  const nextRecords: Recipe[] = merged.recipes.map((r) => {
    // 墓碑不带图：put 是整条替换（不是字段合并），所以原来存过图的话，
    // 写这条墓碑就顺带把照片释放掉了。
    if (r.deletedAt) return { ...r }
    const image = imageById.get(r.id)
    return image ? { ...r, imageBlob: image } : { ...r }
  })

  // 【同名归并】合并是按 id 去重的，前提是「同一道菜在哪台设备上都是同一个 id」。
  // 预置菜 id 从随机改成 preset-<菜名> 之前入库的那批记录不满足这个前提 ——
  // 老记录和新记录一碰面，同一个菜名留下两条：一条带照片，一条没有。
  // 用户看到的是「全部 18」。这里把同名的合成一条，照片接到留下的那条身上
  // （照片不在同步数据里，只能本机搬），被合并掉的留墓碑，这样删除
  // 才能传到别的设备去。详见 sync/consolidate.ts。
  const tidy = consolidateByName(nextRecords, merged.menus, {
    stamp: nextStamp(),
    photos: imageById,
  })
  if (tidy.mergedGroups) {
    toast(`合并了 ${tidy.mergedGroups} 组重名的菜`, { duration: 6000 })
  }

  await d.putRecipes(tidy.recipes)
  for (const m of tidy.menus) await d.putMenu(m)

  // local: false —— 这次变化是同步自己造成的，不能让它反过来触发新一轮推送
  setState(
    {
      recipes: sortRecipes(liveRecipes(tidy.recipes)),
      menus: [...tidy.menus],
    },
    { local: false },
  )
}

