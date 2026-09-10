#!/usr/bin/env node
/**
 * 设置家族口令。
 *
 * 用法：在这个目录下 `node setup.mjs`，按提示输入一遍（终端里输入时不显示）。
 *
 * 【为什么不直接把口令写在代码或配置里】
 * 这个云函数是公开托管的，函数配置在控制台、截图、导出里都可能被别人看到。
 * 存明文口令等于把那句话直接摊开，谁看见谁就能改你家的菜谱。
 * 所以这里只把 **sha256** 写进 cloud/sync/.env，函数比对的是哈希。
 *
 * 【.env 绝对不会进仓库】
 * 仓库是公开的。就算只是哈希，公开出去也等于给了想爆破的人一个可以离线
 * 慢慢试的靶子（家庭口令通常很短，字典跑一遍很快）。.gitignore 里已经挡了，
 * 这个脚本也会在写完之后再提醒一次。
 *
 * 【为什么要输两遍】
 * 口令只存哈希，是**不可逆**的：存进去之后就没办法从 .env 反推出原文，
 * 打错一个字符，下次同步只会得到 401，而且你无从对照。所以输两遍对一下。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = join(HERE, '.env')
const KEY = 'MENU_PASS_SHA256'
const MIN_LEN = 4

/* 控制字符写成常量，不直接在源码里嵌转义序列 —— 那些字符在编辑器、
   在复制粘贴、在终端之间转一圈很容易变形，变成肉眼看不出的错。 */
const CTRL_C = String.fromCharCode(3)
const CTRL_D = String.fromCharCode(4)
const BACKSPACE = String.fromCharCode(127)
const BACKSPACE_ALT = String.fromCharCode(8)

/* ------------------------------------------------------------------ */
/* 输入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 终端里不显示地把一行读进来。
 *
 * 为什么不回显星号：中文、emoji 都是双宽字符，退格时擦不干净，
 * 会在屏幕上留一串残影，看起来像坏了。索性什么都不显示，在提示里说清楚。
 */
function askHiddenTty(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let buf = ''
    let done = false

    const finish = (value) => {
      if (done) return
      done = true
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      resolve(value)
    }

    const onData = (chunk) => {
      // 一次 data 事件可能送来好几个字符（粘贴、或者输入很快），
      // 所以按**码点**逐个处理，不能把整个 chunk 当成一个字符。
      for (const ch of chunk) {
        if (done) return
        if (ch === '\r' || ch === '\n' || ch === CTRL_D) return finish(buf)
        if (ch === CTRL_C) {
          // Ctrl+C：raw 模式下它不会自己变成 SIGINT，得手动收尾再退
          stdin.setRawMode(false)
          process.stdout.write('\n已取消\n')
          process.exit(130)
        }
        if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
          buf = buf.slice(0, -1)
          continue
        }
        if (ch >= ' ') buf += ch
      }
    }

    stdin.on('data', onData)
  })
}

/**
 * 不是终端时（管道、重定向）的输入。
 *
 * 【为什么是「先把 stdin 全部读完」而不是逐行提问】
 * 一开始写的是「每次提问新建一个 readline」，结果是：管道里两行几乎是同时到达的，
 * 第一行被第一个 readline 收下，第二行在第二次提问**之前**就已经从流里过去了，
 * 于是第二个回调永远不触发 —— 进程无事可做，静默退出，exit code 还是 0。
 * 看起来一切正常，文件却一个字没写。这种「成功了个寂寞」最难查。
 *
 * 所以这里先一次性把输入收进数组，提问从数组里取 —— 顺序完全确定，没有竞态。
 * 另外这条路本来就不隐藏输入，那就把取到的值回显出来，让人能看清喂进去的是什么。
 */
function makePipeAsker() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      raw += chunk
    })
    process.stdin.on('end', () => {
      const lines = raw.split(/\r?\n/)
      let i = 0
      resolve((question) => {
        process.stdout.write(question)
        const value = i < lines.length ? lines[i++] : ''
        process.stdout.write(`${value}\n`)
        return Promise.resolve(value)
      })
    })
    process.stdin.resume()
  })
}

/** 按当前环境挑一条输入通道。 */
async function makeAsker() {
  const stdin = process.stdin
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    return askHiddenTty
  }
  process.stdout.write('⚠️  当前不是交互终端，口令会显示在屏幕上\n')
  return makePipeAsker()
}

/* ------------------------------------------------------------------ */
/* 写文件                                                              */
/* ------------------------------------------------------------------ */

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function writeEnv(hash) {
  // 保留文件里别的行，只替换/追加这一个键 —— 免得以后加了别的变量被这个脚本抹掉
  const lines = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
    : []
  let replaced = false
  const out = lines
    .filter((line, i) => !(i === lines.length - 1 && line === '')) // 去掉尾部空行，下面统一补
    .map((line) => {
      if (line.startsWith(`${KEY}=`)) {
        replaced = true
        return `${KEY}=${hash}`
      }
      return line
    })
  if (!replaced) out.push(`${KEY}=${hash}`)
  writeFileSync(ENV_PATH, out.join('\n') + '\n', 'utf8')
  return replaced
}

/* ------------------------------------------------------------------ */

async function main() {
  const ask = await makeAsker()

  console.log('设置家族口令')
  console.log('─'.repeat(46))
  console.log('这句话要发给家里每个人，每台设备都用同一句。')
  console.log(`建议 ${MIN_LEN} 位以上，好记比复杂重要 —— 反正每台设备只输一次。`)
  console.log()

  const first = await ask('请输入口令（输完按回车）: ')
  if (!first) {
    console.log('没有输入内容，已取消。')
    process.exit(1)
  }
  if (first.length < MIN_LEN) {
    console.log(`口令太短了（至少 ${MIN_LEN} 位）。`)
    process.exit(1)
  }

  const second = await ask('再输一遍确认: ')
  if (first !== second) {
    console.log('两次输入不一样，已取消。重新跑一遍吧。')
    process.exit(1)
  }

  const hash = sha256Hex(first)
  const replaced = writeEnv(hash)

  console.log()
  console.log(`已写入 ${ENV_PATH}${replaced ? '（替换了原来的值）' : '（新建）'}`)
  console.log()
  console.log(`  ${KEY}=${hash}`)
  console.log()
  console.log('⚠️  这个文件不会进仓库（.gitignore 已挡），也别截图发人 ——')
  console.log('    口令本身要发给家人，但**哈希**只留在这台电脑上。')
  console.log()
  console.log('下一步：重新部署云函数，让新的哈希生效：')
  console.log()
  // 不能用 `-e <环境id>`：那条路不带 -r 时会报「env not found」，
  // 而环境明明是好的。环境 id 和地域已经在 cloudbaserc.json 里钉住了，
  // 直接读配置文件最稳。--force 是必须的，否则会停下来问「是否覆盖」。
  console.log('  cd E:/family-menu/cloud/sync')
  console.log('  tcb fn deploy sync --force')
  console.log()
  console.log('部署完之后，旧口令立刻失效（包括之前测试用的那串）。')
}

main().catch((err) => {
  console.error('出错了：', err)
  process.exit(1)
})
