import { useEffect, useRef, useState } from 'react'
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

  // 记住「这次打开弹层是给哪道菜换图」。
  //
  // 起因：点「从相册选」会立刻关掉弹层，而父组件（LibraryPage）传的 recipeId 是
  // `imageForId ?? ''` —— 一关就变成空字符串，React 也会把 onChange 换成新那次渲染
  // 的闭包。可 change 事件要等用户选完图才到，那时 recipeId 早就是 '' 了，
  // patchRecipe('') 找不到菜谱、返回 false，于是「选完图静默失败」。
  // 所以不能读实时的 prop，得把打开那一刻的 id 冻住。
  const targetId = useRef(recipeId)
  useEffect(() => {
    if (open) targetId.current = recipeId
  }, [open, recipeId])

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setBusy(true)
    try {
      const result = await compressImage(file)
      const ok = await patchRecipe(targetId.current, { imageBlob: result.blob })
      if (!ok) return
      if (result.compressed) {
        toast(`换好了（${formatBytes(file.size)} → ${formatBytes(result.blob.size)}）`)
      } else {
        toast('换好了。这张图没能压缩，占用空间会大一些', { duration: 4000 })
      }
    } catch {
      // HEIC 之类解不了码的图会走到这里。以前没接这个错，
      // 表现就是选完图一点反应都没有 —— 和「选择器没生效」长得一模一样。
      toast('这张图读不出来，换一张试试', { duration: 4000 })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* 这两个 input 必须**一直挂在文档上**，不能塞进下面的 <BottomSheet> 里。
          起因：点「从相册选」是先 input.click() 再 onClose()，而 BottomSheet 是
          `if (!open) return null` —— 系统选择器刚弹出来，承载它的 input 就被卸载了。
          原生 change 事件对游离节点照样触发，但 React 17+ 把事件委托挂在根容器上，
          脱离文档的节点冒泡不到那儿，onChange 永远不跑，用户看到的是「选完图没反应」。
          （设置页的「导入」走 lib/io.ts 的 pickFile：自己 addEventListener、
          用完才摘节点，所以一直是好的 —— 对照着看就知道差别在哪。） */}
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
      <BottomSheet open={open} title={busy ? '正在处理图片…' : '换一张图'} onClose={onClose}>
        <button
          type="button"
          className="sheet-item"
          disabled={busy}
          onClick={() => {
            // click() 必须在用户手势里同步触发，否则 iOS 会拦掉文件选择器。
            // onClose() 放在它后面没问题：input 现在不归弹层管了。
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
              const ok = await patchRecipe(targetId.current, { imageBlob: undefined })
              if (ok) toast('图片已删除')
            }}
          >
            <span aria-hidden="true">🗑️</span> 删除图片
          </button>
        )}
      </BottomSheet>
    </>
  )
}
