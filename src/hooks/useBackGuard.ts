import { useEffect, useRef } from 'react'

/**
 * 拦截「返回手势 / 安卓返回键」，交给调用方决定要不要真的关。
 *
 * 背景：全屏编辑页是浮层不是路由，用户按返回键时浏览器会直接退出应用，
 * 而不是关掉浮层 —— 编辑到一半的内容就这么没了。
 *
 * 做法：浮层挂载时往历史里压一条记录，返回键先弹掉它并触发 popstate；
 *   - 调用方说「可以关」→ 浮层卸载，历史已经是干净的；
 *   - 调用方说「别关」（比如用户在确认框里点了继续编辑）→ 再压一条回去。
 * 浮层正常关闭（保存/取消）时，卸载回调会把压进去的那条弹掉，
 * 免得历史里堆一串空记录、用户要按好几次返回才能退出。
 */
export function useBackGuard(
  /** 返回 true 表示已处理完、可以关闭；false 表示要保持打开 */
  onBack: () => boolean | Promise<boolean>,
) {
  const pushedRef = useRef(false)
  const handlerRef = useRef(onBack)
  handlerRef.current = onBack

  useEffect(() => {
    try {
      history.pushState({ fmOverlay: true }, '')
      pushedRef.current = true
    } catch {
      // file:// 下个别浏览器不让 pushState，那就不拦了，功能照常
      pushedRef.current = false
      return
    }

    return () => {
      if (!pushedRef.current) return
      pushedRef.current = false
      try {
        history.back()
      } catch {
        /* ignore */
      }
    }
  }, [])

  useEffect(() => {
    const onPop = () => {
      // 我们自己调的 history.back()（卸载清理）会走到这里，直接放行
      if (!pushedRef.current) return
      pushedRef.current = false

      void Promise.resolve(handlerRef.current()).then((closed) => {
        if (closed) return
        // 用户选择继续编辑：把历史补回去，下次返回键还能再拦一次
        try {
          history.pushState({ fmOverlay: true }, '')
          pushedRef.current = true
        } catch {
          /* ignore */
        }
      })
    }

    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
}
