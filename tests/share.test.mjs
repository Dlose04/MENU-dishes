import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { load, src } from './_bundle.mjs'

const share = await load(src('lib/share.ts'))
const { encodeDishes, decodeDishes, buildShareUrl, readShareFromLocation, MAX_SHARE_URL_LENGTH } =
  share

// 官方 npm 包，用来验证内联进来的 lz-string 没被改坏
const require = createRequire(import.meta.url)
const OfficialLZString = require('lz-string')

const PRESET_DISHES = [
  { n: '番茄炒蛋', c: '家常热菜', e: '🍅' },
  { n: '青椒肉丝', c: '家常热菜', e: '🫑' },
  { n: '酸辣土豆丝', c: '家常热菜', e: '🥔' },
  { n: '麻婆豆腐', c: '家常热菜', e: '🌶️' },
  { n: '红烧肉', c: '硬菜', e: '🥩' },
  { n: '宫保鸡丁', c: '硬菜', e: '🍗' },
  { n: '可乐鸡翅', c: '硬菜', e: '🥤' },
  { n: '清蒸鲈鱼', c: '硬菜', e: '🐟' },
  { n: '糖醋排骨', c: '硬菜', e: '🍖' },
  { n: '蒜蓉西兰花', c: '素菜', e: '🥦' },
  { n: '干煸四季豆', c: '素菜', e: '🫛' },
  { n: '紫菜蛋花汤', c: '汤羹', e: '🍲' },
]

test('内联的 lz-string 与官方 npm 包输出逐字节一致', () => {
  const payload = JSON.stringify({ v: 1, d: PRESET_DISHES })
  const official = OfficialLZString.compressToEncodedURIComponent(payload)
  assert.equal(encodeDishes(PRESET_DISHES), official)
})

test('编码用了 URI-safe 字符集，不含会被转义的 / = % # &', () => {
  const encoded = encodeDishes(PRESET_DISHES)
  assert.match(encoded, /^[A-Za-z0-9+\-$]+$/, '出现了意料之外的字符')
  for (const ch of ['/', '=', '%', '#', '&', '?', ' ']) {
    assert.ok(!encoded.includes(ch), `不该包含 ${ch}`)
  }
})

test('12 道预置菜能原样往返', () => {
  const decoded = decodeDishes(encodeDishes(PRESET_DISHES))
  assert.deepEqual(decoded, PRESET_DISHES)
})

test('同样能解出官方库压出来的链接（以后换实现也不会读不了老链接）', () => {
  const payload = JSON.stringify({ v: 1, d: PRESET_DISHES })
  const encoded = OfficialLZString.compressToEncodedURIComponent(payload)
  assert.deepEqual(decodeDishes(encoded), PRESET_DISHES)
})

test('经过 URLSearchParams 一轮（+ 被解成空格）后仍然解得开', () => {
  const encoded = encodeDishes(PRESET_DISHES)
  const param = new URLSearchParams(`m=${encoded}`).get('m')
  assert.ok(param.includes(' ') || param.includes('+'))
  assert.deepEqual(decodeDishes(param), PRESET_DISHES)
})

test('12 道菜的分享链接稳稳落在 1800 字符以内', () => {
  const { url, length, tooLong } = buildShareUrl(
    PRESET_DISHES,
    'https://example.github.io/family-menu/',
  )
  assert.ok(length < MAX_SHARE_URL_LENGTH, `链接太长了：${length}`)
  assert.equal(tooLong, false)
  assert.ok(url.startsWith('https://example.github.io/family-menu/?m='))
})

test('普通家宴的菜单离安全线还远得很', () => {
  // 一顿饭十几道菜是上限了，这时候链接应该还是三位数长度
  const feast = Array.from({ length: 16 }, (_, i) => ({
    n: `第${i}道菜红烧狮子头`,
    c: '硬菜',
    e: '🍲',
  }))
  const { length, tooLong } = buildShareUrl(feast, 'https://example.github.io/family-menu/')
  assert.equal(tooLong, false)
  assert.ok(length < 600, `16 道菜不该有 ${length} 个字符`)
})

test('菜名各不相同又很多时，链接会超长并给出提示（而不是被无声截断）', () => {
  // 关键点：压缩对「重复的菜名」很有效，对「一百多道各不相同的菜」就没那么神了。
  // 这正是需要 tooLong 提醒的真实场景。
  const pool = '烧炒炖煮蒸焖煎炸溜爆熘烹扒烩烤腌卤酱拌炝冻酥蜜拔丝羹汤粥面饼糕团丸卷包'
  const meat = '鸡鸭鱼肉虾蟹牛羊猪兔蛙鳝参翅肚筋腩排骨肘肝腰肠'
  const veg = '菇笋藕芹茄瓜豆芽菜薹苗尖根皮叶花果仁'
  const pick = (s, i) => s[i % s.length]

  const many = Array.from({ length: 200 }, (_, i) => ({
    n: `${pick(pool, i * 7)}${pick(meat, i * 13)}${pick(pool, i * 3)}${pick(veg, i * 11)}${pick(pool, i * 5)}${pick(veg, i * 17)}`,
    c: '硬菜',
    e: '🍲',
  }))

  const { tooLong, length } = buildShareUrl(many, 'https://example.github.io/family-menu/')
  assert.equal(tooLong, true, `200 道不重名的菜只有 ${length} 字符？`)
  assert.ok(length > MAX_SHARE_URL_LENGTH)
})

test('坏链接一律返回 null，绝不抛异常', () => {
  // 用户可能手抖改了几个字符、聊天软件也可能截断
  const cases = [
    '',
    'not-a-real-payload',
    'abc$$$-xyz',
    'ABCDEF',
    encodeDishes(PRESET_DISHES).slice(0, 20), // 被截断
    encodeDishes(PRESET_DISHES).slice(5), // 从中间截断
  ]
  for (const bad of cases) {
    assert.doesNotThrow(() => decodeDishes(bad), `解 ${bad.slice(0, 16)} 时抛异常了`)
    assert.equal(decodeDishes(bad), null, `${bad.slice(0, 16)} 应该解不出来`)
  }
})

test('空菜名的条目会被丢掉，不会建出无名菜谱', () => {
  const encoded = encodeDishes([
    { n: '红烧肉', c: '硬菜', e: '🥩' },
    { n: '   ', c: '硬菜', e: '🥩' },
    { n: '', c: '', e: '' },
  ])
  assert.deepEqual(decodeDishes(encoded), [{ n: '红烧肉', c: '硬菜', e: '🥩' }])
})

test('超长字段会被截断，防止有人手搓一个巨型链接', () => {
  const encoded = encodeDishes([{ n: 'x'.repeat(200), c: 'y'.repeat(50), e: '🍅' }])
  const decoded = decodeDishes(encoded)
  assert.equal(decoded[0].n.length, 40)
  assert.equal(decoded[0].c.length, 12)
})

test('也认没压缩的裸 JSON（方便手工调链接）', () => {
  const raw = JSON.stringify({ v: 1, d: [{ n: '红烧肉', c: '硬菜', e: '🥩' }] })
  assert.deepEqual(decodeDishes(raw), [{ n: '红烧肉', c: '硬菜', e: '🥩' }])
  assert.deepEqual(decodeDishes(JSON.stringify([{ n: '红烧肉', c: '硬菜', e: '🥩' }])), [
    { n: '红烧肉', c: '硬菜', e: '🥩' },
  ])
})

test('readShareFromLocation 能从常见 URL 形态里找到参数', () => {
  const encoded = encodeDishes(PRESET_DISHES)
  const base = 'https://example.com/app/'
  assert.deepEqual(readShareFromLocation(`${base}?m=${encoded}`), PRESET_DISHES)
  assert.deepEqual(readShareFromLocation(`${base}?foo=1&m=${encoded}&bar=2`), PRESET_DISHES)
  assert.deepEqual(readShareFromLocation(`${base}#m=${encoded}`), PRESET_DISHES)
  assert.equal(readShareFromLocation(base), null)
  assert.equal(readShareFromLocation(`${base}?m=`), null)
})

test('file:// 下也能拼出链接（origin 是字符串 "null"，不能直接拿来用）', () => {
  const { url } = buildShareUrl(
    PRESET_DISHES,
    'file:///E:/family-menu/dist/index.html',
  )
  assert.ok(url.startsWith('file:///E:/family-menu/dist/index.html?m='), url.slice(0, 60))
  const dishes = readShareFromLocation(url)
  assert.deepEqual(dishes, PRESET_DISHES)
})

test('已有其他 query 参数时用 & 拼接，且不会丢掉原有参数', () => {
  const { url } = buildShareUrl(PRESET_DISHES, 'https://example.com/a?from=wechat')
  assert.ok(url.includes('from=wechat'))
  assert.ok(url.includes('&m='))
  assert.deepEqual(readShareFromLocation(url), PRESET_DISHES)
})
