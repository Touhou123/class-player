// 課堂動畫：目錄導覽、Google 登入（OAuth implicit redirect）、Drive 影片對應、下載快取、管理頁。
(function () {
  const CFG = window.APP_CONFIG || {};
  const $ = id => document.getElementById(id);
  const DEV = new URLSearchParams(location.search).get('dev') === '1';
  const VCACHE = 'class-videos-v1';
  const LS = { token: 'auth', map: 'drivemap', meta: 'dlmeta', state: 'oauth_state', path: 'lastpath' };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 片名正規化（Drive 檔名 ↔ 目錄片名） ----------
  // displayName 要跟 build_catalog.py 的 display_name() 一致
  const displayName = n => n.replace(/\.mp4$/i, '').replace(/^\d{8}_[^_]+_/, '').trim();
  const norm = n => displayName(n).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const isOld = n => /_old\d*$/i.test(n.replace(/\.mp4$/i, ''));

  // ---------- 狀態 ----------
  let CAT = null;            // data/catalog.json
  let TREE = null;           // 目錄樹（含動態加上的「新上架」）
  let path = [];             // 目前位置
  let MAP = lsGet(LS.map, null);   // {at, files:{'科目|片名': {id,name,size,modifiedTime,md5Checksum}}, extra:{科目:[片名]}}
  let cached = new Set();    // 已快取的 'id|md5'
  const busy = {};           // 下載中：fileId -> 0~1

  // ---------- 登入 ----------
  function token() {
    const t = lsGet(LS.token, null);
    return t && t.exp > Date.now() + 60000 ? t.access_token : null;
  }
  function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
  function login() {
    if (/^REPLACE_/.test(CFG.CLIENT_ID || '')) { alert('還沒設定 Google 登入（config.js 的 CLIENT_ID）。'); return; }
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    lsSet(LS.state, state);
    lsSet(LS.path, path);
    const q = new URLSearchParams({
      client_id: CFG.CLIENT_ID, redirect_uri: redirectUri(), response_type: 'token',
      scope: 'https://www.googleapis.com/auth/drive.readonly', include_granted_scopes: 'true', state
    });
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
  }
  function takeTokenFromHash() {
    if (!location.hash.includes('access_token=') && !location.hash.includes('error=')) return false;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    const want = lsGet(LS.state, null); localStorage.removeItem(LS.state);
    if (h.get('error')) { flash('登入沒有完成（' + h.get('error') + '）。', true); return false; }
    if (!want || h.get('state') !== want) { flash('登入回傳的驗證碼不符，請再登入一次。', true); return false; }
    lsSet(LS.token, { access_token: h.get('access_token'), exp: Date.now() + (+h.get('expires_in') || 3600) * 1000 });
    const p = lsGet(LS.path, []); if (Array.isArray(p)) path = p;
    return true;
  }
  function logout() { localStorage.removeItem(LS.token); updateHeader(); flash('已登出。已下載的影片照樣可以播。'); }

  // ---------- Drive ----------
  async function gapi(url, params) {
    const tk = token(); if (!tk) throw new Error('NEED_LOGIN');
    const r = await fetch(url + (params ? '?' + new URLSearchParams(params) : ''), { headers: { Authorization: 'Bearer ' + tk } });
    if (r.status === 401) { localStorage.removeItem(LS.token); throw new Error('NEED_LOGIN'); }
    if (!r.ok) throw new Error('Drive 回應 ' + r.status);
    return r.json();
  }
  async function listChildren(parent) {
    const out = []; let pageToken;
    do {
      const p = { q: `'${parent}' in parents and trashed=false`, pageSize: 1000,
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)' };
      if (pageToken) p.pageToken = pageToken;
      const j = await gapi('https://www.googleapis.com/drive/v3/files', p);
      out.push(...(j.files || [])); pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  }
  const FOLDER = 'application/vnd.google-apps.folder';
  async function scanDrive() {
    flash('正在讀取雲端影片清單⋯');
    const roots = await gapi('https://www.googleapis.com/drive/v3/files', {
      q: `name='${CFG.DRIVE_ROOT_NAME.replace(/'/g, "\\'")}' and mimeType='${FOLDER}' and trashed=false`,
      fields: 'files(id,name)', pageSize: 10
    });
    if (!roots.files || !roots.files.length) throw new Error('雲端硬碟裡找不到「' + CFG.DRIVE_ROOT_NAME + '」資料夾');
    const files = {};
    const add = (subj, f) => {
      if (isOld(f.name)) return;
      const k = subj + '|' + norm(f.name);
      const o = files[k];
      if (!o || (f.modifiedTime || '') > (o.modifiedTime || '')) files[k] = { id: f.id, name: f.name, size: +f.size || 0, modifiedTime: f.modifiedTime, md5Checksum: f.md5Checksum || '' };
    };
    for (const root of roots.files) {
      const subjects = (await listChildren(root.id)).filter(f => f.mimeType === FOLDER && !f.name.startsWith('_'));
      // 各科往下逐層找 mp4，略過底線開頭的資料夾（舊版、720p 等）
      await Promise.all(subjects.map(async s => {
        const queue = [s.id];
        while (queue.length) {
          const batch = queue.splice(0, 6);
          const lists = await Promise.all(batch.map(listChildren));
          for (const l of lists) for (const f of l) {
            if (f.mimeType === FOLDER) { if (!f.name.startsWith('_')) queue.push(f.id); }
            else if (/\.mp4$/i.test(f.name) || (f.mimeType || '').startsWith('video/')) add(s.name, f);
          }
        }
      }));
    }
    // catalog 沒有的片 → 該科「新上架」
    const known = new Set();
    walkLeaves(CAT.tree, (subj, name) => known.add(subj + '|' + norm(name)));
    const extra = {};
    for (const [k, f] of Object.entries(files)) if (!known.has(k)) {
      const subj = k.split('|')[0];
      (extra[subj] = extra[subj] || []).push(displayName(f.name));
    }
    for (const s in extra) extra[s].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    MAP = { at: Date.now(), files, extra };
    lsSet(LS.map, MAP);
    buildTree();
    const n = Object.keys(files).length, ne = Object.values(extra).reduce((a, b) => a + b.length, 0);
    flash(`雲端影片清單已更新：${n} 支${ne ? `（其中 ${ne} 支是新上架）` : ''}。`, false, true);
  }

  // ---------- 目錄 ----------
  function walkLeaves(node, fn, subj, depth = 0) {
    if (Array.isArray(node)) { node.forEach(n => fn(subj, n)); return; }
    for (const [k, v] of Object.entries(node)) walkLeaves(v, fn, depth === 0 ? k : subj, depth + 1);
  }
  function buildTree() {
    TREE = JSON.parse(JSON.stringify(CAT.tree));
    if (MAP && MAP.extra) for (const [s, names] of Object.entries(MAP.extra)) {
      if (!TREE[s]) TREE[s] = {};
      TREE[s]['新上架'] = names;
    }
  }
  const fileOf = (subj, name) => MAP && MAP.files ? MAP.files[subj + '|' + norm(name)] : null;
  const isCached = f => f && cached.has(f.id + '|' + f.md5Checksum);
  const cnt = n => Array.isArray(n) ? n.length : Object.values(n).reduce((a, b) => a + cnt(b), 0);
  function node(p = path) { let n = TREE; for (const k of p) { if (!n || !(k in n)) return null; n = n[k]; } return n; }

  function go(p) {
    path = p;
    if (!node()) path = [];
    render();
    $('main').scrollTop = 0;
  }

  function crumb() {
    if (path === 'manage') return '<span class="cur">管理下載</span>';
    if (!path.length) return '<span class="cur">選科目</span>';
    return path.map((x, i) => i === path.length - 1 ? `<span class="cur">${esc(x)}</span>`
      : `<a data-go='${esc(JSON.stringify(path.slice(0, i + 1)))}'>${esc(x)}</a> ›`).join(' ');
  }

  function videoCard(subj, name) {
    const f = fileOf(subj, name);
    let chip, cls = 'card v', prog = '';
    if (f && busy[f.id] !== undefined) { chip = `<span class="chip">⬇ 下載中 ${Math.round(busy[f.id] * 100)}%</span>`; prog = `<div class="prog" style="width:${busy[f.id] * 100}%"></div>`; }
    else if (isCached(f)) chip = '<span class="chip dl">✓ 已下載</span>';
    else if (f) chip = '<span class="chip">☁ 點了才下載</span>';
    else if (!MAP) chip = '<span class="chip no">登入後才能下載</span>';
    else { chip = '<span class="chip no">雲端找不到這支</span>'; cls += ' off'; }
    return `<div class="${cls}" data-play="${esc(name)}" ${f ? `data-fid="${f.id}"` : ''}><b>${esc(name)}</b>${chip}${prog}</div>`;
  }

  function render() {
    updateHeader();
    $('crumb').innerHTML = crumb();
    $('bBack').disabled = path === 'manage' ? false : !path.length;
    if (path === 'manage') return renderManage();
    const n = node(), m = $('main');
    if (!path.length) {
      m.innerHTML = Object.entries(CAT.levels).map(([lv, ss]) => `<div class="lv">${esc(lv)}</div><div class="grid l1">${ss.map(k =>
        `<div class="card" data-go='${esc(JSON.stringify([k]))}'><b>${esc(k)}</b><span class="chip">${TREE[k] && cnt(TREE[k]) ? cnt(TREE[k]) + ' 支' : '動畫準備中'}</span></div>`).join('')}</div>`).join('');
    } else if (Array.isArray(n)) {
      const subj = path[0];
      if (!n.length) { m.innerHTML = '<div class="empty">動畫準備中。這一章的動畫做好後會自動出現在這裡。</div>'; return; }
      const files = n.map(x => fileOf(subj, x)).filter(Boolean);
      const left = files.filter(f => !isCached(f));
      const tb = files.length ? `<div class="toolbar"><button class="btn" id="bChap" ${left.length ? '' : 'disabled'}>⬇ 整章下載${left.length ? `（${left.length} 支未下載）` : '（都已下載）'}</button><span class="hint">課前先抓好，上課就不用等。</span></div>` : '';
      m.innerHTML = tb + `<div class="grid">${n.map(x => videoCard(subj, x)).join('')}</div>`;
      if ($('bChap')) $('bChap').onclick = () => downloadMany(left);
    } else {
      m.innerHTML = `<div class="grid">${Object.keys(n).map(k =>
        `<div class="card" data-go='${esc(JSON.stringify([...path, k]))}'><b>${esc(k)}</b><span class="chip ${k === '新上架' ? 'new' : ''}">${cnt(n[k]) ? cnt(n[k]) + ' 支' : '動畫準備中'}</span></div>`).join('')}</div>`;
    }
  }

  function refreshCard(fid) {
    const el = document.querySelector(`[data-fid="${fid}"]`);
    if (el && Array.isArray(node())) {
      const tmp = document.createElement('div'); tmp.innerHTML = videoCard(path[0], el.dataset.play);
      el.replaceWith(tmp.firstChild);
    }
  }

  // ---------- 快取 ----------
  const vkey = f => new URL('__video/' + f.id + '?md5=' + encodeURIComponent(f.md5Checksum || ''), location.href).href;
  async function loadCachedSet() {
    cached = new Set();
    if (!('caches' in window)) return;
    const c = await caches.open(VCACHE);
    for (const r of await c.keys()) {
      const u = new URL(r.url); const id = u.pathname.split('/').pop();
      cached.add(id + '|' + (u.searchParams.get('md5') || ''));
    }
  }

  async function download(f, label) {
    if (busy[f.id] !== undefined) return false;
    if (!token()) { if (confirm('登入已過期，要下載新影片需要重新登入 Google。現在登入？')) login(); return false; }
    busy[f.id] = 0; refreshCard(f.id);
    try {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { Authorization: 'Bearer ' + token() } });
      if (r.status === 401) { localStorage.removeItem(LS.token); throw new Error('登入過期'); }
      if (!r.ok) throw new Error('下載失敗 ' + r.status);
      const total = +r.headers.get('Content-Length') || f.size || 0;
      const rd = r.body.getReader(); const parts = []; let got = 0, last = 0;
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        parts.push(value); got += value.length;
        if (total) { busy[f.id] = Math.min(1, got / total); if (Date.now() - last > 250) { last = Date.now(); refreshCard(f.id); } }
      }
      const blob = new Blob(parts, { type: 'video/mp4' });
      const c = await caches.open(VCACHE);
      for (const k of await c.keys()) if (new URL(k.url).pathname.endsWith('/' + f.id)) await c.delete(k);   // 舊版（md5 不同）
      await c.put(vkey(f), new Response(blob, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(blob.size) } }));
      const meta = lsGet(LS.meta, {}); meta[f.id] = { name: displayName(f.name), size: blob.size, md5: f.md5Checksum, at: Date.now() }; lsSet(LS.meta, meta);
      cached.add(f.id + '|' + f.md5Checksum);
      return true;
    } catch (e) {
      flash(`「${label || displayName(f.name)}」下載失敗：${e.message}`, true);
      return false;
    } finally { delete busy[f.id]; refreshCard(f.id); }
  }

  async function downloadMany(list) {
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      flash(`整章下載中：第 ${i + 1}／${list.length} 支⋯`);
      if (await download(list[i])) ok++; else if (!token()) break;
    }
    flash(`整章下載完成：${ok}／${list.length} 支。`, ok < list.length, ok === list.length);
    if (Array.isArray(node())) render();
  }

  async function playFile(f, title) {
    if (!isCached(f)) {
      if (!await download(f, title)) return;
      if (!Array.isArray(node()) || !$('player').hidden) return;
    }
    const c = await caches.open(VCACHE);
    const r = await c.match(vkey(f));
    if (!r) { cached.delete(f.id + '|' + f.md5Checksum); render(); return; }
    const url = URL.createObjectURL(await r.blob());   // 同源 blob，canvas 讀像素才不會被擋
    Player.open({ title, src: url, key: f.id + ':' + f.md5Checksum, onClose: () => render(), onHome: () => go([]) });
  }

  // ---------- 管理頁 ----------
  const mb = b => (b / 1048576).toFixed(b > 1e9 ? 0 : 1) + ' MB';
  async function renderManage() {
    const m = $('main');
    let est = null; try { est = await navigator.storage.estimate(); } catch (e) {}
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    const meta = lsGet(LS.meta, {});
    const rows = [];
    if ('caches' in window) {
      const c = await caches.open(VCACHE);
      for (const k of await c.keys()) {
        const id = new URL(k.url).pathname.split('/').pop();
        rows.push({ id, url: k.url, name: (meta[id] && meta[id].name) || id, size: (meta[id] && meta[id].size) || 0 });
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    const used = rows.reduce((a, b) => a + b.size, 0);
    const tk = lsGet(LS.token, null);
    m.innerHTML = `
      <div class="panel"><h2>儲存空間</h2>
        <p>已下載 ${rows.length} 支，共 ${mb(used)}。${est ? `這個 App 目前用了 ${mb(est.usage || 0)}，上限約 ${mb(est.quota || 0)}。` : ''}</p>
        ${est && est.quota ? `<div class="meter"><i style="width:${Math.min(100, (est.usage || 0) / est.quota * 100).toFixed(1)}%"></i></div>` : ''}
        <p>${persisted ? '✓ 已設為永久保存，系統不會自動清掉。' : '尚未取得永久保存；空間不足時系統可能清掉已下載的影片。加入主畫面後再開一次通常就會取得。'}</p>
        <div class="toolbar" style="margin:16px 0 0">${rows.length ? '<button class="btn del" id="bDelAll">全部刪除</button>' : ''}</div>
      </div>
      <div class="panel"><h2>Google 帳號與雲端清單</h2>
        <p>${token() ? '已登入，' + Math.max(0, Math.round((tk.exp - Date.now()) / 60000)) + ' 分鐘後過期（過期後已下載的影片照樣能播，下載新片才要再登入）。' : '目前沒有登入。'}</p>
        <p>${MAP ? '雲端影片清單上次更新：' + new Date(MAP.at).toLocaleString('zh-TW') + `，共 ${Object.keys(MAP.files).length} 支。` : '還沒讀過雲端影片清單。'}</p>
        <div class="toolbar" style="margin:16px 0 0">
          <button class="btn" id="bRescan">重新讀取雲端清單</button>
          ${token() ? '<button class="btn" id="bLogout">登出</button>' : '<button class="btn" id="bLogin2">登入 Google</button>'}
        </div>
      </div>
      <div class="panel"><h2>已下載的影片</h2>
        ${rows.length ? rows.map(r => `<div class="row"><span class="nm">${esc(r.name)}</span><span class="sz">${r.size ? mb(r.size) : ''}</span><button class="btn del" data-del="${esc(r.url)}" data-name="${esc(r.name)}">刪除</button></div>`).join('') : '<p>還沒有下載任何影片。</p>'}
      </div>
      <div class="panel"><h2>版本</h2><p>目錄產生時間：${esc(CAT.built || '')}</p></div>`;
    m.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm(`確定刪除「${b.dataset.name}」？之後要播需要重新下載。`)) return;
      const c = await caches.open(VCACHE); await c.delete(b.dataset.del);
      await loadCachedSet(); renderManage();
    });
    if ($('bDelAll')) $('bDelAll').onclick = async () => {
      if (!confirm(`確定刪除全部 ${rows.length} 支已下載的影片（${mb(used)}）？之後要播需要重新下載。`)) return;
      await caches.delete(VCACHE); lsSet(LS.meta, {});
      await loadCachedSet(); renderManage();
    };
    $('bRescan').onclick = () => token() ? scanDrive().then(renderManage).catch(onErr) : login();
    if ($('bLogout')) $('bLogout').onclick = () => { logout(); renderManage(); };
    if ($('bLogin2')) $('bLogin2').onclick = login;
  }

  // ---------- 介面雜項 ----------
  let flashT = 0;
  function flash(t, bad, ok) {
    const s = $('status'); s.hidden = false; s.textContent = t; s.className = 'status' + (ok ? ' ok' : '');
    clearTimeout(flashT); if (ok || bad) flashT = setTimeout(() => { s.hidden = true; }, bad ? 8000 : 4000);
  }
  function onErr(e) {
    if (e.message === 'NEED_LOGIN') flash('登入已過期，按右上「登入 Google」重新登入。', true);
    else flash('發生錯誤：' + e.message, true);
    updateHeader();
  }
  function updateHeader() {
    $('bLogin').hidden = !!token();
    $('bDev').hidden = !DEV;
  }

  // ---------- 啟動 ----------
  async function init() {
    Player.bind();
    $('bHome').onclick = () => go([]);
    $('bBack').onclick = () => go(path === 'manage' ? lsGet(LS.path, []) : path.slice(0, -1));
    $('bLogin').onclick = login;
    $('bManage').onclick = () => { if (path !== 'manage') lsSet(LS.path, path); path = 'manage'; render(); };
    $('bDev').onclick = () => $('devFile').click();
    $('devFile').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      Player.open({ title: '🧪 ' + f.name, src: URL.createObjectURL(f), key: 'dev:' + f.name + ':' + f.size, onClose: () => render(), onHome: () => go([]) });
      e.target.value = '';
    };
    document.body.addEventListener('click', e => {
      const g = e.target.closest('[data-go]'); if (g) return go(JSON.parse(g.dataset.go));
      const c = e.target.closest('[data-play]');
      if (c && !c.classList.contains('off')) {
        const f = fileOf(path[0], c.dataset.play);
        if (!f) { if (!MAP) { if (confirm('要先登入 Google 才能下載影片。現在登入？')) login(); } return; }
        playFile(f, c.dataset.play);
      }
    });

    const fresh = takeTokenFromHash();
    CAT = await (await fetch('data/catalog.json')).json();
    buildTree();
    await loadCachedSet().catch(() => {});
    go(Array.isArray(path) ? path : []);

    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ('serviceWorker' in navigator && !DEV) navigator.serviceWorker.register('sw.js').catch(() => {});

    const stale = !MAP || Date.now() - MAP.at > (CFG.MAP_MAX_AGE_HOURS || 12) * 3600e3;
    if (token() && (fresh || stale)) scanDrive().then(render).catch(onErr);
    else if (!token() && !MAP) flash('第一次使用：按右上「登入 Google」讀取雲端的動畫清單。');
  }
  init().catch(onErr);
})();
