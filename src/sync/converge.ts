/**
 * 一次完整同步的编排：拉取 → 合并 → 写回 → 推送，撞车了就重来。
 *
 * 【服务端为什么不做合并】
 * 服务端只干三件事：校验口令、存一份数据、检查版本号。合并全在客户端做。
 * 这样服务端的逻辑少到几乎不可能出错，而且**两台设备跑的是同一份
 * merge.ts** —— 合并规则只有一处定义，不存在「客户端和服务端各写一遍、
 * 哪天改了一边忘了另一边」的问题。
 *
 * 【乐观锁】
 * 推送时带上「我是基于哪个版本改的」（baseRev）。服务端一比对，发现版本
 * 已经被人推过了就回 409 并附上它当前的数据。客户端拿回来重新合一轮。
 * 家庭应用的并发量下，最多一两轮就收敛了。
 *
 * 这个文件刻意不碰 fetch / localStorage / DOM —— 传输层是注入进来的，
 * 于是冲突重试这段最容易写错的循环可以脱离浏览器直接测。
 */

import type { SyncPayload } from './merge'
import { mergePayload, pruneTombstones } from './merge'

/** 服务端上当前那一份：版本号 + 数据。 */
export interface RemoteState {
  rev: number
  payload: SyncPayload
}

export type PushResult =
  | { ok: true; rev: number }
  /** 版本对不上：别人在这中间推过。remote 是它现在的样子。 */
  | { ok: false; conflict: true; remote: RemoteState }

export interface Transport {
  pull(): Promise<RemoteState>
  push(baseRev: number, payload: SyncPayload): Promise<PushResult>
}

export interface ConvergeDeps {
  transport: Transport
  readLocal: () => Promise<SyncPayload>
  writeLocal: (payload: SyncPayload) => Promise<void>
  now?: () => number
}

export interface ConvergeResult {
  /** 结束后服务端上的版本号 */
  rev: number
  /** 这次真的往服务端写了没有 */
  pushed: boolean
  /** 跑了几轮（>1 说明撞过车） */
  rounds: number
}

/**
 * 最多重试几轮。
 *
 * 家庭应用的并发量下，撞一次车都算少见，两三轮足够收敛。设上限是为了
 * 万一服务端行为异常时**不要无限循环** —— 那种情况下宁可报一次错让用户
 * 一会儿再试，也不能把手机流量和电量烧在一个转不出来的循环上。
 */
const MAX_ROUNDS = 5

/** 两份数据是不是一模一样（用来避免没必要的写入和推送）。 */
function samePayload(a: SyncPayload, b: SyncPayload): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 跑一轮同步，直到本地、服务端、合并结果三者一致。
 *
 * 注意顺序：**先写本地再推送**。合并结果本来就同时包含了两边的内容，
 * 所以即使推送失败（断网、口令过期），本地也已经对齐过了，不会白跑一趟。
 */
export async function converge(deps: ConvergeDeps): Promise<ConvergeResult> {
  const now = deps.now ?? Date.now
  let remote = await deps.transport.pull()

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const local = await deps.readLocal()
    const merged = mergePayload(local, remote.payload)
    const next: SyncPayload = {
      // 清掉过期的墓碑（见 merge.ts 里的 TOMBSTONE_TTL_MS）。
      // 只清「已经老到没人会再拿着旧副本回来」的那些，否则云端的文档
      // 会随着删除次数一直长。
      recipes: pruneTombstones(merged.recipes, now()),
      menus: merged.menus,
    }

    if (!samePayload(next, local)) await deps.writeLocal(next)

    // 合并之后和服务端上那份没差别，就没必要推 —— 大多数同步都是这种
    // 「什么都没发生」的情况，让它一次网络请求就结束。
    if (samePayload(next, remote.payload)) {
      return { rev: remote.rev, pushed: false, rounds: round }
    }

    const result = await deps.transport.push(remote.rev, next)
    if (result.ok) return { rev: result.rev, pushed: true, rounds: round }

    // 撞车了：这中间另一台设备推过。拿它的最新状态重新合一轮。
    remote = result.remote
  }

  throw new Error('两边一直在同时修改，请稍后再试')
}
