/**
 * 测试辅助：把 src 下的 TS 模块打包成临时 ESM 文件再 import。
 *
 * 为什么不直接跑 TS？—— 源码里用的是无扩展名的相对导入（'../types'），
 * Node 的 ESM 解析器不认，而 Vite/rolldown 认。与其为了测试改源码的
 * 导入风格，不如用打包器把被测模块编出来。
 */
import { rolldown } from 'rolldown'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 相对项目根目录的模块路径 -> 打包后的模块 */
export function src(relative) {
  return path.join(ROOT, 'src', relative)
}

const cache = new Map()

export function load(entry) {
  if (!cache.has(entry)) {
    cache.set(
      entry,
      (async () => {
        const bundle = await rolldown({ input: entry })
        const { output } = await bundle.generate({ format: 'esm' })
        const dir = await mkdtemp(path.join(tmpdir(), 'fm-test-'))
        const file = path.join(dir, 'bundle.mjs')
        await writeFile(file, output[0].code, 'utf8')
        return import(pathToFileURL(file).href)
      })(),
    )
  }
  return cache.get(entry)
}

/**
 * 给被测代码补上 Node 里没有的浏览器 API。
 * 只补测试真正会走到的那些（FileReader / localStorage）。
 */
export function stubBrowserApis() {
  if (typeof globalThis.FileReader === 'undefined') {
    globalThis.FileReader = class FileReader {
      constructor() {
        this.result = null
        this.onload = null
        this.onerror = null
      }
      readAsDataURL(blob) {
        blob
          .arrayBuffer()
          .then((buf) => {
            this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`
            this.onload?.()
          })
          .catch((err) => {
            this.onerror?.(err)
          })
      }
    }
  }
}

/** 一个只在内存里的 localStorage 替身。 */
export function stubLocalStorage() {
  const map = new Map()
  const ls = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size
    },
  }
  globalThis.localStorage = ls
  return ls
}
