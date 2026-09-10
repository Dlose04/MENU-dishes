/**
 * 发布到 GitHub Pages。
 *
 * 做法：重新构建 → 把 dist/ 的内容拷到一个临时目录 → 在那里 git init 提交 →
 * 强制推到远端仓库的 gh-pages 分支。
 *
 * 为什么不在主仓库里 `git subtree push`：那样得先把 dist 提交进 main，
 * 每发一次版就往源码历史里塞一堆构建产物，翻 log 很难看。用临时目录
 * 推出去，main 上永远只有源码。
 *
 * 用法：npm run deploy
 * 远端地址取自当前仓库的 origin，所以先把仓库建好、origin 配上再跑。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const STAGE = path.join(ROOT, '.deploy-tmp')
const BRANCH = 'gh-pages'

/** 跑一条命令，返回 stdout；失败时把 stderr 一起抛出来 */
function run(cmd, args, cwd = ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 跑构建。
 *
 * 为什么不直接 spawn('npm', ...)：Windows 上的 npm 是 npm.cmd，而 Node 20 起
 * 出于安全（CVE-2024-27980）拒绝直接 spawn .cmd/.bat，会抛 EINVAL；
 * 加 shell: true 又能绕过，但那样参数要拼成一条字符串交给 cmd.exe，
 * 而这台机器的用户目录里有空格，拼接就会踩坑。
 *
 * 所以走 npm 自己的 JS 入口：`npm run xxx` 会把 npm-cli.js 的路径放进
 * npm_execpath，用 node 直接执行它，既不碰 .cmd 也不用 shell。
 */
function build() {
  const npmCli = process.env.npm_execpath
  if (!npmCli) {
    // 直接 `node scripts/deploy.mjs` 跑的时候没有这个变量，那就用现成的产物
    if (fs.existsSync(path.join(DIST, 'index.html'))) {
      console.log('▸ 跳过构建（直接用现有的 dist/）')
      return
    }
    console.error('没有 dist/ 可发。先跑一次 npm run build，或者用 npm run deploy。')
    process.exit(1)
  }
  run(process.execPath, [npmCli, 'run', 'build'], ROOT)
}

function remoteUrl() {
  try {
    return run('git', ['remote', 'get-url', 'origin']).trim()
  } catch {
    console.error(
      '\n找不到 origin 远端。先在项目目录里执行：\n' +
        '  git remote add origin https://github.com/<用户名>/<仓库名>.git\n',
    )
    process.exit(1)
  }
}

// ---- 1. 构建 ----
console.log('▸ 构建…')
build()
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('构建产物里没有 dist/index.html，构建可能失败了')
  process.exit(1)
}

const origin = remoteUrl()

// ---- 2. 把 dist 拷到临时目录，在那儿单独成一个仓库 ----
// 嵌套的 .git 会让外层的仓库命令走进内层，所以每一条 git 命令都显式指定 cwd。
console.log('▸ 准备 gh-pages 内容…')
fs.rmSync(STAGE, { recursive: true, force: true })
fs.cpSync(DIST, STAGE, { recursive: true })

// Pages 默认会对下划线开头的文件做 Jekyll 处理，关掉免得静态资源被吞
fs.writeFileSync(path.join(STAGE, '.nojekyll'), '')

run('git', ['init', '-q', '-b', BRANCH], STAGE)
run('git', ['add', '-A'], STAGE)
run(
  'git',
  [
    '-c',
    'user.name=deploy',
    '-c',
    'user.email=deploy@localhost',
    'commit',
    '-qm',
    `deploy ${new Date().toISOString()}`,
  ],
  STAGE,
)

// ---- 3. 推上去 ----
console.log(`▸ 推送到 ${origin} 的 ${BRANCH} 分支…`)
run('git', ['push', '-f', origin, `HEAD:${BRANCH}`], STAGE)

fs.rmSync(STAGE, { recursive: true, force: true })
console.log('\n✓ 发布完成。')
console.log('  首次发布还需要在仓库的 Settings → Pages 里，把 Source 选成 gh-pages 分支。')
