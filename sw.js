// App 外殼的離線快取。只處理同源的 App 檔案；googleapis 與其他網域一律放行不攔。
// 影片快取（class-videos-*）由 app.js 自己管，這裡不碰、清舊版時也不刪。
// 部署新版時把 VERSION 改掉，iPad 下次開啟會換新外殼。
const VERSION = 'shell-2026-11-19d';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'player.js', 'config.js',
  'manifest.webmanifest', 'data/catalog.json',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k.startsWith('shell-') && k !== VERSION).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // googleapis 等外部請求不攔
  if (!url.pathname.startsWith(new URL('./', self.location).pathname)) return;
  // 有網路就拿最新版（跳過瀏覽器 HTTP 快取），沒網路才用存起來的外殼
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    try {
      const r = await fetch(req, { cache: 'no-cache' });
      if (r.ok && r.type === 'basic') cache.put(key, r.clone());
      return r;
    } catch (err) {
      const hit = await cache.match(key, { ignoreSearch: true });
      return hit || new Response('離線中，這個檔案還沒存過。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
