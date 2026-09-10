/**
 * 设置页里的「跨设备同步」那一块。
 *
 * 两种样子：没配的时候只有一个「开启」按钮；配了之后显示状态、上次同步时间
 * 和一个「立即同步」。表单用的是本应用已有的 .field / .input / .btn 样式，
 * 不新造视觉。
 *
 * 【为什么填地址和口令这个表单比别的表单啰嗦】
 * 这两项填错了不会报错，只会「同步看起来成功了但两台设备对不上」。
 * 所以保存之前先把地址格式、口令一致性检查一遍，能提前拦掉的就别让用户去猜。
 */

import { useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { CIcon } from './icons'
import {
  applySyncConfig,
  syncNow,
  useSyncStatus,
  type SyncStatus,
} from '../sync/client'
import { checkUrl, normalizeUrl, readSyncConfig } from '../sync/config'
import { toast } from '../store/toast'

/** 中文的相对时间。同步状态里「上次同步」用得着，不必精确到秒。 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86400_000)} 天前`
}

function statusText(status: SyncStatus): { text: string; danger: boolean } {
  switch (status.phase) {
    case 'syncing':
      return { text: '正在同步…', danger: false }
    case 'error':
      return { text: status.message ?? '同步失败', danger: true }
    case 'idle':
      return status.lastSyncAt
        ? { text: `上次同步：${relativeTime(status.lastSyncAt)}`, danger: false }
        : { text: '还没同步过', danger: false }
    default:
      return { text: '未开启', danger: false }
  }
}

interface FormState {
  url: string
  pass: string
  /** 第二个输入框，只用来防止打错字 —— 一个打错的字母会让两台设备怎么都合不上 */
  pass2: string
}

function SyncForm({ initial, onDone }: { initial: FormState; onDone: () => void }) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  const submit = async () => {
    const urlError = checkUrl(form.url)
    if (urlError) {
      toast(urlError, { duration: 4000 })
      return
    }
    const pass = form.pass.trim()
    if (!pass) {
      toast('请填写家族口令')
      return
    }
    if (pass !== form.pass2.trim()) {
      toast('两次填的口令不一样，再对一下')
      return
    }

    setSaving(true)
    try {
      applySyncConfig({ url: normalizeUrl(form.url), pass })
      onDone()
      // 不在这里等同步结果：网络可能要几秒，状态显示在设置页那一行上，
      // 成功失败都看得见。卡在按钮上转圈反而不知道发生了什么。
      void syncNow('开启同步')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="sync-url">
          云函数地址
        </label>
        <input
          id="sync-url"
          className="input"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://xxxx.ap-shanghai.app.tcloudbase.com/sync"
          value={form.url}
          onChange={(e) => set({ url: e.target.value })}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="sync-pass">
          家族口令
        </label>
        <input
          id="sync-pass"
          className="input"
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={form.pass}
          onChange={(e) => set({ pass: e.target.value })}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="sync-pass2">
          再填一遍
        </label>
        <input
          id="sync-pass2"
          className="input"
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={form.pass2}
          onChange={(e) => set({ pass2: e.target.value })}
        />
      </div>

      <div className="notice notice-info">
        <span aria-hidden="true">🔑</span>
        <div>
          每台设备都要填一次，<strong>地址和口令必须完全一样</strong>，否则会各存各的。
          口令只存在这台设备的浏览器里，不会上传，也不会写进网页代码。
        </div>
      </div>

      {/* 抽屉本身底部已经有一个「取消」了，这里不再重复放一个 */}
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={saving}
        onClick={() => void submit()}
      >
        {saving ? '保存中…' : '保存并同步'}
      </button>
    </>
  )
}

export function SyncSettings() {
  const status = useSyncStatus()
  const [open, setOpen] = useState(false)

  const config = readSyncConfig()
  const configured = config !== null
  const { text, danger } = statusText(status)

  const disableSync = () => {
    setOpen(false)
    applySyncConfig(null)
    toast('已关闭同步，两台设备不再互相同步')
  }

  return (
    <>
      {configured ? (
        <>
          <div className="setting-item" style={{ cursor: 'default' }}>
            <span className="icon" aria-hidden="true">
              ☁️
            </span>
            <span className="text">
              跨设备同步
              <span className="sub" style={danger ? { color: 'var(--red)' } : undefined}>
                {text}
              </span>
            </span>
          </div>

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={status.phase === 'syncing'}
              onClick={() => void syncNow('手动')}
            >
              {status.phase === 'syncing' ? '同步中…' : '立即同步'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
              修改
            </button>
          </div>

          <p className="subtitle" style={{ marginTop: 0 }}>
            菜名、分类、用料、备注和菜单都会在设备之间同步。照片太大，暂时各存各的。
          </p>

          <button type="button" className="setting-item danger" onClick={disableSync}>
            <span className="icon" aria-hidden="true">
              <CIcon name="broom" size={22} />
            </span>
            <span className="text">
              关闭同步
              <span className="sub">本机的菜谱都会留着，只是不再和别的设备互相同步</span>
            </span>
          </button>
        </>
      ) : (
        <button type="button" className="setting-item" onClick={() => setOpen(true)}>
          <span className="icon" aria-hidden="true">
            ☁️
          </span>
          <span className="text">
            开启跨设备同步
            <span className="sub">手机和平板互相跟过去，不用再导出导入</span>
          </span>
        </button>
      )}

      <BottomSheet
        open={open}
        title={configured ? '修改同步设置' : '开启跨设备同步'}
        onClose={() => setOpen(false)}
      >
        {/* 抽屉关着时 BottomSheet 直接返回 null，所以每次打开都会重新挂载，
            表单里的初始值就是刚从 localStorage 读出来的最新值 */}
        <SyncForm
          initial={{ url: config?.url ?? '', pass: config?.pass ?? '', pass2: config?.pass ?? '' }}
          onDone={() => setOpen(false)}
        />
      </BottomSheet>
    </>
  )
}
