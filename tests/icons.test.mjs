/**
 * 图标的回归测试。
 *
 * 起因：public/icon-512.png 一度是 icon-180.png 的字节级复制品，
 * 两个文件 md5 一模一样，而 manifest 里按 "512x512" + "maskable" 声明。
 * 后果是 Android 拿 180 的图去当 512 用（发虚），并按图标形状裁一圈
 * （碗沿被切掉）。iOS 走 apple-touch-icon，看不出任何问题 ——
 * 所以这个坑在 iPhone 上永远发现不了。
 *
 * 这里把两条规则钉死：
 *   1. 清单声明的尺寸必须和 PNG 头里的真实尺寸一致；
 *   2. maskable 那张的内容必须落在画布中心直径 80% 的安全区内。
 *
 * 改图标请跑 `npm run icons`（scripts/make-icons.mjs），别手改 PNG。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const PUBLIC = path.resolve(import.meta.dirname, '../public')
const manifest = JSON.parse(
  fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'),
)

/** 只读 PNG 头，拿宽高和颜色类型 */
function pngHeader(buf) {
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR', '不是 PNG，或者 IHDR 不在开头')
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    depth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  }
}

/** 解出 RGBA 像素；只支持 8 位非隔行，够这个项目用 */
function decodePNG(buf) {
  const head = pngHeader(buf)
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[head.colorType]
  assert.ok(channels, `不支持的颜色类型 ${head.colorType}`)
  assert.equal(head.depth, 8, '只支持 8 位深')
  assert.equal(head.interlace, 0, '不支持隔行 PNG')

  const idat = []
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('ascii', o + 4, o + 8)
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }

  const { width: w, height: h } = head
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const out = Buffer.alloc(h * stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 255
    }
  }
  return { ...head, channels, px: out }
}

const read = (src) => fs.readFileSync(path.join(PUBLIC, src.replace(/^\.?\//, '')))

test('清单里每个图标都真实存在，且声明尺寸和 PNG 头一致', () => {
  assert.ok(manifest.icons?.length, '清单里没有 icons')

  for (const icon of manifest.icons) {
    const buf = read(icon.src)
    const { width, height } = pngHeader(buf)
    assert.equal(
      `${width}x${height}`,
      icon.sizes,
      `${icon.src} 声明 ${icon.sizes}，实际是 ${width}x${height}`,
    )
    assert.equal(width, height, `${icon.src} 不是正方形，图标会被拉变形`)
  }
})

test('两个图标不是同一张图（曾经 icon-512 是 icon-180 的复制品）', () => {
  const [a, b] = manifest.icons.map((i) => read(i.src))
  assert.notEqual(
    a.toString('base64'),
    b.toString('base64'),
    '两个图标字节相同，多半是复制粘贴出来的，尺寸声明必然有一个是错的',
  )
})

test('maskable 图标的内容落在安全区内（不然会被裁掉一圈）', () => {
  const maskable = manifest.icons.find((i) => i.purpose.includes('maskable'))
  assert.ok(maskable, '清单里没有 maskable 图标，Android 主屏图标会被硬裁')

  const im = decodePNG(read(maskable.src))
  assert.equal(im.width, im.height)
  const half = im.width / 2
  const safe = 0.4 * im.width // maskable 安全区：画布中心、直径 80% 的圆

  // 背景 = 纸底与横线的任意混合（含抗锯齿的中间色），其余才算「内容」。
  // 按颜色混比判断，比拿容差比对固定色值稳，不会把线的边缘误判成内容。
  const paper = [253, 251, 244]
  const delta = [-21, -25, -32]
  const d2 = delta.reduce((s, v) => s + v * v, 0)
  const isBackground = (i) => {
    const v = [im.px[i] - paper[0], im.px[i + 1] - paper[1], im.px[i + 2] - paper[2]]
    const t = (v[0] * delta[0] + v[1] * delta[1] + v[2] * delta[2]) / d2
    if (t < -0.05 || t > 1.05) return false
    const r = [v[0] - t * delta[0], v[1] - t * delta[1], v[2] - t * delta[2]]
    return Math.hypot(...r) < 4
  }

  let worst = 0
  let at = null
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      if (isBackground((y * im.width + x) * im.channels)) continue
      const r = Math.hypot(x + 0.5 - half, y + 0.5 - half)
      if (r > worst) {
        worst = r
        at = [x, y]
      }
    }
  }

  assert.ok(
    worst <= safe,
    `内容最远点半径 ${worst.toFixed(1)}px 超出安全区 ${safe.toFixed(1)}px（在 ${at}），` +
      '按圆形遮罩裁的时候会被切掉',
  )
})
