import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, src } from './_bundle.mjs'

const { toDateKey, todayKey, fromDateKey, shiftDateKey, formatDateKey, describeDateKey } =
  await load(src('lib/date.ts'))

test('日期键一律走本地时区，凌晨也不会算成前一天', () => {
  // 这是整个日期模块存在的理由：东八区凌晨 0~8 点用 toISOString() 会得到昨天。
  // 构造本地时间的凌晨，断言拿到的是本地那一天。
  const early = new Date(2026, 8, 10, 0, 30, 0) // 2026-09-10 00:30 本地
  assert.equal(toDateKey(early), '2026-09-10')

  const justBeforeMidnight = new Date(2026, 8, 10, 23, 59, 59)
  assert.equal(toDateKey(justBeforeMidnight), '2026-09-10')
})

test('月份和日期补零，格式恒为 YYYY-MM-DD', () => {
  assert.equal(toDateKey(new Date(2026, 0, 1)), '2026-01-01')
  assert.equal(toDateKey(new Date(2026, 11, 31)), '2026-12-31')
  assert.equal(toDateKey(new Date(2026, 8, 9)), '2026-09-09')
  for (const d of [new Date(2026, 0, 5), new Date(2026, 10, 20), new Date(2026, 2, 3)]) {
    assert.match(toDateKey(d), /^\d{4}-\d{2}-\d{2}$/)
  }
})

test('todayKey 就是今天的本地日期', () => {
  assert.equal(todayKey(), toDateKey(new Date()))
})

test('fromDateKey 得到的是本地零点，不是 UTC 零点', () => {
  const d = fromDateKey('2026-09-10')
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 8)
  assert.equal(d.getDate(), 10)
  assert.equal(d.getHours(), 0)
  assert.equal(d.getMinutes(), 0)
})

test('日期键能原样往返', () => {
  for (const key of ['2026-01-01', '2026-02-28', '2026-12-31', '2024-02-29']) {
    assert.equal(toDateKey(fromDateKey(key)), key)
  }
})

test('跨月、跨年、闰年边界都算得对', () => {
  assert.equal(shiftDateKey('2026-01-31', 1), '2026-02-01')
  assert.equal(shiftDateKey('2026-03-01', -1), '2026-02-28')
  assert.equal(shiftDateKey('2026-12-31', 1), '2027-01-01')
  assert.equal(shiftDateKey('2027-01-01', -1), '2026-12-31')
  // 2024 是闰年，2 月有 29 号
  assert.equal(shiftDateKey('2024-02-28', 1), '2024-02-29')
  assert.equal(shiftDateKey('2024-02-29', 1), '2024-03-01')
  // 2026 不是
  assert.equal(shiftDateKey('2026-02-28', 1), '2026-03-01')
})

test('往前挪也能跨年，不会被算成负数', () => {
  assert.equal(shiftDateKey('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDateKey('2026-01-05', -10), '2025-12-26')
})

test('挪 0 天等于没挪', () => {
  assert.equal(shiftDateKey('2026-09-10', 0), '2026-09-10')
})

test('格式化成「9月10日 周三」，星期几是对的', () => {
  // 2026-09-10 是星期四
  assert.equal(formatDateKey('2026-09-10'), '9月10日 周四')
  assert.equal(formatDateKey('2026-01-01'), '1月1日 周四')
  // 月份和日不补零，读起来更自然
  assert.equal(formatDateKey('2026-12-05'), '12月5日 周六')
})

test('今天/昨天/明天，其余显示具体日期', () => {
  const today = todayKey()
  assert.equal(describeDateKey(today), '今天')
  assert.equal(describeDateKey(shiftDateKey(today, -1)), '昨天')
  assert.equal(describeDateKey(shiftDateKey(today, 1)), '明天')
  assert.equal(describeDateKey(shiftDateKey(today, -2)), formatDateKey(shiftDateKey(today, -2)))
  assert.equal(describeDateKey(shiftDateKey(today, 7)), formatDateKey(shiftDateKey(today, 7)))
})

test('昨天/明天是跨月跨年也算得对（相对今天算，不是硬编码）', () => {
  for (const offset of [-1, 1, -30, 30]) {
    const key = shiftDateKey(todayKey(), offset)
    const label = describeDateKey(key)
    assert.ok(!label.includes('Invalid'), `${key} 格式化坏了`)
    assert.match(label, /^(今天|昨天|明天|\d+月\d+日 周[日一二三四五六])$/)
  }
})
