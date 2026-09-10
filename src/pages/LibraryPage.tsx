import { useCallback, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { CATEGORIES, type Recipe, type RecipeDraft } from '../types'
import { RecipeCard, tiltOf } from '../components/RecipeCard'
import { RecipeDetail } from '../components/RecipeDetail'
import { RecipeEditor } from '../components/RecipeEditor'
import { ChangeImageSheet } from '../components/ChangeImageSheet'
import { ActionSheet, BottomSheet } from '../components/BottomSheet'
import { EmptyBowl } from '../components/EmptyBowl'
import { CIcon } from '../components/icons'
import {
  bulkSetCategory,
  createRecipe,
  deleteRecipes,
  duplicateRecipe,
  restoreDeleted,
  updateRecipe,
  useRecipes,
} from '../store/appStore'
import { confirmDialog } from '../store/confirm'
import { toast } from '../store/toast'

/** 去掉 store 负责的字段，得到编辑器要的表单数据。 */
function toDraft(r: Recipe): RecipeDraft {
  const { id: _id, createdAt: _createdAt, ...draft } = r
  void _id
  void _createdAt
  return draft
}

interface EditingTarget {
  recipe: Recipe | null
}

export function LibraryPage() {
  const recipes = useRecipes()

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditingTarget | null>(null)
  const [sheetForId, setSheetForId] = useState<string | null>(null)
  const [imageForId, setImageForId] = useState<string | null>(null)
  const [catPickerOpen, setCatPickerOpen] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)

  /* ---------------- 筛选 ---------------- */

  // 只显示库里真的用到的分类；顺序按预设分类走，用户自建分类排在后面
  const availableCategories = useMemo(() => {
    const used = new Set(recipes.map((r) => r.category).filter(Boolean))
    const known = CATEGORIES.filter((c) => used.has(c)) as string[]
    const extra = [...used].filter((c) => !(CATEGORIES as readonly string[]).includes(c))
    return [...known, ...extra.sort()]
  }, [recipes])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return recipes.filter((r) => {
      if (category && r.category !== category) return false
      if (!q) return true
      const haystack = `${r.name} ${r.ingredients.join(' ')}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [recipes, category, query])

  const detailRecipe = detailId ? recipes.find((r) => r.id === detailId) ?? null : null
  const sheetRecipe = sheetForId ? recipes.find((r) => r.id === sheetForId) ?? null : null

  /* ---------------- 删除 + 撤销 ---------------- */

  const removeRecipes = useCallback(async (ids: string[]) => {
    const names = ids
      .map((id) => recipes.find((r) => r.id === id)?.name)
      .filter(Boolean) as string[]
    const payload = await deleteRecipes(ids)
    if (!payload) return

    const label =
      names.length === 1 ? `已删除「${names[0]}」` : `已删除 ${names.length} 道菜`
    toast(label, {
      actionLabel: '撤销',
      duration: 10_000,
      onAction: () => {
        void restoreDeleted(payload)
        toast('已撤销')
      },
    })
  }, [recipes])

  const requestDelete = useCallback(
    async (recipe: Recipe) => {
      const ok = await confirmDialog({
        title: `删除「${recipe.name}」？`,
        message: '删除后 10 秒内可以撤销。',
        confirmText: '删除',
        danger: true,
      })
      if (!ok) return
      setDetailId(null)
      await removeRecipes([recipe.id])
    },
    [removeRecipes],
  )

  /* ---------------- 多选 ---------------- */

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelected([])
  }

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const allSelected = filtered.length > 0 && selected.length === filtered.length

  /* ---------------- 保存回调 ---------------- */

  const handleSaved = useCallback(
    async (saved: Recipe, mode: 'create' | 'update') => {
      setEditing(null)
      if (mode === 'create') {
        const created = await createRecipe(toDraft(saved))
        if (!created) return
        toast('已保存')
        // 新菜默认排在列表最后（按创建时间升序），滚过去闪一下，
        // 免得用户「保存完找不到它去哪了」
        setCategory(null)
        setQuery('')
        setHighlightId(created.id)
        window.setTimeout(() => setHighlightId(null), 2400)
      } else {
        const updated = await updateRecipe(saved.id, toDraft(saved))
        if (!updated) return
        toast('已保存')
        // 从详情进来编辑的：保存后退回列表，让用户直接看到卡片已更新
        setDetailId(null)
      }
    },
    [],
  )

  const openNew = () => setEditing({ recipe: null })

  return (
    <>
      <header className="app-head">
        <h1 className="app-title">菜谱本</h1>
        <div className="app-head-side">
          {selectMode ? (
            <button type="button" className="btn btn-sm" onClick={exitSelectMode}>
              完成
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!recipes.length}
                onClick={() => setSelectMode(true)}
              >
                选择
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={openNew}>
                <CIcon name="plus" size={16} /> 新菜
              </button>
            </>
          )}
        </div>
      </header>

      <div className="page">
        {recipes.length > 0 && (
          <>
            <div className="search">
              <span className="search-icon" aria-hidden="true">
                🔍
              </span>
              <input
                className="input"
                type="search"
                value={query}
                placeholder="搜菜名或食材"
                autoComplete="off"
                enterKeyHint="search"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="chip-row">
              <button
                type="button"
                className={`chip${category === null ? ' on' : ''}`}
                data-cat=""
                onClick={() => setCategory(null)}
              >
                全部 {recipes.length}
              </button>
              {availableCategories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chip${category === c ? ' on' : ''}`}
                  data-cat={c}
                  style={{ '--tilt': tiltOf(c, 0.8) } as CSSProperties}
                  onClick={() => setCategory(category === c ? null : c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </>
        )}

        {recipes.length === 0 ? (
          <div className="empty">
            <EmptyBowl />
            <p className="empty-title">手账还是空的</p>
            <p className="empty-desc">
              点右上角的「新菜」记下第一道菜，
              <br />
              或者去设置页把预置的家常菜载进来。
            </p>
            <button type="button" className="btn btn-primary" onClick={openNew}>
              <CIcon name="plus" size={16} /> 记一道菜
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <EmptyBowl />
            <p className="empty-title">没找到</p>
            <p className="empty-desc">换个词，或者把分类筛选取消试试。</p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQuery('')
                setCategory(null)
              }}
            >
              清空筛选
            </button>
          </div>
        ) : (
          <div className="grid">
            {filtered.map((r) => (
              <RecipeCard
                key={r.id}
                recipe={r}
                selectable={selectMode}
                selected={selected.includes(r.id)}
                highlighted={highlightId === r.id}
                onOpen={() => setDetailId(r.id)}
                onMore={() => setSheetForId(r.id)}
                onLongPress={() => setEditing({ recipe: r })}
                onToggleSelect={() => toggleSelected(r.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 多选模式的底部工具栏 */}
      {selectMode && (
        <div className="bottom-bar">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              setSelected(allSelected ? [] : filtered.map((r) => r.id))
            }
          >
            {allSelected ? '取消全选' : '全选'}
          </button>
          <span className="count">已选 {selected.length}</span>
          <div className="grow" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!selected.length}
            onClick={() => setCatPickerOpen(true)}
          >
            批量改分类
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={!selected.length}
            onClick={async () => {
              const ok = await confirmDialog({
                title: `删除选中的 ${selected.length} 道菜？`,
                message: '删除后 10 秒内可以撤销。',
                confirmText: '删除',
                danger: true,
              })
              if (!ok) return
              const ids = selected
              exitSelectMode()
              await removeRecipes(ids)
            }}
          >
            删除
          </button>
        </div>
      )}

      {/* 卡片「···」操作单 */}
      <ActionSheet
        open={sheetRecipe !== null}
        title={sheetRecipe?.name}
        onClose={() => setSheetForId(null)}
        actions={
          sheetRecipe
            ? [
                {
                  key: 'edit',
                  label: '编辑',
                  icon: '✏️',
                  onSelect: () => setEditing({ recipe: sheetRecipe }),
                },
                {
                  key: 'image',
                  label: '换图',
                  icon: '🖼️',
                  onSelect: () => setImageForId(sheetRecipe.id),
                },
                {
                  key: 'dup',
                  label: '复制一份',
                  icon: '📄',
                  onSelect: async () => {
                    const copy = await duplicateRecipe(sheetRecipe.id)
                    if (!copy) return
                    toast('已复制一份')
                    setCategory(null)
                    setQuery('')
                    setHighlightId(copy.id)
                    window.setTimeout(() => setHighlightId(null), 2400)
                  },
                },
                {
                  key: 'del',
                  label: '删除',
                  icon: '🗑️',
                  danger: true,
                  onSelect: () => void requestDelete(sheetRecipe),
                },
              ]
            : []
        }
      />

      <ChangeImageSheet
        open={imageForId !== null}
        recipeId={imageForId ?? ''}
        hasImage={Boolean(recipes.find((r) => r.id === imageForId)?.imageBlob)}
        onClose={() => setImageForId(null)}
      />

      {/* 批量改分类 */}
      <BottomSheet
        open={catPickerOpen}
        title={`把 ${selected.length} 道菜改成…`}
        onClose={() => setCatPickerOpen(false)}
      >
        <div className="chip-row" style={{ flexWrap: 'wrap', overflowX: 'visible' }}>
          {(CATEGORIES as readonly string[]).map((c) => (
            <button
              key={c}
              type="button"
              className="chip"
              data-cat={c}
              onClick={async () => {
                const n = await bulkSetCategory(selected, c)
                setCatPickerOpen(false)
                exitSelectMode()
                if (n) toast(`已把 ${n} 道菜改成「${c}」`)
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </BottomSheet>

      {/* 详情 */}
      {detailRecipe && (
        <RecipeDetail
          recipe={detailRecipe}
          onClose={() => setDetailId(null)}
          onEdit={() => setEditing({ recipe: detailRecipe })}
          onDeleted={(id) => {
            if (detailId === id) setDetailId(null)
          }}
          onDuplicated={(id) => {
            setDetailId(id)
          }}
          onRequestDelete={(r) => void requestDelete(r)}
        />
      )}

      {/* 编辑器 */}
      {editing && (
        <RecipeEditor
          recipe={editing.recipe}
          onClose={() => setEditing(null)}
          onSaved={(saved, mode) => void handleSaved(saved, mode)}
        />
      )}
    </>
  )
}
