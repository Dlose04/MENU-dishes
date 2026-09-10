/**
 * 同名归并：**一个菜名只留一条活着的记录**。
 *
 * 【为什么必须有这一步】
 * 同步是按 **id** 去重的（`merge.ts` 的 `recipeById`）。这个前提只有在
 * 「同一道菜在任何设备上都是同一个 id」时才成立。而预置菜的 id 曾经是
 * `nanoid()` 随机生成的，后来才改成按菜名派生的 `preset-<菜名>`
 * （见 db/seed.ts 里 `presetId` 那段）—— 改 id 规则**只对以后新播种的设备生效**，
 * 云端和已经装过的设备里那批随机 id 的老记录一条都没动。
 *
 * 于是老记录和新记录一碰面：同一个菜名，两个 id，按 id 合并两条都留下。
 * 用户看到的是「全部 18」—— 9 道菜每道两条，一条带照片（本机新播的），
 * 一条没有（从云端回来的，同步不搬图片）。而且这个状态会随着每次同步
 * 扩散到每一台设备。单机上永远复现不出来。
 *
 * 【为什么是「同名合并」而不是「修好 id 生成规则」】
 * 生成规则早就修好了，治不了已经存在的数据。名字是唯一一个**跨设备、
 * 跨版本都不变**的标识：id 规则改过，名字没改过。而且这个应用本来就
 * 把菜名当身份用 —— 分享链接进来的菜重名会复用已有的那条，不新建
 * （见 appStore 的 `addFromShare`）。这里只是把这个约定在同步这条路上
 * 也执行一遍。
 *
 * 【照片怎么办】
 * 同步数据里没有图片（见 merge.ts），照片只能在本机内部搬。所以：
 * - 留下的那条自己没图、被合并掉的那条有 → 把图接过来。
 * - 活着的记录没图、而同名的（**已删的**）记录身上还有图 → 也接过来。
 *   这条不是锦上添花：另一台设备上照片可能正好存在被删的那条身上，
 *   不接的话那张图会随着墓碑写回**被静默释放掉**（`put` 是整条替换）。
 *
 * 【被合并掉的那条要留墓碑，不能真删】
 * 直接删掉的话，另一台设备下回同步会拿着它那份副本把菜加回来 ——
 * 「删了又活」是同步最经典的 bug。墓碑的时间戳还必须**比这一组里所有
 * 记录都新**，否则别的设备上那条老副本会赢过墓碑；也不能太旧，
 * 太旧会被 `pruneTombstones` 当过期清掉（同样会复活）。
 */

import type { Menu, Recipe } from '../types'
import { recipeStamp } from '../lib/stamp'

export interface ConsolidateResult {
  /** 归并后的完整记录列表（**含墓碑**） */
  recipes: Recipe[]
  /** 归并后的菜单（指向旧 id 的引用已经改指到留下的那条） */
  menus: Menu[]
  /** 需要落库的记录：新墓碑 + 换了照片的那条 */
  recipeWrites: Recipe[]
  /** 需要落库的菜单：引用被改过的那些 */
  menuWrites: Menu[]
  /** 合并掉了几组重名（0 表示什么都没动） */
  mergedGroups: number
  /** 被合并掉的记录 id（都变成了墓碑） */
  removedIds: string[]
  /** 有几条记录从同名的记录身上接回了照片 */
  photoRescued: number
}

export interface ConsolidateOptions {
  /**
   * 打给墓碑的时间戳。由调用方给（store 里是 `nextStamp()`），
   * 这样墓碑一定比本次归并前发生的一切都新。
   */
  stamp: number
  /**
   * 本机那份照片（id -> Blob）。
   *
   * 同步写回时**必须**传：合并结果里那些记录是不带图的（云端不存图），
   * 而照片可能存在即将变成墓碑的那条本地记录上 —— 不从这儿拿就永远拿不到了。
   */
  photos?: Map<string, Blob>
}

/** 取一条记录身上的照片：先看它自己，再查本机那份。 */
function photoOf(recipe: Recipe, photos?: Map<string, Blob>): Blob | undefined {
  return recipe.imageBlob ?? photos?.get(recipe.id)
}

/**
 * 一组同名的记录里留哪条。
 *
 * 1. 时间戳大的赢 —— 被合并掉那条的改动必然更旧，所以不会丢用户的改动。
 * 2. 打平了优先 `preset-<菜名>` 那条：它是「标准 id」，让它活下来
 *    下次归并时这一组就不存在了，收敛得更干净。
 * 3. 还打平就比 id 字符串 —— 必须给一个**只取决于这组记录本身**的规则，
 *    两台设备各跑一遍才会算出同一条，否则各留各的、又合不上。
 */
function pickWinner(name: string, group: Recipe[]): Recipe {
  const canonical = `preset-${name}`
  const rank = (r: Recipe) => (r.id === canonical ? 0 : 1)
  return [...group].sort((a, b) => {
    const byStamp = recipeStamp(b) - recipeStamp(a)
    if (byStamp) return byStamp
    const byCanonical = rank(a) - rank(b)
    if (byCanonical) return byCanonical
    return a.id < b.id ? -1 : 1
  })[0]
}

export function consolidateByName(
  recipes: Recipe[],
  menus: Menu[],
  opts: ConsolidateOptions,
): ConsolidateResult {
  const { stamp, photos } = opts

  // 按菜名分组，**墓碑也算进来**：它们不参与归并（墓碑代表「已经删了」，
  // 不是一道活着的菜），但它们是找照片时最重要的来源 —— 另一台设备上
  // 照片完全可能正好存在那条已经变成墓碑的记录身上。
  const byName = new Map<string, Recipe[]>()
  for (const r of recipes) {
    const list = byName.get(r.name)
    if (list) list.push(r)
    else byName.set(r.name, [r])
  }

  /** 被合并掉的 id -> 留下的那条的 id（菜单引用要改指到这里） */
  const replaceId = new Map<string, string>()
  /** 留下的那条 -> 换过照片的新对象 */
  const replaced = new Map<string, Recipe>()
  const tombstones: Recipe[] = []
  const removedIds: string[] = []
  let mergedGroups = 0
  let photoRescued = 0

  for (const [name, all] of byName) {
    // 墓碑不参与归并：把「已删的同名记录」也算成重名的话，
    // 删掉一道菜再记一道同名的，新的那条会被当成副本合掉。
    const group = all.filter((r) => !r.deletedAt)
    if (!group.length) continue

    const winner = pickWinner(name, group)
    const losers = group.filter((r) => r.id !== winner.id)

    // 【照片接回来】顺序在「写墓碑」之前 —— 墓碑是不带图的，
    // 晚一步这条图就已经被释放掉了。
    if (!photoOf(winner, photos)) {
      const donor = [...losers].sort(
        (a, b) => recipeStamp(b) - recipeStamp(a) || (a.id < b.id ? -1 : 1),
      ).find((r) => photoOf(r, photos))
      const photo = donor && photoOf(donor, photos)
      if (photo) {
        replaced.set(winner.id, { ...winner, imageBlob: photo })
        photoRescued++
      }
    }

    if (!losers.length) continue

    // 墓碑要比这一组里所有记录都新（否则别处的老副本会赢过它、把菜复活），
    // 也不能比「现在」还旧（太旧会被 pruneTombstones 清掉，同样会复活）。
    const tomb = Math.max(stamp, ...group.map(recipeStamp)) + 1
    for (const l of losers) {
      const { imageBlob: _imageBlob, ...rest } = l
      tombstones.push({ ...rest, updatedAt: tomb, deletedAt: tomb })
      replaceId.set(l.id, winner.id)
      removedIds.push(l.id)
    }
    mergedGroups++
  }

  // 活着的记录没图、同名的那条（多半是个墓碑）身上还有图 -> 接回来。
  // 见文件头【照片怎么办】第二条。
  const rescued: Recipe[] = []
  for (const r of recipes) {
    if (r.deletedAt || photoOf(r, photos) || replaced.has(r.id)) continue
    const donors = byName.get(r.name)?.filter((o) => o.id !== r.id && photoOf(o, photos)) ?? []
    // 优先找墓碑：那条的图下一步就会随着墓碑写回被释放掉，不接就没了。
    const donor = donors.find((o) => o.deletedAt) ?? donors[0]
    const photo = donor && photoOf(donor, photos)
    if (photo) {
      rescued.push({ ...r, imageBlob: photo })
      photoRescued++
    }
  }

  const patched = new Map(replaced)
  for (const r of rescued) patched.set(r.id, r)

  const nextRecipes = [
    ...recipes.filter((r) => !replaceId.has(r.id)).map((r) => patched.get(r.id) ?? r),
    ...tombstones,
  ]

  // 菜单里指向被合并掉那条的引用，改指到留下的那条。
  // 不去重的话，一天的菜单里同时含新旧两个 id 时，同一道菜会显示两遍。
  const menuWrites: Menu[] = []
  const nextMenus = menus.map((m) => {
    if (!m.items.some((i) => replaceId.has(i))) return m
    const items: string[] = []
    for (const i of m.items) {
      const id = replaceId.get(i) ?? i
      if (!items.includes(id)) items.push(id)
    }
    // 必须打新时间戳：不打的话这条菜单的时间戳还停在改之前，
    // 下次同步会被别的设备那份（还指着旧 id 的）顶掉，菜从菜单里消失。
    const next: Menu = { date: m.date, items, updatedAt: stamp }
    menuWrites.push(next)
    return next
  })

  const recipeWrites = [...tombstones, ...patched.values()]

  return {
    recipes: nextRecipes,
    menus: nextMenus,
    recipeWrites,
    menuWrites,
    mergedGroups,
    removedIds,
    photoRescued,
  }
}
