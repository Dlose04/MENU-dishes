/* 家庭点菜手账 —— 极简 Service Worker
 *
 * 作用：静态托管（GitHub Pages / Vercel / 自己的服务器）下支持真正断网可用。
 * 说明：应用本身是单文件 index.html，没有任何外部依赖，所以这里只需要
 *       「导航请求优先走缓存，缓存没有再走网络」这一条策略就够了。
 *
 * file:// 双击打开时不会注册 SW（浏览器不允许），但那种场景本来就不需要，
 * 因为整个应用就在本地磁盘上。
 */

const CACHE = 'family-menu-v1'
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
