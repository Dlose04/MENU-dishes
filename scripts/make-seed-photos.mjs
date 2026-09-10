/**
 * 把 seed-photos/ 里的菜品照片转成 src/db/seed-photos.ts（base64 data URL）。
 *
 * 为什么要内联：这个应用硬性要求「一个 index.html 拿走就能用、断网也能用」，
 * 照片放在旁边当文件的话，双击 file:// 打开就取不到了。
 *
 * 关于体积：8 张照片压到最长边 720px、质量 72，合计约 400KB，base64 之后
 * 约 550KB —— 构建产物从 375KB 涨到 ~930KB。这是刻意的取舍：预置菜要带着
 * 自家的照片，就只能长在包里。以后想瘦身，先动这里的尺寸和质量。
 *
 * 用法：
 *   npm run seed-photos
 *
 * 注意：**缩放和压缩不在这个脚本里做** —— 它只负责读文件、转 base64。
 * 原始照片（手机拍出来三五 MB）先用 Pillow 之类处理过：
 *
 *   from PIL import Image, ImageOps
 *   im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
 *   im.thumbnail((720, 720), Image.LANCZOS)
 *   im.save(dst, 'JPEG', quality=72, optimize=True, progressive=True)
 *
 * exif_transpose 那一步别省：手机竖着拍的照片方向记在 EXIF 里，
 * 不转正的话在应用里会躺着。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'seed-photos')
const OUT = path.join(ROOT, 'src/db/seed-photos.ts')

/** 文件名（dish-N.jpg）→ 菜名。必须和 src/db/seed.ts 里的名字对得上。 */
const ORDER = [
  '番茄炒蛋',
  '酸辣土豆丝',
  '炒香干',
  '意祥一碗香',
  '红烧豆腐',
  '干锅包菜',
  '辣椒炒肉',
  '火腿炒蛋',
]

const entries = ORDER.map((name, i) => {
  const file = path.join(SRC_DIR, `dish-${i + 1}.jpg`)
  if (!fs.existsSync(file)) {
    throw new Error(`找不到 ${path.relative(ROOT, file)} —— 先跑一遍 seed-photos 的处理流程`)
  }
  const base64 = fs.readFileSync(file).toString('base64')
  return { name, base64, kb: Math.round(base64.length / 1024) }
})

const lines = entries.map(
  (e) => `  // ${e.name}（约 ${e.kb}KB）\n  ${JSON.stringify(e.name)}:\n    'data:image/jpeg;base64,${e.base64}',`,
)

const file = `/**
 * 预置菜的配图。**这个文件是 scripts/make-seed-photos.mjs 生成的，别手改** ——
 * 改了下次跑脚本就覆盖了。要换照片请改 seed-photos/ 里的原图再重新生成。
 *
 * 为什么是内联的 base64 字符串：单文件应用（file:// 双击可用、断网可用）
 * 取不到旁边的图片文件，只能长在包里。照片已压到最长边 720px，
 * 8 张合计约 ${Math.round(entries.reduce((s, e) => s + e.kb, 0) / 1024 * 10) / 10}MB 的 base64。
 */

export const SEED_PHOTOS: Record<string, string> = {
${lines.join('\n')}
}
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, file, 'utf8')
console.log(`✓ 写出 ${path.relative(ROOT, OUT)}`)
for (const e of entries) console.log(`   ${e.name}  ${e.kb}KB`)
console.log(`   合计 ${Math.round(entries.reduce((s, e) => s + e.kb, 0))}KB`)
