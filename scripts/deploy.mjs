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
run('npm', ['run', 'build'], ROOT)
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
