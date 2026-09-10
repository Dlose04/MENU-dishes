import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { Recipe } from '../types'
import { useObjectUrl } from '../hooks/useObjectUrl'
import { useLongPress } from '../hooks/useLongPress'
import { Tape, tapeColorOf } from './Tape'
import { DIFFICULTIES } from '../types'

/** 由 id 派生一个稳定的倾斜角，重渲染不会跳。 */
export function tiltOf(id: string, spread = 1): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) | 0
  const v = (Math.abs(h) % 21) / 10 - 1 // -1 .. 1
  return `${(v * spread).toFixed(2)}deg`
}

const MAX_STARS = DIFFICULTIES.length

/** 难度画成星星：简单 1 颗、中等 2 颗、较难 3 颗，剩下的是灰星。 */
export function starsOf(difficulty: string): { lit: number; total: number } {
  const i = (DIFFICULTIES as readonly string[]).indexOf(difficulty)
  return { lit: i < 0 ? 1 : i + 1, total: MAX_STARS }
}

interface RecipeCardProps {
  recipe: Recipe
  selectable?: boolean
  selected?: boolean
  highlighted?: boolean
  onOpen: () => void
  onMore?: () => void
  onLongPress?: () => void
  onToggleSelect?: () => void
}

export function RecipeCard({
  recipe,
  selectable = false,
  selected = false,
  highlighted = false,
  onOpen,
  onMore,
  onLongPress,
  onToggleSelect,
}: RecipeCardProps) {
  const imageUrl = useObjectUrl(recipe.imageBlob)
  const cardRef = useRef<HTMLElement | null>(null)

  const { handlers, longPressed } = useLongPress(() => onLongPress?.(), 500)

  // 新建/编辑保存后滚动定位过来，并闪一下
  useEffect(() => {
    if (!highlighted) return
    cardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlighted])

  const handleClick = () => {
    // 长按已经进编辑了，别再跟一个 click 把详情页也顶开
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (selectable) {
      onToggleSelect?.()
      return
    }
    onOpen()
  }

  return (
    <article
      ref={cardRef}
      className={`card recipe-card${selected ? ' selected' : ''}`}
      style={{ '--tilt': tiltOf(recipe.id) } as CSSProperties}
      {...handlers}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label={recipe.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
    >
      <Tape variant="center" color={tapeColorOf(recipe.category)} />

      {selectable && (
        <span className={`select-box${selected ? ' on' : ''}`} aria-hidden="true">
          {selected ? '✓' : ''}
        </span>
      )}

      {onMore && !selectable && (
        <button
          type="button"
          className="card-more"
          aria-label={`${recipe.name} 的更多操作`}
          onClick={(e) => {
            e.stopPropagation()
            onMore()
          }}
        >
          ···
        </button>
      )}

      <div className={`recipe-thumb${imageUrl ? '' : ' is-placeholder'}`}>
        {imageUrl ? (
          <img src={imageUrl} alt={recipe.name} loading="lazy" decoding="async" />
        ) : (
          <span className="recipe-emoji" aria-hidden="true">
            {recipe.emoji}
          </span>
        )}
        {recipe.category && (
          <span
            className="tag"
            data-cat={recipe.category}
            style={{ '--tilt': tiltOf(recipe.id + 'tag', 2.5) } as CSSProperties}
          >
            {recipe.category}
          </span>
        )}
      </div>

      <div className="recipe-body">
        <h3 className="recipe-name">{recipe.name}</h3>
        <div className="recipe-meta">
          <span className="stars" aria-label={`难度 ${recipe.difficulty}`}>
            {Array.from({ length: starsOf(recipe.difficulty).total }, (_, i) => (
              <span key={i} className={i < starsOf(recipe.difficulty).lit ? '' : 'off'}>
                ★
              </span>
            ))}
          </span>
          <span>{recipe.difficulty}</span>
        </div>
        {recipe.ingredients.length > 0 && (
          <p className="subtitle" style={{ margin: 0 }}>
            {recipe.ingredients.slice(0, 3).join(' · ')}
            {recipe.ingredients.length > 3 ? ' …' : ''}
          </p>
        )}
      </div>
    </article>
  )
}
