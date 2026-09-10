/**
 * 合并算法：把两份菜谱库合成一份。
 *
 * 【最重要的一条性质：确定性】
 *
 * 这个函数会在**两台设备上各跑一遍**（还要在服务端之外多跑几轮重试）。
 * 同样两份输入，两边必须算出**逐字节相同**的结果 —— 否则设备 A 算出 X、
 * 设备 B 算出 Y，A 把 X 推上去、B 把 Y 推上去，两边永远合不上，
 * 而且表面上「各自都同步成功了」，最难查。
 *
 * 所以这里没有任何随机、没有任何依赖当前时间/设备/顺序的分支。
 * 时间戳打平时宁可随便定一个规则（「墓碑赢」），也不能没有规则。
 *
 * 【为什么菜谱要带墓碑、菜单不用】
 *
 * 删除一道菜，如果只是把记录抹掉，另一台设备下回同步会拿着它那份副本
 * 把菜加回来 —— 用户在手机上删的，在平板上又活了。所以删除要留一个
 * 「墓碑」记录（`deletedAt`），把「删除」这个动作本身也当成一条要同步的数据。
 *
 * 菜单不用，因为「清空菜单」= items 变成空数组，本身就是一份状态，
 * 配上更新的时间戳天然能把清空这个动作带过去。
 */

import type { Menu, Recipe } from '../types'
import { menuStamp, recipeStamp } from '../lib/stamp'

/**
 * 走网络的菜谱形状：**不含图片**。
 *
 * 一张压缩后的照片约 70KB，base64 之后接近 100KB，9 张就是小 1MB。
 * 每次同步都把这坨搬来搬去毫无意义（照片极少改），所以第一版照片不同步：
 * 菜名、分类、用料、难度、备注、菜单全都同步，图片留在各自设备上。
 */
export type SyncRecipe = Omit<Recipe, 'imageBlob'>

export type SyncMenu = Menu

export interface SyncPayload {
  recipes: SyncRecipe[]
  menus: SyncMenu[]
}

export const EMPTY_PAYLOAD: SyncPayload = { recipes: [], menus: [] }

/** 时间戳兜底：脏数据（NaN / 负数 / 缺字段）一律当 0，即「最旧」。 */
function safeStamp(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function recipeKey(r: SyncRecipe): number {
  return safeStamp(recipeStamp(r))
}

function menuKey(m: SyncMenu): number {
  return safeStamp(menuStamp(m))
}

/**
 * 同一道菜的两个版本，谁赢。
 *
 * 1. 时间戳大的赢 —— 这是常规路径。
 * 2. 时间戳**完全相同**时，让墓碑赢。
 *    必须挑一个确定性的规则出来。挑「墓碑赢」是因为：
 *    时间戳打平意味着两边毫秒级同时操作，删除是用户的明确意图，
 *    而编辑往往只是顺手改了个字 —— 保留删除更符合直觉。
 *    换个规则也行，但**不能没有规则**（见文件头那段）。
 */
function pickRecipe(a: SyncRecipe, b: SyncRecipe): SyncRecipe {
  const ta = recipeKey(a)
  const tb = recipeKey(b)
  if (ta !== tb) return ta > tb ? a : b
  const aDead = !!a.deletedAt
  const bDead = !!b.deletedAt
  if (aDead !== bDead) return aDead ? a : b
  // 时间戳和墓碑状态都一样，内容却不同（正常同步之后两边内容是一样的，
  // 走到这儿说明是设备间毫秒级撞车）。仍然必须给出一个**只取决于这两个对象**
  // 的结果 —— 不能返回 `a` 了事，那样「谁先合谁」会改变答案，交换律就没了。
  const ka = JSON.stringify(a)
  const kb = JSON.stringify(b)
  if (ka === kb) return a
  return ka > kb ? a : b
}

/**
 * 同一天菜单的两个版本，谁赢。整份 items 数组一起比，新的覆盖旧的。
 *
 * 【为什么不是并集】并集看着更「不丢数据」，但会让**「移除一道菜」和
 * 「清空菜单」永远失效** —— 另一台设备上那份还没更新的列表，会通过并集
 * 把删掉的菜原样带回来。用户按了删除却删不掉，比偶尔丢一次添加严重得多
 * （丢的那次用户会重加一遍，而删不掉会让人以为应用坏了）。
 * 整个数组 LWW 才能让删除真正生效。
 *
 * 【打平了怎么办】取一个**只取决于这两个对象**的确定结果（比 items 拼起来的
 * 字符串）。不能返回 `a` 了事 —— 那样 `pick(a,b)` 和 `pick(b,a)` 会给出不同的
 * 对象，交换律当场就没了，两台设备各推各的、永远合不上。
 *
 * 注意打平**不是罕见情况**：一台设备采纳了合并结果之后，两台设备的
 * items 和 updatedAt 就完全一样了，这是同步后的稳态。稳态下这个分支
 * 会走到 `ka === kb`，返回哪个都行（两个对象内容本来就相等）。
 * 只有「两台设备在同一毫秒改了同一天的菜单」才会真的丢掉一边 ——
 * 那时候也只能保一边，因为保两边的并集就等价于删除失效。
 */
function pickMenu(a: SyncMenu, b: SyncMenu): SyncMenu {
  const ta = menuKey(a)
  const tb = menuKey(b)
  if (ta !== tb) return ta > tb ? a : b
  const ka = menuContentKey(a)
  const kb = menuContentKey(b)
  if (ka === kb) return a
  return ka > kb ? a : b
}

/**
 * 菜单内容的比较键。
 *
 * 用 `\u0000` 当分隔符不是随手写的：菜名和 id 里都不可能出现它，
 * 所以 `['ab','c']` 和 `['a','bc']` 不会拼成同一个键。
 * 用 `''` 或 `','` 拼就会出现这种撞车，撞了之后两条不同的菜单被判成
 * 「内容相同」，合并结果取决于输入顺序 —— 又是那个合不上的老问题。
 *
 * 分隔符在源码里写成 `'\u0000'` 这个**转义**，别直接敲一个真的 NUL 字节进去：
 * 文件里一旦有裸控制字符，git 会把整个文件判成二进制，diff / blame / merge
 * 全都看不见 —— 偏偏这个文件最值钱的就是注释里这些推理。踩过一次。
 */
function menuContentKey(m: SyncMenu): string {
  return m.items.join('\u0000')
}

/**
 * 合并两个 payload。
 *
 * 保持原样返回输入对象的引用（没改动的那一侧不复制），调用方也不该依赖这一点。
 */
export function mergePayload(a: SyncPayload, b: SyncPayload): SyncPayload {
  const recipeById = new Map<string, SyncRecipe>()
  for (const r of a.recipes) if (r?.id) recipeById.set(r.id, r)
  for (const r of b.recipes) {
    if (!r?.id) continue
    const existing = recipeById.get(r.id)
    recipeById.set(r.id, existing ? pickRecipe(existing, r) : r)
  }

  const menuByDate = new Map<string, SyncMenu>()
  for (const m of a.menus) if (m?.date) menuByDate.set(m.date, m)
  for (const m of b.menus) {
    if (!m?.date) continue
    const existing = menuByDate.get(m.date)
    menuByDate.set(m.date, existing ? pickMenu(existing, m) : m)
  }

  return {
    // 排序让输出稳定：Map 的插入顺序取决于输入顺序，而输入顺序两台设备
    // 不一定一样。不排的话结果虽然语义相同，但字节不同，不好比对和测试。
    recipes: [...recipeById.values()].sort((x, y) => recipeKey(x) - recipeKey(y) || (x.id < y.id ? -1 : 1)),
    menus: [...menuByDate.values()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)),
  }
}

/* ------------------------------------------------------------------ */
/* 转换与清理                                                          */
/* ------------------------------------------------------------------ */

/** 本地菜谱 -> 可上传的形状。**这一步就是在丢掉图片**。 */
export function toSyncRecipe(recipe: Recipe): SyncRecipe {
  const { imageBlob: _imageBlob, ...rest } = recipe
  return rest
}

export function toSyncPayload(recipes: Recipe[], menus: Menu[]): SyncPayload {
  return { recipes: recipes.map(toSyncRecipe), menus: menus.map((m) => ({ ...m })) }
}

/**
 * 墓碑保留多久。
 *
 * 超过这个时间的墓碑会被清掉，否则云端文档会一直长（每删一道菜留一条）。
 * 代价是：**一台离线超过半年的设备再上线，它本地那份旧副本会把早已删除的菜
 * 复活**。半年是权衡后的数字 —— 家庭应用里设备闲置超过半年还回来的情况很少，
 * 而墓碑永久保留的成本是确定的、每天都在涨。
 */
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000

/** 清掉过期的墓碑。两边都会跑，但结果一致（都取决于同一个时间轴上的先后）。 */
export function pruneTombstones(recipes: SyncRecipe[], now = Date.now()): SyncRecipe[] {
  const cutoff = now - TOMBSTONE_TTL_MS
  return recipes.filter((r) => {
    if (!r.deletedAt) return true
    return safeStamp(r.deletedAt) > cutoff
  })
}

/** payload 里有没有实质内容（用来判断「要不要推」）。 */
export function payloadIsEmpty(p: SyncPayload): boolean {
  return p.recipes.length === 0 && p.menus.length === 0
}
