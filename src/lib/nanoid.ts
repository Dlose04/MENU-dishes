/**
 * 极简 nanoid（URL-safe，默认 21 位）。
 * 不引第三方包，避免为了 6 行代码多一个依赖。
 */

// 与 nanoid 官方一致的 64 字符表
const ALPHABET =
  'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
    return bytes
  }
  // 兜底：极老的浏览器 / 非安全上下文。只影响 id 的随机性，不影响功能。
  for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

export function nanoid(size = 21): string {
  const bytes = randomBytes(size)
  let id = ''
  for (let i = 0; i < size; i++) id += ALPHABET[bytes[i] & 63]
  return id
}
