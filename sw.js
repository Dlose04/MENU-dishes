/* 家庭点菜手账 —— 极简 Service Worker
 *
 * 作用：静态托管（GitHub Pages / Vercel / 自己的服务器）下支持真正断网可用。
 * 说明：应用本身是单文件 index.html，没有任何外部依赖，所以这里只需要
 *       「导航请求优先走缓存，缓存没有再走网络」这一条策略就够了。
 *
 * file:// 双击打开时不会注册 SW（浏览器不允许），但那种场景本来就不需要，
 * 因为整个应用就在本地磁盘上。
 */

// 缓存名带构建哈希，由 vite.config.ts 的 stampServiceWorker() 在每次构建时
// 写成 index.html 的内容摘要。**别手改这里** —— 改了也会被构建覆盖。
//
// 为什么必须让它每次都变：导航请求走的是「缓存优先」，只要 sw.js 本身字节
// 没变，浏览器就不会重装 SW，activate 也就不会跑，旧的 index.html 会永远
// 躺在缓存里 —— 发多少次版，装过应用的人都看不到。缓存名一变，
// install/activate 就会重跑并把旧缓存删掉。
const CACHE = 'family-menu-af6160091d'
// 首次安装时预缓存的应用外壳。用相对路径，兼容部署在子目录的情况。
const SHELL = ['./', './index.html']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 单个资源失败（比如没有 icon-180.png）不应该让整个安装失败
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // 导航请求：先缓存（保证断网秒开），缓存没有再走网络并回填
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put('./index.html', copy))
              return res
            })
            .catch(() => caches.match('./')),
      ),
    )
    return
  }

  // 其他同源静态资源：缓存优先 + 后台回填
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => hit)
    }),
  )
})
