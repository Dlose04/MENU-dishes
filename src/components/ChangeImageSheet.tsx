import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { BottomSheet } from './BottomSheet'
import { compressImage, formatBytes } from '../lib/image'
import { patchRecipe } from '../store/appStore'
import { toast } from '../store/toast'

/**
 * 「换图」的快捷入口：直接从列表/详情页换一张图，不用进整个编辑表单。
 * 这样用户给预置菜配图只要两步。
 */
export function ChangeImageSheet({
  open,
  recipeId,
  hasImage,
  onClose,
}: {
  open: boolean
  recipeId: string
  hasImage: boolean
  onClose: () => void
}) {
  const galleryInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setBusy(true)
    try {
      const result = await compressImage(file)
      const ok = await patchRecipe(recipeId, { imageBlob: result.blob })
      if (!ok) return
      if (result.compressed) {
        toast(`换好了（${formatBytes(file.size)} → ${formatBytes(result.blob.size)}）`)
      } else {
        toast('换好了。这张图没能压缩，占用空间会大一些', { duration: 4000 })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={open} title={busy ? '正在处理图片…' : '换一张图'} onClose={onClose}>
      <input
        ref={galleryInput}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      <button
        type="button"
        className="sheet-item"
        disabled={busy}
        onClick={() => {
          galleryInput.current?.click()
          onClose()
        }}
      >
        <span aria-hidden="true">🖼️</span> 从相册选
      </button>
      <button
        type="button"
        className="sheet-item"
        disabled={busy}
        onClick={() => {
          cameraInput.current?.click()
          onClose()
        }}
      >
        <span aria-hidden="true">📷</span> 拍照
      </button>
      {hasImage && (
        <button
          type="button"
          className="sheet-item danger"
          disabled={busy}
          onClick={async () => {
            onClose()
            const ok = await patchRecipe(recipeId, { imageBlob: undefined })
            if (ok) toast('图片已删除')
          }}
        >
          <span aria-hidden="true">🗑️</span> 删除图片
        </button>
      )}
    </BottomSheet>
  )
}
