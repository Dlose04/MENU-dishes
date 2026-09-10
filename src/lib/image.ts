/**
 * 图片处理：相册原图 -> 压缩 -> Blob。
 *
 * 手机相册里一张图动辄 3~12MB，直接塞进 IndexedDB 又慢又占地方，
 * 所以统一压到最长边 800px、JPEG quality 0.75。
 *
 * HEIC（iPhone 默认格式）在部分浏览器里解不了码，这种情况降级为直接存原图，
 * 并告诉调用方「压缩失败」，由 UI 提示用户「图片较大，可能占用较多空间」。
 */

export const MAX_EDGE = 800
export const QUALITY = 0.75

export interface CompressResult {
  blob: Blob
  width: number
  height: number
  /** false = 没能压缩，存的是原图 */
  compressed: boolean
  /** 落回原图的原因，用于提示文案 */
  reason?: string
}

const isImageLike = (file: Blob): boolean =>
  file.type === '' || file.type.startsWith('image/')

/** 解码成可绘制的位图。按 兼容性/内存占用 从好到差依次尝试。 */
async function decode(
  blob: Blob,
  targetW: number,
  targetH: number,
): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  const attempts: Array<() => Promise<{ source: CanvasImageSource; width: number; height: number }>> = []

  if (typeof createImageBitmap === 'function') {
    // 1) 一步完成解码 + 缩放，大图最省内存。
    //    imageOrientation 让手机竖拍的照片按 EXIF 转正。
    attempts.push(async () => {
      const bmp = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
        resizeWidth: targetW,
        resizeHeight: targetH,
        resizeQuality: 'high',
      })
      return { source: bmp, width: bmp.width, height: bmp.height }
    })
    // 2) 老 Safari：不认 resizeWidth / imageOrientation 这两个参数
    attempts.push(async () => {
      const bmp = await createImageBitmap(blob)
      return { source: bmp, width: bmp.width, height: bmp.height }
    })
  }

  // 3) 最后的兜底：<img>。iOS Safari 对 HEIC 的解码支持最好。
  attempts.push(
    () =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob)
        const img = new Image()
        img.onload = () => {
          resolve({
            source: img,
            width: img.naturalWidth || targetW,
            height: img.naturalHeight || targetH,
          })
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          reject(new Error('图片解码失败'))
        }
        img.src = url
      }),
  )

  let lastErr: unknown
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('图片解码失败')
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, q: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 返回空'))),
        type,
        q,
      )
      return
    }
    // 远古兜底
    try {
      const dataUrl = canvas.toDataURL(type, q)
      resolve(dataURLToBlob(dataUrl))
    } catch (err) {
      reject(err instanceof Error ? err : new Error('canvas 导出失败'))
    }
  })
}

/**
 * 压缩图片。任何一步失败都会降级为「原图直接存」，不会抛异常。
 * @param file 用户从相册/相机拿到的文件
 */
export async function compressImage(
  file: File,
  maxEdge: number = MAX_EDGE,
  quality: number = QUALITY,
): Promise<CompressResult> {
  const fallback = (reason: string): CompressResult => ({
    blob: file,
    width: 0,
    height: 0,
    compressed: false,
    reason,
  })

  if (!isImageLike(file)) return fallback('这不是图片文件')
  if (file.size === 0) return fallback('文件是空的')

  try {
    // 先按原始尺寸猜一次目标尺寸；拿到真实尺寸后再算一遍。
    const probe = await decode(file, maxEdge, maxEdge)
    const scale = Math.min(1, maxEdge / Math.max(probe.width, probe.height))
    const outW = Math.max(1, Math.round(probe.width * scale))
    const outH = Math.max(1, Math.round(probe.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (!ctx) return fallback('浏览器不支持 canvas')

    // JPEG 没有透明通道，透明像素会变黑，所以先铺一层白底
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, outW, outH)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(probe.source, 0, 0, outW, outH)

    if (probe.source instanceof ImageBitmap) probe.source.close()

    const compressed = await canvasToBlob(canvas, 'image/jpeg', quality)

    // 小图有时「压缩」后反而更大，那就留原图
    if (compressed.size >= file.size) {
      return {
        blob: file,
        width: probe.width,
        height: probe.height,
        compressed: false,
        reason: '原图本身已经很小',
      }
    }

    return {
      blob: compressed,
      width: outW,
      height: outH,
      compressed: true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误'
    return fallback(msg)
  }
}

/** Blob -> dataURL。导出 JSON、以及 localStorage 降级模式都要用。 */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(blob)
  })
}

/** dataURL -> Blob。同步实现，不依赖网络。 */
export function dataURLToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('不是合法的 dataURL')
  const header = dataUrl.slice(0, comma)
  const body = dataUrl.slice(comma + 1)
  const mime = /:(.*?)(;|$)/.exec(header)?.[1] || 'application/octet-stream'
  if (header.includes(';base64')) {
    const bin = atob(body)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  }
  return new Blob([decodeURIComponent(body)], { type: mime })
}

/** 给用户看的体积文案。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
