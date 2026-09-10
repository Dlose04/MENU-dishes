import { useEffect, useState } from 'react'

export interface ViewportMetrics {
  /** 可视区域高度（键盘弹出后会变小） */
  height: number
  /** 可视区域相对布局视口的上偏移（iOS 键盘弹起时页面整体被顶上去的量） */
  offsetTop: number
  /** 键盘是否挡住了底部 */
  keyboardOpen: boolean
}

const fallback = (): ViewportMetrics => ({
  height: window.innerHeight,
  offsetTop: 0,
  keyboardOpen: false,
})

/**
 * 监听 visualViewport。
 *
 * 手机上键盘弹起时 window.innerHeight 基本不变（iOS 更是完全不变），
 * 直接拿它当弹层高度，底部输入框就会被键盘盖住。
 * 只有 visualViewport.height 会真实反映「现在还剩多少地方能看见」。
 */
export function useVisualViewport(active = true): ViewportMetrics {
  const [metrics, setMetrics] = useState<ViewportMetrics>(fallback)

  useEffect(() => {
    if (!active) return
    const vv = window.visualViewport
    if (!vv) return

    const update = () => {
      // 键盘占据的高度超过一个经验阈值才算「弹出」，
      // 否则地址栏收起/展开造成的几十像素变化会误判。
      const hidden = window.innerHeight - vv.height - vv.offsetTop
      setMetrics({
        height: vv.height,
        offsetTop: vv.offsetTop,
        keyboardOpen: hidden > 120,
      })
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    // 旋转屏幕时 visualViewport 不一定触发 resize
    window.addEventListener('orientationchange', update)

    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [active])

  return metrics
}
