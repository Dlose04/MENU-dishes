/**
 * 生成 PWA 图标：一只冒热气的汤碗，画在横线纸上。
 *
 * 为什么要有这个脚本，而不是把画好的 PNG 直接放进 public/：
 *
 * 1. **maskable 图标必须是真 512。** 之前 public/ 里的 icon-512.png 实际是
 *    icon-180.png 的复制品（两个文件 md5 一模一样），manifest 却按 512x512
 *    maskable 声明。Android 会拿它当 512 用，等于把 180 放大 2.8 倍，主屏图标发虚。
 * 2. **maskable 还要求「安全区」。** 这个值的意思是「随便你怎么裁都不会切到内容」，
 *    所以内容必须缩进画布中心直径 80% 的圆里。原来那张画满了整张 180x180，
 *    被裁掉一圈就是断掉的碗沿。
 * 3. 没有矢量源文件。图形是 6 个纯色、几何干净的形状，所以直接按测量出的参数
 *    重画一遍，比放大位图干净得多，而且以后改配色改尺寸只要动这个文件。
 *
 * 坐标系沿用原始设计稿的 180x180，最后按目标尺寸缩放。
 *
 * 用法：node scripts/make-icons.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'public')

// ---- 调色板（从原图里量出来的 6 个颜色） ----
const PAPER = [253, 251, 244] // #FDFBF4 纸底
const RULE = [232, 226, 212] // #E8E2D4 横线
const STEAM = [185, 178, 160] // #B9B2A0 热气
const BOWL = [232, 115, 74] // #E8734A 碗身
const INK = [194, 83, 51] // #C25333 描边
const SOUP = [246, 217, 138] // #F6D98A 汤面

// ---- 几何（都在 180x180 的设计稿坐标里） ----

/** 横线：等距 28，原稿画了 6 条 */
const RULE_SPACING = 28
const RULE_FIRST = 20
const RULE_COUNT = 6
const RULE_W = 1

/** 碗沿椭圆的中心与半径；外圈是碗的外缘 */
const RIM = { cx: 90, cy: 96, rx: 59, ry: 14 }

/** 汤面椭圆（比碗沿小一圈，中间留出的那圈就是碗沿的厚度） */
const SOUP_ELLIPSE = { cx: 90, cy: 96, rx: 51.5, ry: 12 }

/**
 * 碗身左侧轮廓：从最宽处往下到底，每行量一个半宽。
 * 底部是平的（y=147 处还有 25.5 的半宽），不是收成一个尖。
 */
const BODY_PROFILE = [
  [96, 59], [100, 57], [104, 55], [108, 54.5], [112, 53.5], [116, 52],
  [120, 50.5], [124, 48.5], [128, 45.5], [132, 43.5], [136, 40],
  [140, 35.5], [141, 34.5], [142, 33.5], [143, 32], [144, 30.5],
  [145, 29], [146, 27.5], [147, 25.5],
]

const OUTLINE_W = 2.5 // 碗沿描边宽度
const SOUP_STROKE_W = 2.2
const STEAM_W = 4.6

/**
 * 三缕热气：中间那缕最高，左右两缕矮一些，都是 S 形。
 *
 * 这里是**逐行量出来的「y → 该行中心 x」**，所以按 [y, x] 写更好核对，
 * 底下统一转成绘图用的 [x, y]。（曾经忘了转，整片热气被转置画歪。）
 */
const STEAM_PROFILE = [
  // 中间
  [
    [23, 87.5], [26, 86.5], [30, 86.0], [34, 86.5], [38, 87.0], [42, 88.6],
    [46, 90.5], [50, 92.0], [54, 93.0], [58, 94.0], [62, 93.9], [66, 93.0],
    [70, 91.5], [74, 90.0],
  ],
  // 左
  [
    [35, 60.5], [40, 61.5], [46, 64.5], [52, 66.5], [58, 68.0], [64, 67.5],
    [70, 65.5], [74, 64.0],
  ],
  // 右
  [
    [35, 112.5], [40, 113.5], [46, 116.5], [52, 118.5], [58, 120.0],
    [64, 119.5], [70, 117.5], [74, 116.0],
  ],
]

const STEAM_LINES = STEAM_PROFILE.map((line) => line.map(([y, x]) => [x, y]))

// ---------------------------------------------------------------- 几何工具

/** 碗的外轮廓：上半圈是碗沿椭圆，往下接碗身，底部是平的 */
function bowlPath() {
  const pts = []
  const STEPS = 48
  // 碗沿：从左侧最宽处沿椭圆上沿绕到右侧最宽处
  for (let i = 0; i <= STEPS; i++) {
    const a = Math.PI + (Math.PI * i) / STEPS
    pts.push([RIM.cx + RIM.rx * Math.cos(a), RIM.cy + RIM.ry * Math.sin(a)])
  }
  // 右半碗身：从上往下
  for (const [y, hw] of BODY_PROFILE) pts.push([RIM.cx + hw, y])
  // 平底
  const last = BODY_PROFILE[BODY_PROFILE.length - 1]
  pts.push([RIM.cx, last[0]])
  // 左半碗身：从下往上
  for (let i = BODY_PROFILE.length - 1; i >= 0; i--) {
    const [y, hw] = BODY_PROFILE[i]
    pts.push([RIM.cx - hw, y])
  }
  return pts
}

/** 椭圆采样成多边形 */
function ellipsePath({ cx, cy, rx, ry }) {
  const pts = []
  for (let i = 0; i < 96; i++) {
    const a = (Math.PI * 2 * i) / 96
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return pts
}

/**
 * 把折线加密成平滑曲线（Catmull-Rom 转三次贝塞尔再采样）。
 * 热气那几缕只有 8 个采样点，直接连会看出折角。
 */
function smooth(points, per = 16) {
  if (points.length < 3) return points
  const out = []
  const p = [points[0], ...points, points[points.length - 1]]
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]]
    for (let j = 0; j < per; j++) {
      const t = j / per
      const t2 = t * t
      const t3 = t2 * t
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
    }
  }
  out.push(points[points.length - 1])
  return out
}

/** 点到线段的距离 */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = ax + t * dx
  const qy = ay + t * dy
  return Math.hypot(px - qx, py - qy)
}

/** 多边形边界：包围盒 + 每条边的两个端点，避免每像素都遍历所有边 */
function prepare(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of poly) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  const edges = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const ex0 = Math.min(a[0], b[0]), ex1 = Math.max(a[0], b[0])
    const ey0 = Math.min(a[1], b[1]), ey1 = Math.max(a[1], b[1])
    edges.push([a[0], a[1], b[0], b[1], ex0, ey0, ex1, ey1])
  }
  return { poly, edges, bbox: [x0, y0, x1, y1] }
}

/** 射线法判断是否在多边形内 */
function inside(poly, x, y) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** 到多边形边界的距离；带符号，负数表示在内部 */
function signedDist(prep, x, y) {
  let d = Infinity
  for (const e of prep.edges) {
    // 先按包围盒粗筛，绝大多数边一次比较就跳过
    if (x < e[4] - d || x > e[6] + d || y < e[5] - d || y > e[7] + d) continue
    const dd = distToSegment(x, y, e[0], e[1], e[2], e[3])
    if (dd < d) d = dd
  }
  return inside(prep.poly, x, y) ? -d : d
}

/** 有符号距离 → 覆盖率，得到 1px 宽的抗锯齿边 */
const cov = (sd) => (sd <= -0.5 ? 1 : sd >= 0.5 ? 0 : 0.5 - sd)

/** 折线的描边覆盖率 */
function strokeCov(path, x, y, halfW) {
  let d = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const dd = distToSegment(x, y, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1])
    if (dd < d) d = dd
  }
  return cov(d - halfW)
}

// ---------------------------------------------------------------- 栅格化

/**
 * 把设计稿画成一块 RGBA 画布。
 *
 * @param size      输出边长（像素）
 * @param scale     设计稿 → 输出的缩放（1 表示铺满，maskable 要更小）
 * @param centerY   设计稿里的哪个 y 对齐到画布中心（maskable 要把内容居中）
 * @param bleed     横线是否铺满整张画布（maskable 的背景要出血，不然裁出来有白边）
 */
function render(size, { scale, centerY, bleed }) {
  const buf = Buffer.alloc(size * size * 4)
  const half = size / 2
  // 设计稿坐标 → 画布坐标
  const toCanvas = (x, y) => [half + (x - 90) * scale, half + (y - centerY) * scale]
  // 画布坐标 → 设计稿坐标，逐像素反查
  const toDesign = (cx, cy) => [90 + (cx - half) / scale, centerY + (cy - half) / scale]

  const bowl = prepare(bowlPath())
  const soup = prepare(ellipsePath(SOUP_ELLIPSE))
  const steam = STEAM_LINES.map((l) => smooth(l))

  // 横线：设计稿里的 6 条；bleed 模式下往上下两端继续排，铺满画布
  const rules = []
  const span = Math.ceil(size / scale / RULE_SPACING) + 1
  const lo = bleed ? -span : 0
  const hi = bleed ? RULE_COUNT - 1 + span : RULE_COUNT - 1
  for (let k = lo; k <= hi; k++) rules.push(RULE_FIRST + k * RULE_SPACING)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const [dx, dy] = toDesign(px + 0.5, py + 0.5)
      let r = PAPER[0], g = PAPER[1], b = PAPER[2]

      const over = (c, a) => {
        if (a <= 0) return
        r += (c[0] - r) * a
        g += (c[1] - g) * a
        b += (c[2] - b) * a
      }

      // 1. 横线：整条铺满宽度，只在上下两个边做 1px 抗锯齿
      for (const ry of rules) {
        const d = Math.abs(dy - ry)
        if (d > RULE_W / 2 + 1) continue
        over(RULE, Math.min(1, Math.max(0, RULE_W / 2 + 0.5 - d)))
      }

      // 2. 热气
      if (dy > 10 && dy < 85) {
        for (const s of steam) {
          if (dx < 50 || dx > 130) continue
          over(STEAM, strokeCov(s, dx, dy, STEAM_W / 2))
        }
      }

      // 3. 碗：先铺橘色，再描边，然后汤面盖上去
      if (dx > 25 && dx < 155 && dy > 76 && dy < 155) {
        over(BOWL, cov(signedDist(bowl, dx, dy)))
        over(INK, cov(Math.abs(signedDist(bowl, dx, dy)) - OUTLINE_W / 2))
        over(SOUP, cov(signedDist(soup, dx, dy)))
        over(INK, cov(Math.abs(signedDist(soup, dx, dy)) - SOUP_STROKE_W / 2))
      }

      const o = (py * size + px) * 4
      buf[o] = Math.round(r)
      buf[o + 1] = Math.round(g)
      buf[o + 2] = Math.round(b)
      buf[o + 3] = 255
    }
  }
  return buf
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** 8 位 RGBA、非隔行的 PNG。够用，不引依赖。 */
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA
  ihdr[10] = 0 // 压缩
  ihdr[11] = 0 // 滤波
  ihdr[12] = 0 // 非隔行

  // 每行前面加一个滤波字节（0 = None）
  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- 输出

/**
 * maskable 的安全区：内容必须落在画布中心、直径 80% 的圆内。
 * 算出「内容包围圆」的半径，反推需要缩小多少。
 *
 * 注意算的是包围「圆」而不是包围「盒」：碗最宽处在碗沿、最低处在碗底正中间，
 * 两个极值不在同一个点上，拿包围盒的对角线当半径会高估一大截。
 *
 * 另外这里只缩不放：内容本来就在安全区内的话保持原比例，
 * 免得 512 和 180 两张图长得不一样。
 */
function maskableScale() {
  const xs = []
  const ys = []
  for (const [x, y] of bowlPath()) {
    xs.push(x)
    ys.push(y)
  }
  for (const line of STEAM_LINES)
    for (const [x, y] of line) {
      xs.push(x)
      ys.push(y)
    }
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const radius = Math.max(
    ...xs.map((x, i) => Math.hypot(x - cx, ys[i] - cy)),
  )
  // 内容必须塞进半径 0.4*size 的圆里 → 相对铺满时的缩放（最多到 1，不放大）
  return { factor: Math.min(1, (0.4 * 180) / radius), cy, radius }
}

const TARGETS = [
  {
    file: 'icon-180.png',
    size: 180,
    // 与原始设计稿 1:1，用于 apple-touch-icon 和 manifest 的 "any"
    opts: { scale: 1, centerY: 90, bleed: false },
  },
  {
    file: 'icon-512.png',
    size: 512,
    // maskable：内容缩进安全区、居中，纸底和横线出血到整张画布
    opts: (() => {
      const s = maskableScale()
      return { scale: (512 / 180) * s.factor, centerY: s.cy, bleed: true }
    })(),
  },
]

const safe = maskableScale()
console.log(
  `▸ 内容包围圆半径 ${safe.radius.toFixed(1)}／安全区 ${(0.4 * 180).toFixed(0)}` +
    `（设计稿坐标），缩放 ${safe.factor.toFixed(3)}`,
)

for (const t of TARGETS) {
  const rgba = render(t.size, t.opts)
  const png = encodePNG(t.size, rgba)
  fs.writeFileSync(path.join(OUT, t.file), png)
  console.log(`✓ ${t.file}  ${t.size}x${t.size}  ${png.length} 字节`)
}
