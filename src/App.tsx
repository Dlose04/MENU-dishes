import { useEffect, useState } from 'react'
import type { ShareDish } from './types'
import { TabBar, type TabKey } from './components/TabBar'
import { BookCover } from './components/BookCover'
import { Footer } from './components/Footer'
import { ToastHost } from './components/ToastHost'
import { ConfirmHost } from './components/ConfirmHost'
import { LibraryPage } from './pages/LibraryPage'
import { RandomPage } from './pages/RandomPage'
import { TodayPage } from './pages/TodayPage'
import { SettingsPage } from './pages/SettingsPage'
import { SharePreviewPage } from './pages/SharePreviewPage'
import { initStore, useAppState } from './store/appStore'
import { startSync } from './sync/client'
import { clearShareFromUrl, readShareFromLocation } from './lib/share'

export function App() {
  const { ready } = useAppState()

  // 分享链接只在启动时读一次：读到就直接进预览页，
  // 之后用户在应用里怎么点都不该再被它影响。
  const [shared, setShared] = useState<ShareDish[] | null>(() => readShareFromLocation())
  const [tab, setTab] = useState<TabKey>('library')
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    // 同步必须等 store 初始化完再启动：它第一件事就是读本地数据去合并，
    // 早于 initStore 启动会读到空库，把「空」推到云端去。
    void initStore().then(() => startSync())
  }, [])

  if (!ready) {
    return (
      <>
        <div className="paper-bg" aria-hidden="true" />
        <div id="boot">正在翻开手账…</div>
      </>
    )
  }

  return (
    <>
      <div className="paper-bg" aria-hidden="true" />

      {shared ? (
        <div className="app">
          <div className="wrap">
            <SharePreviewPage
              dishes={shared}
              onExit={(nextTab) => {
                setShared(null)
                // 预览完把 ?m= 从地址栏摘掉：刷新不会再进预览，
                // 用户想收藏这个页面也不会收藏成一个「别人的菜单」
                clearShareFromUrl()
                if (nextTab) setTab(nextTab)
              }}
            />
          </div>
        </div>
      ) : (
        <div className="app">
          <div className="wrap">
            <BookCover />
            {/* 手机上是贴底的固定栏，桌面上变成封面下面的一排书签。
                一个 nav 靠 media query 切换，不渲染两份。 */}
            <TabBar tab={tab} onChange={setTab} />

            <main className="book">
              {tab === 'library' && <LibraryPage />}
              {tab === 'today' && <TodayPage />}
              {tab === 'random' && <RandomPage />}
            </main>

            <Footer onOpenSettings={() => setSettingsOpen(true)} />
          </div>
        </div>
      )}

      {/* 设置是浮层不是页签，条件渲染 —— 常驻挂载会让 useBackGuard
          往历史里堆一串记录，返回键要按很多次才能退出应用 */}
      {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}

      <ToastHost />
      <ConfirmHost />
    </>
  )
}
