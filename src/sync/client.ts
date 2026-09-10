/**
 * 同步模块的浏览器部分：真发请求、防抖、状态给界面看。
 *
 * 合并与重试的循环在 converge.ts 里，那个文件不碰浏览器，好测。
 * 这里只负责「什么时候发」和「发失败了怎么跟用户说」。
 *
 * 【没配同步的时候，这个模块完全是睡着的一个字都不改应用行为】
 * 所有入口第一件事都是 readSyncConfig()，配了才动。所以不填地址口令的用户，
 * 用到的仍然是原来那个纯离线应用。
 */

import { useSyncExternalStore } from 'react'
import type { SyncPayload } from './merge'
import { toSyncPayload } from './merge'
import { converge, type Transport } from './converge'
import { readSyncConfig, writeSyncConfig, type SyncConfig } from './config'
import { applySyncPayload, readAllRecords, subscribeLocalChanges } from '../store/appStore'

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  /** 出错时给人看的一句话 */
  message: string | null
  lastSyncAt: number | null
  /** 服务端当前版本号（成功同步过才有）。撞车重试的次数可以从它涨得比预期快看出来。 */
  rev: number | null
}

let status: SyncStatus = { phase: 'off', message: null, lastSyncAt: null, rev: null }
const listeners = new Set<() => void>()

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = (): SyncStatus => status

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function getSyncStatus(): SyncStatus {
  return status
}

/* ------------------------------------------------------------------ */
/* HTTP 传输层                                                         */
/* ------------------------------------------------------------------ */

/**
 * 超时。必须设 —— 不设的话手机信号不好时那个请求能吊几分钟，
 * 期间界面一直显示「同步中」，用户只会以为卡死了。
 */
const TIMEOUT_MS = 20_000

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/**
 * 把服务端返回的数据**严格**解析出来。
 *
 * 关键点：认不出来就**抛错，不要当成空数据**。当成空的话，客户端会
 * 高高兴兴地把「空」合并进去再推回服务端 —— 一次返回格式出错就足以
 * 把全家人的菜谱清空。宁可这次同步失败，也不能往云端推一份来路不明的空数据。
 */
function parsePayload(raw: unknown): SyncPayload {
  if (!isObj(raw) || !Array.isArray(raw.recipes) || !Array.isArray(raw.menus)) {
    throw new SyncError('云端返回的数据看不懂，这次先不推送，免得把云端的菜谱覆盖掉', 'bad-remote')
  }
  return {
    recipes: raw.recipes as SyncPayload['recipes'],
    menus: raw.menus as SyncPayload['menus'],
  }
}

function readRev(data: Record<string, unknown>, fallback: number): number {
  return typeof data.rev === 'number' && Number.isFinite(data.rev) ? data.rev : fallback
}

interface RawResponse {
  status: number
  data: Record<string, unknown>
}

/**
 * 发一次请求。
 *
 * 200 和 409（版本撞车）都正常返回给调用方处理；其余状态码一律抛 SyncError，
 * 并且**带上人话** —— 用户看到一个 status code 是没用的，他要的是
 * 「口令不对」还是「地址填错了」。
 */
async function call(cfg: SyncConfig, method: 'GET' | 'POST', body?: unknown): Promise<RawResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(cfg.url, {
      method,
      headers: {
        // 口令走请求头，不走 URL —— URL 会进各种日志和浏览器历史
        'x-menu-pass': cfg.pass,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new SyncError('同步超时，网络可能不太顺，稍后会自动重试', 'timeout')
    }
    throw new SyncError('连不上云端，检查一下网络', 'network')
  } finally {
    clearTimeout(timer)
  }

  let data: Record<string, unknown> = {}
  try {
    const text = await res.text()
    if (text) data = JSON.parse(text) as Record<string, unknown>
  } catch {
    if (res.ok || res.status === 409) {
      throw new SyncError('云端返回的内容看不懂', 'bad-remote')
    }
  }

  if (res.status === 200 || res.status === 409) return { status: res.status, data }

  if (res.status === 401 || res.status === 403) {
    throw new SyncError('家族口令不对，确认一下和别的设备填的是同一个', 'bad-pass')
  }
  if (res.status === 404) {
    throw new SyncError('云端地址不对（404），检查设置里填的函数地址', 'not-found')
  }
  if (res.status >= 500) {
    throw new SyncError('云端出错了，稍后会自动重试', 'server')
  }
  throw new SyncError(`云端返回了 ${res.status}，稍后再试`, 'http')
}

export function httpTransport(cfg: SyncConfig): Transport {
  return {
    async pull() {
      const { data } = await call(cfg, 'GET')
      return { rev: readRev(data, 0), payload: parsePayload(data.payload) }
    },

    async push(baseRev, payload) {
      const { status: code, data } = await call(cfg, 'POST', { baseRev, payload })
      if (code === 409) {
        return {
          ok: false,
          conflict: true,
          remote: { rev: readRev(data, baseRev), payload: parsePayload(data.payload) },
        }
      }
      return { ok: true, rev: readRev(data, baseRev + 1) }
    },
  }
}

/* ------------------------------------------------------------------ */
/* 编排：什么时候同步                                                  */
/* ------------------------------------------------------------------ */

/**
 * 本地改动之后等多久才推。
 *
 * 用户连着点几道菜是常态，每次点都推一遍就是五六次请求。等 3 秒，
 * 停手之后再推一次 —— 对家庭应用来说 3 秒的延迟完全可以接受。
 */
const DEBOUNCE_MS = 3000

/** 从后台切回前台时，距上次同步超过这么久就顺手拉一次。 */
const STALE_AFTER_MS = 60_000

let started = false
let running: Promise<void> | null = null
/** 同步过程中又发生了本地改动：跑完得补一轮，否则那次改动要等下次才推上去 */
let queued = false
let debounceTimer: number | null = null

function describe(err: unknown, where: string): string {
  console.warn(`[family-menu] 同步失败（${where}）`, err)
  if (err instanceof SyncError) return err.message
  return '同步失败，稍后会自动重试'
}

async function run(where: string): Promise<void> {
  const cfg = readSyncConfig()
  if (!cfg) {
    setStatus({ phase: 'off', message: null })
    return
  }

  setStatus({ phase: 'syncing', message: null })
  try {
    const result = await converge({
      transport: httpTransport(cfg),
      readLocal: async () => {
        const { recipes, menus } = await readAllRecords()
        return toSyncPayload(recipes, menus)
      },
      writeLocal: (payload) => applySyncPayload(payload),
    })
    setStatus({ phase: 'idle', message: null, lastSyncAt: Date.now(), rev: result.rev })
  } catch (err) {
    setStatus({ phase: 'error', message: describe(err, where) })
  }
}

/**
 * 立刻同步一次（并发的调用会共用同一次，不会打出重复请求）。
 *
 * 如果同步进行中又有新改动，跑完会自动补一轮 —— 少了这个「补一轮」，
 * 用户在同步那几秒里记的菜要等到下一次触发才推得上去，表现就是
 * 「我明明记了，另一台设备上没有」。
 */
export function syncNow(where = '手动'): Promise<void> {
  if (!readSyncConfig()) return Promise.resolve()
  if (running) {
    queued = true
    return running
  }
  running = run(where).finally(() => {
    running = null
    if (queued) {
      queued = false
      void syncNow('补一轮')
    }
  })
  return running
}

/** 本地改动之后安排一次推送。 */
function scheduleSync(): void {
  if (!readSyncConfig()) return
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void syncNow('本地改动')
  }, DEBOUNCE_MS) as unknown as number
}

/** 有改动还没推出去（用来决定切后台时要不要立刻推一把）。 */
function hasPendingChange(): boolean {
  return debounceTimer !== null
}

/** 改配置：null 表示关掉同步。改完立刻同步一次。 */
export function applySyncConfig(config: SyncConfig | null): void {
  writeSyncConfig(config)
  if (!config) {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    setStatus({ phase: 'off', message: null, lastSyncAt: null, rev: null })
    return
  }
  setStatus({ phase: 'idle', message: null })
  void syncNow('改配置')
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    // 手机用户点完菜随手就切走/锁屏是常态。有没推出去的东西就趁现在推，
    // 否则要等他下次打开应用才同步到别的设备上。
    if (hasPendingChange()) {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = null
      void syncNow('切到后台')
    }
    return
  }
  const last = status.lastSyncAt
  if (last === null || Date.now() - last > STALE_AFTER_MS) void syncNow('回到前台')
}

/**
 * 启动同步。幂等，App 挂载时调一次。
 *
 * 没配同步的话只是把状态设成 'off'，不装任何监听、不改任何行为。
 */
export function startSync(): void {
  if (started) return
  started = true

  subscribeLocalChanges(scheduleSync)

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void syncNow('网络恢复'))
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  if (readSyncConfig()) {
    setStatus({ phase: 'idle', message: null })
    void syncNow('启动')
  } else {
    setStatus({ phase: 'off', message: null })
  }
}
