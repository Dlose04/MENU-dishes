/**
 * 分享链接的编解码。
 *
 * 链接形态： {origin}{path}?m={lz-string 压缩后的精简菜单}
 *
 * 压缩前的原文是一个紧凑 JSON：
 *   {"v":1,"d":[{"n":"番茄炒蛋","c":"家常热菜","e":"🍅"}, ...]}
 *
 * 刻意不放的东西：
 *   - 图片（base64 图片动辄几十 KB，URL 会超长，微信里会被截断到打不开）
 *   - 食材、备注（属于「我的菜谱」的私有内容，分享菜单不需要）
 * 对方打开后，图片位置用 emoji 兜底。
 */

import LZString from './lz-string'
import type { ShareDish } from '../types'

export const SHARE_PARAM = 'm'

/** 链接总长上限。微信/QQ 对超长链接有截断风险，1800 是比较保守的安全线。 */
export const MAX_SHARE_URL_LENGTH = 1800

/**
 * 单条分享最多带几道菜。
 * 这个数只是「别被手搓的巨型链接拖死」的安全阀，不是长度控制手段 ——
 * 长度控制交给 MAX_SHARE_URL_LENGTH + 超长提示。
 * 定得太低（比如 60）会让大家庭想分享整份菜单时被无声截断，
 * 所以放宽到 200：普通家宴十几道菜连门都够不着。
 */
const MAX_DISHES = 200

const MAX_NAME_LEN = 40
const MAX_CATEGORY_LEN = 12
const MAX_EMOJI_LEN = 8

interface SharePayload {
  /** 版本号，留作以后扩展 */
  v: 1
  d: ShareDish[]
}

/** 精简菜单 -> URL 参数值（不含 ?m= 前缀）。 */
export function encodeDishes(dishes: ShareDish[]): string {
  const payload: SharePayload = {
    v: 1,
    d: dishes.slice(0, MAX_DISHES).map((x) => ({
      n: String(x.n ?? '').slice(0, MAX_NAME_LEN),
      c: String(x.c ?? '').slice(0, MAX_CATEGORY_LEN),
      e: String(x.e ?? '').slice(0, MAX_EMOJI_LEN),
    })),
  }
  return LZString.compressToEncodedURIComponent(JSON.stringify(payload))
}

function sanitizeDish(raw: unknown): ShareDish | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const n = typeof o.n === 'string' ? o.n.trim().slice(0, MAX_NAME_LEN) : ''
  if (!n) return null
  return {
    n,
    c: typeof o.c === 'string' ? o.c.trim().slice(0, MAX_CATEGORY_LEN) : '',
    e: typeof o.e === 'string' ? o.e.trim().slice(0, MAX_EMOJI_LEN) : '',
  }
}

/**
 * URL 参数值 -> 精简菜单。
 * 链接可能被人改坏、被聊天软件截断、来自旧版本，所以这里「永不抛异常」，
 * 解不出来就返回 null，由调用方提示用户。
 */
export function decodeDishes(encoded: string): ShareDish[] | null {
  if (!encoded) return null

  const parse = (text: string): ShareDish[] | null => {
    try {
      const data = JSON.parse(text) as SharePayload | ShareDish[]
      // 兼容两种原文：带版本号的对象，或裸数组
      const list = Array.isArray(data) ? data : data?.d
      if (!Array.isArray(list)) return null
      const dishes = list
        .map(sanitizeDish)
        .filter((x): x is ShareDish => x !== null)
        .slice(0, MAX_DISHES)
      return dishes.length ? dishes : null
    } catch {
      return null
    }
  }

  // lz-string 的 URI-safe 字符集不含 '{'，所以能直接认出「没压缩的裸 JSON」
  // （方便手工调链接、也兼容以后可能的明文格式）
  const trimmed = encoded.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parse(trimmed)
  }

  try {
    // decompressFromEncodedURIComponent 内部会把空格还原成 '+'，
    // 这样即使被 URLSearchParams 把 '+' 解成了空格也能正确还原。
    const text = LZString.decompressFromEncodedURIComponent(encoded)
    if (!text) return null
    return parse(text)
  } catch {
    return null
  }
}

export interface ShareUrlResult {
  url: string
  length: number
  /** 超过安全长度，UI 应该提示用户精简菜单 */
  tooLong: boolean
}

/**
 * 拼出分享链接。
 * 手工拼 query 而不是用 URLSearchParams.set()，因为后者会把 lz-string
 * 用到的 '+' 转义成 '%2B'，白白让链接长 10%~20%，对长度很敏感的场景不划算。
 */
export function buildShareUrl(dishes: ShareDish[], baseHref?: string): ShareUrlResult {
  const encoded = encodeDishes(dishes)
  const href = baseHref ?? location.href

  let prefix: string
  try {
    const url = new URL(href)
    // file:// 下 origin 是字符串 "null"，不能直接用
    if (url.protocol === 'file:') {
      prefix = href.split('?')[0].split('#')[0]
    } else {
      const params = new URLSearchParams(url.search)
      params.delete(SHARE_PARAM)
      const rest = params.toString()
      prefix = `${url.origin}${url.pathname}${rest ? `?${rest}` : ''}`
    }
  } catch {
    prefix = href.split('?')[0].split('#')[0]
  }

  const joiner = prefix.includes('?') ? '&' : '?'
  const url = `${prefix}${joiner}${SHARE_PARAM}=${encoded}`

  return {
    url,
    length: url.length,
    tooLong: url.length > MAX_SHARE_URL_LENGTH,
  }
}

/** 从 location 里读出分享参数。URL 和 hash 都找一遍，兼容各种托管方式。 */
export function readShareFromLocation(
  href: string = location.href,
): ShareDish[] | null {
  let raw: string | null = null
  try {
    const url = new URL(href)
    raw = url.searchParams.get(SHARE_PARAM)
    if (!raw && url.hash.length > 1) {
      // 有些平台会把 query 塞进 hash
      const hashQuery = url.hash.replace(/^#\/?/, '')
      raw = new URLSearchParams(hashQuery).get(SHARE_PARAM)
    }
  } catch {
    const m = /[?&#]m=([^&#]+)/.exec(href)
    raw = m ? decodeURIComponent(m[1]) : null
  }
  if (!raw) return null
  return decodeDishes(raw)
}

/** 预览完就把 m 参数从地址栏抹掉，避免刷新时又进一次预览页、也方便用户收藏。 */
export function clearShareFromUrl(): void {
  try {
    const url = new URL(location.href)
    if (!url.searchParams.has(SHARE_PARAM)) return
    url.searchParams.delete(SHARE_PARAM)
    const next = `${url.pathname}${url.search}${url.hash}` || './'
    history.replaceState(null, '', next)
  } catch {
    /* 改不动就算了，不影响功能 */
  }
}
