import { useState } from 'react'
import { CIcon } from '../components/icons'
import { BottomSheet } from '../components/BottomSheet'
import { SyncSettings } from '../components/SyncSettings'
import { useVisualViewport } from '../hooks/useVisualViewport'
import { useBackGuard } from '../hooks/useBackGuard'
import {
  clearAllData,
  exportLibrary,
  importLibrary,
  reseedPresets,
  useAppState,
} from '../store/appStore'
import { confirmDialog } from '../store/confirm'
import { toast } from '../store/toast'
import { downloadBlob, pickFile } from '../lib/io'
import { parseBackup } from '../lib/backup'
import { formatBytes } from '../lib/image'

/**
 * 设置。全屏浮层，骨架和菜谱详情一致（.editor / .editor-bar / .editor-body），
 * 由页脚的 ⚙️ 打开。移动端键盘弹起时靠 visualViewport 给的高度不挡住内容。
 */
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const { recipes, menus, mode, warning } = useAppState()
  const [aboutOpen, setAboutOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const vp = useVisualViewport(true)

  // 返回键：先关「关于」抽屉；正在导出/导入/清空时把返回吞掉 ——
  // 那几步都挂在 await confirmDialog 上，这时候把浮层关了，
  // Promise resolve 之后用户会看到凭空的「已清空」，或者下载突然开始。
  useBackGuard(() => {
    if (aboutOpen) {
      setAboutOpen(false)
      return false
    }
    if (busy) return false
    onClose()
    return true
  })

  const imageCount = recipes.filter((r) => r.imageBlob).length

  /* ---------------- 导出 ---------------- */

  const doExport = async () => {
    setBusy(true)
    try {
      const result = await exportLibrary()
      if (!result) return

      // 图片转成 base64 之后会膨胀约 1/3，文件可能很大，先跟用户说清楚
      if (result.bytes > 1024 * 1024) {
        const ok = await confirmDialog({
          title: '备份文件有点大',
          message:
            `一共 ${recipes.length} 道菜、${result.imageCount} 张图片，` +
            `文件大约 ${formatBytes(result.bytes)}。生成和传输都会慢一些，继续吗？`,
          confirmText: '下载',
        })
        if (!ok) return
      }

      downloadBlob(
        new Blob([result.text], { type: 'application/json' }),
        result.filename,
      )
      toast(`已导出 ${recipes.length} 道菜（含 ${result.imageCount} 张图片）`)
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 导入 ---------------- */

  const doImport = async () => {
    setBusy(true)
    try {
      const file = await pickFile('application/json,.json')
      if (!file) return

      const text = await file.text()

      // 先解析一遍，把「要导入什么」摆给用户看，再决定要不要合并
      let parsed
      try {
        parsed = parseBackup(text)
      } catch (err) {
        toast(err instanceof Error ? err.message : '这个文件读不了', { duration: 5000 })
        return
      }

      const ok = await confirmDialog({
        title: '导入菜谱库？',
        message:
          `文件里有 ${parsed.recipes.length} 道菜` +
          (parsed.menus.length ? `、${parsed.menus.length} 天的菜单` : '') +
          '。会和现有菜谱合并：同一条（id 相同）会跳过，不会覆盖你本地的版本；' +
          '本机没有照片而备份里有的话，会把照片补上。',
        confirmText: '导入',
      })
      if (!ok) return

      const res = await importLibrary(text)
      if (!res) return

      const parts = [`新增 ${res.added} 道`]
      // 补图单独说一句：这是「照片跟着菜到别的设备」唯一走得通的路
      // （同步不搬图片），只说「跳过 N 道已存在」的话，用户会以为
      // 备份里那些照片压根没被用上
      if (res.photoFilled) parts.push(`补回 ${res.photoFilled} 张照片`)
      if (res.skippedExisting) parts.push(`跳过 ${res.skippedExisting} 道已存在`)
      if (res.invalid) parts.push(`${res.invalid} 条格式不对已忽略`)
      if (res.menusMerged) parts.push(`合并 ${res.menusMerged} 天菜单`)
      toast(`导入完成：${parts.join('，')}`, { duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 清空 ---------------- */

  const doClear = async () => {
    const ok = await confirmDialog({
      title: '清空所有数据？',
      message:
        `会删掉全部 ${recipes.length} 道菜谱、图片和菜单记录，且无法撤销。\n` +
        '建议先导出一份备份。',
      confirmText: '全部清空',
      danger: true,
    })
    if (!ok) return

    // 破坏性操作问两次，第二次不再给「顺手点掉」的机会
    const sure = await confirmDialog({
      title: '真的确定吗？',
      message: '这是最后一次确认，清空之后就找不回来了。',
      confirmText: '确定清空',
      danger: true,
    })
    if (!sure) return

    await clearAllData()
    toast('已清空')
  }

  return (
    <>
      <div
        className="editor"
        style={{ top: vp.offsetTop, height: vp.height, bottom: 'auto' }}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <div className="editor-bar editor-bar-top-safe">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            返回
          </button>
          <div className="editor-bar-title">设置</div>
          {/* 占位，让标题真正居中（左边有一个「返回」） */}
          <span style={{ minWidth: 64 }} aria-hidden="true" />
        </div>

        <div className="editor-body">
          {warning && (
          <div className="notice notice-danger">
            <span aria-hidden="true">⚠️</span>
            <div>{warning}</div>
          </div>
        )}

        <h3 className="section-title">跨设备同步</h3>
        <p className="subtitle" style={{ marginTop: -4, marginBottom: 12 }}>
          菜谱默认只存在这台设备上。手机和平板想互相跟过去，就在这里开一次；
          不想开也行，用下面两个按钮手动搬。
        </p>

        <SyncSettings />

        <h3 className="section-title">手动备份</h3>
        <p className="subtitle" style={{ marginTop: -4, marginBottom: 12 }}>
          一个 JSON 文件，图片也在里面。存到网盘就是一份离线备份。
        </p>

        <button type="button" className="setting-item" disabled={busy} onClick={() => void doExport()}>
          <span className="icon" aria-hidden="true">
            <CIcon name="download" size={22} />
          </span>
          <span className="text">
            导出菜谱库
            <span className="sub">生成一个 JSON 文件，图片也会一起打包</span>
          </span>
        </button>

        <button type="button" className="setting-item" disabled={busy} onClick={() => void doImport()}>
          <span className="icon" aria-hidden="true">
            <CIcon name="upload" size={22} />
          </span>
          <span className="text">
            导入菜谱库
            <span className="sub">按 id 去重合并，已存在的不覆盖</span>
          </span>
        </button>

        <h3 className="section-title">数据</h3>

        <div className="card card-warm">
          <p style={{ margin: 0, lineHeight: 2 }}>
            <strong>{recipes.length}</strong> 道菜谱
            {imageCount > 0 && <>（{imageCount} 张带图）</>}
            <br />
            <strong>{menus.filter((m) => m.items.length).length}</strong> 天菜单记录
            <br />
            存储方式：
            <strong>{mode === 'indexeddb' ? 'IndexedDB（正常）' : 'localStorage（降级）'}</strong>
          </p>
        </div>

        <button
          type="button"
          className="setting-item"
          disabled={busy}
          onClick={async () => {
            const ok = await confirmDialog({
              title: '重新载入预置菜谱？',
              message: '会把家里那 9 道菜补回来（带照片），已经存在的同名菜不会动。',
              confirmText: '载入',
            })
            if (!ok) return
            const { added, photoFilled } = await reseedPresets()
            if (!added && !photoFilled) {
              toast('预置菜都在了，没有需要补的')
              return
            }
            const parts: string[] = []
            if (added) parts.push(`补了 ${added} 道菜`)
            if (photoFilled) parts.push(`给 ${photoFilled} 道菜配上了照片`)
            toast(parts.join('，'))
          }}
        >
          <span className="icon" aria-hidden="true">
            <CIcon name="seed" size={22} />
          </span>
          <span className="text">
            重新载入预置菜谱
            <span className="sub">把家里那 9 道菜补回来（带照片）</span>
          </span>
        </button>

        <button type="button" className="setting-item danger" disabled={busy} onClick={() => void doClear()}>
          <span className="icon" aria-hidden="true">
            <CIcon name="broom" size={22} />
          </span>
          <span className="text">
            清空所有数据
            <span className="sub">菜谱、图片、菜单全部删除，不可撤销</span>
          </span>
        </button>

          <h3 className="section-title">关于</h3>
          <button type="button" className="setting-item" onClick={() => setAboutOpen(true)}>
            <span className="icon" aria-hidden="true">
              <CIcon name="info" size={22} />
            </span>
            <span className="text">
              关于这个手账
              <span className="sub">离线能用吗？数据在哪？怎么分享？</span>
            </span>
          </button>
        </div>
      </div>

      <BottomSheet open={aboutOpen} title="关于" onClose={() => setAboutOpen(false)}>
        <div style={{ lineHeight: 1.9, fontSize: 15 }}>
          <p style={{ marginTop: 0 }}>
            <strong>小雨点菜手账</strong>
            <br />
            一个纯前端的小应用：没有账号、不注册、不联网也完全能用。
            网页本身就是一个 HTML 文件，所有东西都在你的手机上。
          </p>

          <p>
            <strong>数据存在哪？</strong>
            <br />
            菜谱和图片存在浏览器的 IndexedDB 里，设置存在 localStorage。
            所以：清浏览器数据、换手机、换浏览器，数据都不会自己跟过去 ——
            可以用上面的「跨设备同步」，也可以用「导出 / 导入」手动搬，
            或者把导出的 JSON 存到网盘当一份离线备份。
          </p>

          <p>
            <strong>为什么过一阵子要重新填一次同步口令？</strong>
            <br />
            不是应用在丢数据，是<strong>浏览器自己把本站的本地数据清掉了</strong>。
            两种情况最常见：
            <br />
            ① <strong>无痕 / 隐私窗口</strong> —— 窗口一关，菜谱、菜单、口令全部清空；
            <br />
            ② <strong>iPhone 的 Safari</strong> —— 连续 7 天没打开过这个网站，会清掉它的全部本地数据
            （存菜谱的 IndexedDB 和存口令的 localStorage 是一起清的）。
            <br />
            云端那份一直都在，重新填一次口令就全回来了。想彻底避免：
            <strong>别用无痕窗口</strong>，并在 Safari 里「添加到主屏幕」，以后从主屏幕图标进 ——
            iOS 对「添加到主屏幕」的网站在存储清理上会放宽。
          </p>

          <p>
            <strong>「跨设备同步」用的服务器是谁的？</strong>
            <br />
            是家里自己的一个云函数（腾讯云开发，免费额度内），只做三件事：
            核对口令、存一份数据、比对版本号。口令只存在每台设备的浏览器里，
            既不上传也不写进网页代码 —— 页面是公开托管的，写进去就等于公开。
            合并两家设备的改动是在各自手机上算的，服务器不参与。
          </p>

          <p>
            <strong>同步为什么没有照片？</strong>
            <br />
            一张照片压缩后也有几十 KB，每次同步都搬一遍太浪费。
            照片留在拍它的那台设备上，菜名、用料、分类、备注和菜单会同步。
          </p>

          <p>
            <strong>分享链接为什么没有图片？</strong>
            <br />
            图片转成文字塞进网址会变得极长，微信、QQ 会把链接截断，对方就打不开了。
            所以链接里只带菜名、分类和 emoji，对方打开后看到的是菜单清单。
          </p>

          <p>
            <strong>添加到主屏幕</strong>
            <br />
            iPhone：用 Safari 打开 → 分享按钮 → 「添加到主屏幕」。
            <br />
            安卓：用 Chrome 打开 → 右上角菜单 → 「添加到主屏幕」。
            加完之后就是一个全屏的应用，没有地址栏。
          </p>

          <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginBottom: 0 }}>
            压缩算法 lz-string 由 Pieroxy 开发（MIT / WTFPL），源码已内联进本项目。
          </p>
        </div>
      </BottomSheet>
    </>
  )
}
