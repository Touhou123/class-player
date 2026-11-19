// Service worker 兩件事：
// 1. App 外殼的離線快取（網路優先，沒網路才用快取）。只處理同源的 App 檔案；googleapis 等外部請求一律放行不攔。
//    影片快取（class-videos-*）由 app.js 自己管，這裡不碰、清舊版時也不刪。
// 2. 影片串流代理：./stream/<fileId>?size=<bytes> → 帶 Authorization 與原本的 Range 轉發到 Drive alt=media，
//    把 206 原樣傳回。<video> 自己帶不了 Authorization，所以由這裡代理；同源網址也讓 canvas 不會被汙染。
//    /stream/ 的回應絕對不進外殼快取。
// 部署新版時把 VERSION 改掉，iPad 下次開啟會換新外殼。
const VERSION = 'shell-2026-11-19e-stream';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'player.js', 'config.js',
  'manifest.webmanifest', 'data/catalog.json',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const SCOPE_PATH = new URL('./', self.location).pathname;
const STREAM_PATH = SCOPE_PATH + 'stream/';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k.startsWith('shell-') && k !== VERSION).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

// ---------- 登入 token：記憶體＋IndexedDB 備份（SW 被系統關掉重啟後從 IndexedDB 取回） ----------
let AUTH = null;   // {token, exp, api}
const API_OK = a => a === 'https://www.googleapis.com' || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(a);
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sw-auth', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(v) {
  const db = await idb();
  await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, 'auth'); t.oncomplete = res; t.onerror = () => rej(t.error); });
  db.close();
}
async function idbGet() {
  const db = await idb();
  const v = await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get('auth'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close();
  return v || null;
}
async function getAuth() {
  if (!AUTH) { try { AUTH = await idbGet(); } catch (e) {} }
  return AUTH;
}
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'auth') return;
  const port = e.ports && e.ports[0];
  const done = ok => { try { port && port.postMessage({ ok }); } catch (x) {} };
  if (!d.token || !API_OK(d.api)) { done(false); return; }
  AUTH = { token: d.token, exp: d.exp, api: d.api };
  e.waitUntil(idbPut(AUTH).catch(() => {}).then(() => done(true)));
});

// ---------- 串流代理 ----------
const sizes = {};   // fileId -> 檔案總長（Drive 不對網頁公開 Content-Range，要自己算）
function parseRange(h) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((h || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  return { a: m[1] === '' ? null : +m[1], b: m[2] === '' ? null : +m[2] };
}
async function fileSize(api, id, token) {
  if (sizes[id]) return sizes[id];
  const r = await fetch(`${api}/drive/v3/files/${id}?fields=size`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return 0;
  return (sizes[id] = +(await r.json()).size || 0);
}
async function stream(req, url) {
  const id = decodeURIComponent(url.pathname.slice(STREAM_PATH.length)).split('/')[0];
  if (!/^[\w-]+$/.test(id)) return new Response('bad id', { status: 400 });
  if (+url.searchParams.get('size')) sizes[id] = +url.searchParams.get('size');
  const a = await getAuth();
  if (!a || !a.token || a.exp < Date.now()) return new Response('NEED_LOGIN', { status: 401 });
  const rangeH = req.headers.get('Range');
  let rg = parseRange(rangeH);
  // 結尾形式 bytes=-N（最後 N 位元組）要先知道總長，換成明確的起訖
  if (rg && rg.a === null) {
    const total = await fileSize(a.api, id, a.token);
    if (!total) rg = null; else rg = { a: Math.max(0, total - rg.b), b: total - 1 };
  }
  const h = { Authorization: 'Bearer ' + a.token };
  if (rg) h.Range = 'bytes=' + rg.a + '-' + (rg.b === null ? '' : rg.b);
  let r;
  try {
    r = await fetch(`${a.api}/drive/v3/files/${id}?alt=media`, { headers: h, cache: 'no-store', signal: req.signal });
  } catch (e) { return new Response('網路錯誤', { status: 504 }); }
  if (r.status === 401) { AUTH = null; return new Response('NEED_LOGIN', { status: 401 }); }
  if (!r.ok) return new Response('Drive 回應 ' + r.status, { status: r.status });

  const out = new Headers();
  const ct = r.headers.get('Content-Type') || '';
  out.set('Content-Type', /^video\//.test(ct) ? ct : 'video/mp4');
  out.set('Accept-Ranges', 'bytes');
  out.set('Cache-Control', 'no-store');
  const len = r.headers.get('Content-Length');   // CORS 安全清單內，讀得到
  if (r.status === 206) {
    let cr = r.headers.get('Content-Range');      // Drive 沒放進 Access-Control-Expose-Headers，通常是 null
    if (cr) { const m = /\/(\d+)$/.exec(cr); if (m) sizes[id] = +m[1]; }
    else {
      const total = sizes[id] || await fileSize(a.api, id, a.token);
      const start = rg ? rg.a : 0;
      const end = len !== null ? start + (+len) - 1 : (rg && rg.b !== null ? Math.min(rg.b, total - 1) : total - 1);
      cr = `bytes ${start}-${end}/${total || '*'}`;
    }
    out.set('Content-Range', cr);
    if (len !== null) out.set('Content-Length', len);
    return new Response(r.body, { status: 206, statusText: 'Partial Content', headers: out });
  }
  // 200：沒帶 Range，或上游不支援 Range
  if (len !== null) { out.set('Content-Length', len); sizes[id] = sizes[id] || +len; }
  if (rg && len !== null) {
    // 要了範圍卻拿到整支：自己切出要的那段，Safari 不接受 Range 請求回 200
    const total = +len, start = rg.a, end = rg.b === null ? total - 1 : Math.min(rg.b, total - 1);
    const body = (await r.arrayBuffer()).slice(start, end + 1);
    out.set('Content-Range', `bytes ${start}-${end}/${total}`);
    out.set('Content-Length', String(body.byteLength));
    return new Response(body, { status: 206, statusText: 'Partial Content', headers: out });
  }
  return new Response(r.body, { status: 200, statusText: 'OK', headers: out });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // googleapis 等外部請求不攔
  if (url.pathname.startsWith(STREAM_PATH)) { e.respondWith(stream(req, url)); return; }   // 串流：不進外殼快取
  if (!url.pathname.startsWith(SCOPE_PATH)) return;
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
