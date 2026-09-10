/**
 * 存储层。两套实现，同一个接口：
 *
 *   indexeddb   —— 正常情况。图片以 Blob 原样存，容量大、读写快。
 *   localstorage —— 降级。隐私模式 / 老浏览器里 IndexedDB 会直接不可用，
 *                   这时至少保证应用能跑，图片转成 dataURL 一起塞进 localStorage。
 *
 * 降级不是「优雅的可选项」而是「必须能走通的路」：iOS 无痕模式、
 * 部分安卓 WebView、以及浏览器设置里禁用站点数据，都会命中这条路。
 */

import type { Menu, Recipe } from '../types'
import { blobToDataURL, dataURLToBlob } from '../lib/image'
import type { BackupRecipe } from '../lib/backup'

export type StorageMode = 'indexeddb' | 'localstorage'

/** 存储写满（localStorage 5MB 上限，或 IndexedDB 配额用尽）。 */
export class StorageQuotaError extends Error {
  constructor(message = '存储空间不足') {
    super(message)
    this.name = 'StorageQuotaError'
  }
}

export interface StorageDriver {
  readonly mode: StorageMode
  getAllRecipes(): Promise<Recipe[]>
  putRecipes(recipes: Recipe[]): Promise<void>
  deleteRecipes(ids: string[]): Promise<void>
  getAllMenus(): Promise<Menu[]>
  putMenu(menu: Menu): Promise<void>
  clearAll(): Promise<void>
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/* ------------------------------------------------------------------ */

const DB_NAME = 'family-menu'
const DB_VERSION = 1
const STORE_RECIPES = 'recipes'
const STORE_MENUS = 'menus'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('这个浏览器没有 IndexedDB'))
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      // Safari 无痕模式下 open 会直接抛
      reject(err instanceof Error ? err : new Error('打开数据库失败'))
      return
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_RECIPES)) {
        db.createObjectStore(STORE_RECIPES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_MENUS)) {
        db.createObjectStore(STORE_MENUS, { keyPath: 'date' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开数据库失败'))
    request.onblocked = () => reject(new Error('数据库被另一个标签页占用，请关掉其他页面重试'))
  })
}

/** 通用事务封装：一次事务、一个请求、拿到结果就 resolve。 */
function runRequest<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  make: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = db.transaction(storeName, mode)
    } catch (err) {
      reject(err instanceof Error ? err : new Error('事务创建失败'))
      return
    }
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('事务被中止，可能是存储空间不足'))
    transaction.onerror = () => reject(transaction.error ?? new Error('事务出错'))

    const request = make(transaction.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('请求失败'))
  })
}

class IndexedDbDriver implements StorageDriver {
  readonly mode = 'indexeddb' as const

  constructor(private db: IDBDatabase) {}

  async getAllRecipes(): Promise<Recipe[]> {
    const rows = await runRequest<Recipe[]>(this.db, STORE_RECIPES, 'readonly', (s) =>
      s.getAll() as IDBRequest<Recipe[]>,
    )
    return rows ?? []
  }

  async putRecipes(recipes: Recipe[]): Promise<void> {
    if (!recipes.length) return
    await new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction
      try {
        tx = this.db.transaction(STORE_RECIPES, 'readwrite')
      } catch (err) {
        reject(err instanceof Error ? err : new Error('事务创建失败'))
        return
      }
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new StorageQuotaError())
      tx.onerror = () => reject(tx.error ?? new Error('写入失败'))
      const store = tx.objectStore(STORE_RECIPES)
      for (const r of recipes) store.put(r)
    })
  }

  async deleteRecipes(ids: string[]): Promise<void> {
    if (!ids.length) return
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE_RECIPES, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('删除失败'))
      tx.onerror = () => reject(tx.error ?? new Error('删除失败'))
      const store = tx.objectStore(STORE_RECIPES)
      for (const id of ids) store.delete(id)
    })
  }

  async getAllMenus(): Promise<Menu[]> {
    const rows = await runRequest<Menu[]>(this.db, STORE_MENUS, 'readonly', (s) =>
      s.getAll() as IDBRequest<Menu[]>,
    )
    return rows ?? []
  }

  async putMenu(menu: Menu): Promise<void> {
    await runRequest(this.db, STORE_MENUS, 'readwrite', (s) => s.put(menu) as IDBRequest<IDBValidKey>)
  }

  async clearAll(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction([STORE_RECIPES, STORE_MENUS], 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('清空失败'))
      tx.onerror = () => reject(tx.error ?? new Error('清空失败'))
      tx.objectStore(STORE_RECIPES).clear()
      tx.objectStore(STORE_MENUS).clear()
    })
  }
}

/* ------------------------------------------------------------------ */
/* localStorage 降级                                                    */
/* ------------------------------------------------------------------ */

const LS_RECIPES = 'family-menu:recipes'
const LS_MENUS = 'family-menu:menus'

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: number }
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  )
}

class LocalStorageDriver implements StorageDriver {
  readonly mode = 'localstorage' as const

  private readArray<T>(key: string): T[] {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }

  private write(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch (err) {
      if (isQuotaError(err)) {
        throw new StorageQuotaError(
          '本地存储空间已满（降级模式上限约 5MB）。建议删掉几张图片，或改用正常模式。',
        )
      }
      throw err
    }
  }

  async getAllRecipes(): Promise<Recipe[]> {
    const rows = this.readArray<BackupRecipe>(LS_RECIPES)
    return rows.map((row) => {
      const { image, ...rest } = row
      let imageBlob: Blob | undefined
      if (typeof image === 'string' && image.startsWith('data:')) {
        try {
          imageBlob = dataURLToBlob(image)
        } catch {
          imageBlob = undefined
        }
      }
      return { ...rest, imageBlob }
    })
  }

  /** 读改写：先转成可序列化结构，再整体写回。 */
  private async toSerializable(
    recipes: Recipe[],
  ): Promise<Array<BackupRecipe & { id: string }>> {
    const out: Array<BackupRecipe & { id: string }> = []
    for (const r of recipes) {
      const { imageBlob, ...rest } = r
      const row: BackupRecipe & { id: string } = { ...rest }
      if (imageBlob) {
        try {
          row.image = await blobToDataURL(imageBlob)
        } catch {
          /* 图片读不出来就丢图保菜谱 */
        }
      }
      out.push(row)
    }
    return out
  }

  async putRecipes(recipes: Recipe[]): Promise<void> {
    if (!recipes.length) return
    const existing = this.readArray<BackupRecipe & { id: string }>(LS_RECIPES)
    const incoming = await this.toSerializable(recipes)
    const byId = new Map(existing.map((r) => [r.id, r]))
    for (const r of incoming) byId.set(r.id, r)
    this.write(LS_RECIPES, [...byId.values()])
  }

  async deleteRecipes(ids: string[]): Promise<void> {
    if (!ids.length) return
    const drop = new Set(ids)
    const left = this.readArray<BackupRecipe & { id: string }>(LS_RECIPES).filter(
      (r) => !drop.has(r.id),
    )
    this.write(LS_RECIPES, left)
  }

  async getAllMenus(): Promise<Menu[]> {
    return this.readArray<Menu>(LS_MENUS)
  }

  async putMenu(menu: Menu): Promise<void> {
    const existing = this.readArray<Menu>(LS_MENUS)
    const byDate = new Map(existing.map((m) => [m.date, m]))
    byDate.set(menu.date, menu)
    this.write(LS_MENUS, [...byDate.values()])
  }

  async clearAll(): Promise<void> {
    try {
      localStorage.removeItem(LS_RECIPES)
      localStorage.removeItem(LS_MENUS)
    } catch {
      /* 清不掉也没别的办法 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

export interface StorageInit {
  driver: StorageDriver
  mode: StorageMode
  /** 非 null 时 UI 要提示用户「已降级」 */
  warning: string | null
}

function canUseLocalStorage(): boolean {
  try {
    const k = '__fm_probe__'
    localStorage.setItem(k, '1')
    localStorage.removeItem(k)
    return true
  } catch {
    return false
  }
}

/**
 * 选一个能用的存储后端。
 *
 * 注意：不能只看 `'indexedDB' in window`。iOS 无痕模式下这个属性存在、
 * open() 也可能成功，但真正读写时才炸。所以这里做一次真实的读写探测，
 * 探测通过才认。
 */
export async function initStorage(): Promise<StorageInit> {
  let idbError: unknown = null

  try {
    const db = await openDatabase()
    const driver = new IndexedDbDriver(db)
    // 真读一次，确认事务能跑通（无痕模式会在这里失败）
    await driver.getAllRecipes()
    return { driver, mode: 'indexeddb', warning: null }
  } catch (err) {
    idbError = err
  }

  if (canUseLocalStorage()) {
    return {
      driver: new LocalStorageDriver(),
      mode: 'localstorage',
      warning:
        '当前浏览器无法使用 IndexedDB（常见于无痕/隐私模式），已自动降级到 localStorage：' +
        '功能都能用，但容量只有约 5MB，图片存不了几张。' +
        (idbError instanceof Error ? `（${idbError.message}）` : ''),
    }
  }

  // 两条路都断了：给一个内存态驱动，至少这次会话能用，别白屏。
  return {
    driver: new MemoryDriver(),
    mode: 'localstorage',
    warning:
      '这个浏览器把本地存储完全禁用了，数据只保存在当前页面里，刷新就会丢失。' +
      '建议换回正常模式，或换一个浏览器。',
  }
}

/** 最后的兜底：只在内存里活着。 */
class MemoryDriver implements StorageDriver {
  readonly mode = 'localstorage' as const
  private recipes = new Map<string, Recipe>()
  private menus = new Map<string, Menu>()

  async getAllRecipes(): Promise<Recipe[]> {
    return [...this.recipes.values()]
  }
  async putRecipes(recipes: Recipe[]): Promise<void> {
    for (const r of recipes) this.recipes.set(r.id, r)
  }
  async deleteRecipes(ids: string[]): Promise<void> {
    for (const id of ids) this.recipes.delete(id)
  }
  async getAllMenus(): Promise<Menu[]> {
    return [...this.menus.values()]
  }
  async putMenu(menu: Menu): Promise<void> {
    this.menus.set(menu.date, menu)
  }
  async clearAll(): Promise<void> {
    this.recipes.clear()
    this.menus.clear()
  }
}
