/**
 * 跨设备同步的配置：一个云函数地址 + 一个家族口令。存在 localStorage 里。
 *
 * 【口令绝不写进代码】
 * 这个页面是公开托管的（GitHub Pages），任何写进源码的东西全世界都能看到。
 * 所以口令只能由用户在自己设备上粘一次，存在本机 localStorage，
 * **永远不要**把某个人的口令当成默认值写进仓库 —— 那等于把家里菜谱
 * 挂在公网上，而且从 git 历史里删不掉。
 *
 * 代价是每台设备都要粘一次（一次性动作，换设备才需要再做）。
 */

export interface SyncConfig {
  /** 云函数的完整 URL */
  url: string
  /** 家族口令，所有设备必须填一样的 */
  pass: string
}

const URL_KEY = 'family-menu:sync:url'
const PASS_KEY = 'family-menu:sync:pass'

/** 去掉首尾空白和结尾的斜杠 —— 用户从浏览器地址栏复制常常带这些。 */
export function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * 检查地址能不能用。返回错误提示，没问题返回 null。
 *
 * **必须 https**：页面本身是 https 的，往里发 http 请求会被浏览器当成混合内容
 * 直接拦掉，报错还很难懂。宁可在这里提前说清楚。
 * localhost 例外，那是本机调试用的。
 */
export function checkUrl(raw: string): string | null {
  const url = normalizeUrl(raw)
  if (!url) return '请填写云函数地址'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '这个地址格式不对，应该是 https:// 开头的完整地址'
  }
  if (parsed.protocol === 'http:') {
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    if (!local) return '地址必须是 https 开头（http 会被浏览器拦截）'
  } else if (parsed.protocol !== 'https:') {
    return '只支持 https 地址'
  }
  return null
}

export function readSyncConfig(): SyncConfig | null {
  try {
    const url = normalizeUrl(localStorage.getItem(URL_KEY) ?? '')
    const pass = localStorage.getItem(PASS_KEY) ?? ''
    if (!url || !pass) return null
    if (checkUrl(url) !== null) return null
    return { url, pass }
  } catch {
    // localStorage 被完全禁用：等于没配同步，应用照常离线用
    return null
  }
}

/** 传 null 就是关掉同步（口令一并清掉，不留残渣）。 */
export function writeSyncConfig(config: SyncConfig | null): void {
  try {
    if (!config) {
      localStorage.removeItem(URL_KEY)
      localStorage.removeItem(PASS_KEY)
      return
    }
    localStorage.setItem(URL_KEY, normalizeUrl(config.url))
    localStorage.setItem(PASS_KEY, config.pass)
  } catch {
    /* 存不进去也没别的办法，下次打开会显示成没配 */
  }
}

export function isSyncConfigured(): boolean {
  return readSyncConfig() !== null
}
