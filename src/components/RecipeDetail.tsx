import { useState } from 'react'
import type { Recipe } from '../types'
import { Tape } from './Tape'
import { CIcon } from './icons'
import { ActionSheet } from './BottomSheet'
import { ChangeImageSheet } from './ChangeImageSheet'
import { useObjectUrl } from '../hooks/useObjectUrl'
import { useVisualViewport } from '../hooks/useVisualViewport'
import { useBackGuard } from '../hooks/useBackGuard'
import { addToMenu, duplicateRecipe } from '../store/appStore'
import { toast } from '../store/toast'
import { todayKey } from '../lib/date'

interface RecipeDetailProps {
  recipe: Recipe
  onClose: () => void
  onEdit: () => void
  onDeleted: (id: string) => void
  onDuplicated: (id: string) => void
  onRequestDelete: (recipe: Recipe) => void
}

/** 菜谱详情。全屏浮层，和编辑器一个层级，避免手机上出现「弹窗套弹窗」。 */
export function RecipeDetail({
  recipe,
  onClose,
  onEdit,
  onDuplicated,
  onRequestDelete,
}: RecipeDetailProps) {
  const imageUrl = useObjectUrl(recipe.imageBlob)
  const [sheet, setSheet] = useState<'more' | 'image' | null>(null)
  const vp = useVisualViewport(true)

  // 详情页没有未保存内容，返回键直接关掉这一层就行
  useBackGuard(() => {
    if (sheet) {
      setSheet(null)
      return false
    }
    onClose()
    return true
  })

  return (
    <>
      <div
        className="editor"
        style={{ top: vp.offsetTop, height: vp.height, bottom: 'auto' }}
        role="dialog"
        aria-modal="true"
        aria-label={recipe.name}
      >
        <div className="editor-bar editor-bar-top-safe">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            返回
          </button>
          <div className="editor-bar-title">菜谱详情</div>
          <button type="button" className="btn btn-primary" onClick={onEdit}>
            编辑
          </button>
        </div>

        <div className="editor-body">
          <div className="field">
            <div className="cover" style={{ borderStyle: imageUrl ? 'solid' : 'dashed' }}>
              {imageUrl ? (
                <img src={imageUrl} alt={recipe.name} />
              ) : (
                <>
                  <span style={{ fontSize: 56 }} aria-hidden="true">
                    {recipe.emoji}
                  </span>
                  <span>还没有图片</span>
                </>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 24 }}>{recipe.name}</h2>
            <span style={{ fontSize: 26 }} aria-hidden="true">
              {recipe.emoji}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {recipe.category && (
              <span className="tag" data-cat={recipe.category}>
                {recipe.category}
              </span>
            )}
            <span className="tag tag-plain">难度 · {recipe.difficulty}</span>
          </div>

          <div className="divider" />

          <h3 className="section-title">食材</h3>
          {recipe.ingredients.length ? (
            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
              {recipe.ingredients.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="subtitle">还没写食材。</p>
          )}

          <h3 className="section-title">备注</h3>
          {recipe.note ? (
            <div className="card card-warm" style={{ whiteSpace: 'pre-wrap' }}>
              <Tape variant="left" />
              <p style={{ margin: 0, lineHeight: 1.9 }}>{recipe.note}</p>
            </div>
          ) : (
            <p className="subtitle">还没写备注。</p>
          )}

          <div className="divider" />

          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            onClick={async () => {
              const added = await addToMenu(todayKey(), [recipe.id])
              toast(added ? '已加入今日菜单' : '今日菜单里已经有它了')
            }}
          >
            <CIcon name="plus" /> 加入今日菜单
          </button>

          <div className="btn-row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn"
              style={{ flex: 1 }}
              onClick={() => setSheet('image')}
            >
              <CIcon name="image" /> 换图
            </button>
            <button
              type="button"
              className="btn"
              style={{ flex: 1 }}
              onClick={() => setSheet('more')}
            >
              更多
            </button>
          </div>
        </div>
      </div>

      <ActionSheet
        open={sheet === 'more'}
        title={recipe.name}
        onClose={() => setSheet(null)}
        actions={[
          { key: 'edit', label: '编辑', icon: '✏️', onSelect: onEdit },
          {
            key: 'dup',
            label: '复制一份',
            icon: '📄',
            onSelect: async () => {
              const copy = await duplicateRecipe(recipe.id)
              if (copy) {
                toast('已复制一份')
                onDuplicated(copy.id)
              }
            },
          },
          {
            key: 'del',
            label: '删除',
            icon: '🗑️',
            danger: true,
            onSelect: () => onRequestDelete(recipe),
          },
        ]}
      />

      <ChangeImageSheet
        open={sheet === 'image'}
        recipeId={recipe.id}
        hasImage={Boolean(recipe.imageBlob)}
        onClose={() => setSheet(null)}
      />
    </>
  )
}
