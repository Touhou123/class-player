// 播放器：只播片頭與片尾之間那一段，右上疊黑框。
// 片頭片尾偵測照 work/20261118-2257-一對一教學App/detect.py：
//   畫面縮成 96x54 灰階，取四個角落各一小塊；最小值 >= 235 算「純白」（片頭 Logo、片尾白底），
//   平均亮度 > 200 算還在淡出。
//   start = 片頭白底結束後、角落平均亮度掉到 200 以下的時間點（detect.py 的 intro_fade_end）
//   end   = 片尾白底開始的時間點（detect.py 的 outro_white_start）；片尾問候語念在白底上，白底一出現就停。
(function () {
  const W = 96, H = 54;
  const MASK = { l: 0.843, t: 0.041, w: 0.123, h: 0.104 };   // 右上浮水印，相對影片畫面
  const SEG_VER = 1;                                          // 偵測演算法版本，改演算法時加 1 讓舊快取失效
  // 還沒偵測過的片先用經驗值開播，背景算出精確值再換上：
  //   全部成片片頭 Logo 約 4 秒；片尾白底實測在結尾前 3～9 秒，先保守停在結尾前 8 秒（寧可早停，不播到片尾問候）
  const GUESS_START = 4.1, GUESS_TAIL = 8;

  // ---------- 偵測 ----------
  function cornerStats(ctx) {
    const d = ctx.getImageData(0, 0, W, H).data;
    // 同 detect.py：a[2:8,2:12]、a[2:8,-12:-2]、a[-8:-2,2:12]、a[-8:-2,-12:-2]
    const boxes = [[2, 8, 2, 12], [2, 8, W - 12, W - 2], [H - 8, H - 2, 2, 12], [H - 8, H - 2, W - 12, W - 2]];
    let mn = 255, sum = 0, n = 0;
    for (const [y0, y1, x0, x1] of boxes)
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4;
          // detect.py 的 ffmpeg gray 是全範圍（實測片頭白底約 253），canvas 也是全範圍，門檻直接沿用 235／200
          const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (g < mn) mn = g; sum += g; n++;
        }
    return { white: mn >= 235, mean: sum / n, min: mn };
  }

  function seekTo(v, t) {
    return new Promise((res, rej) => {
      const to = setTimeout(() => { v.removeEventListener('seeked', ok); rej(new Error('seek 逾時')); }, 20000);   // 串流時主畫面也在抓資料，8 秒常不夠
      function ok() { clearTimeout(to); v.removeEventListener('seeked', ok); res(); }
      v.addEventListener('seeked', ok);
      v.currentTime = t;
    });
  }

  // stream=true 時影片是邊下載邊播的串流：只讀片頭幾秒與片尾十幾秒的片段，不預載整支
  async function detectSegment(src, stream) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = stream ? 'metadata' : 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:96px;height:54px;opacity:0;pointer-events:none';
    document.body.appendChild(v);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try {
      v.src = src;
      await new Promise((res, rej) => {
        if (v.readyState >= 1) return res();
        v.addEventListener('loadedmetadata', res, { once: true });
        v.addEventListener('error', () => rej(new Error('影片載入失敗')), { once: true });
        setTimeout(() => rej(new Error('影片載入逾時')), 15000);
      });
      // iPad Safari：沒播過的影片有時 drawImage 是空的，先播一下再暫停
      try { await v.play(); v.pause(); } catch (e) {}
      const dur = v.duration;
      if (!isFinite(dur) || dur <= 0) throw new Error('讀不到片長');
      const sample = async t => {
        t = Math.max(0, Math.min(dur - 0.05, t));
        await seekTo(v, t);
        ctx.drawImage(v, 0, 0, W, H);
        return cornerStats(ctx);
      };
      const done = s => !s.white && s.mean <= 200;   // 片頭淡出結束

      // 片頭：0 起每 0.25 秒往後找，最多 30 秒
      let start = 0, introFound = false;
      const first = await sample(0);
      if (first.white) {
        let prev = 0;
        for (let t = 0.25; t <= Math.min(30, dur / 2); t += 0.25) {
          if (done(await sample(t))) {
            let lo = prev, hi = t;                    // 二分法細化到 0.03 秒
            while (hi - lo > 0.03) { const m = (lo + hi) / 2; if (done(await sample(m))) hi = m; else lo = m; }
            start = hi; introFound = true; break;
          }
          prev = t;
        }
      }

      // 片尾：從尾端往前每 0.5 秒找，找到第一個「不是白底」的點，最多 60 秒
      let end = dur, outroFound = false;
      const last = await sample(dur - 0.05);
      if (last.white) {
        let prev = dur - 0.05;
        for (let t = dur - 0.5; t >= Math.max(start + 1, dur - 60); t -= 0.5) {
          if (!(await sample(t)).white) {
            let lo = t, hi = prev;                    // lo 不白、hi 白
            while (hi - lo > 0.03) { const m = (lo + hi) / 2; if ((await sample(m)).white) hi = m; else lo = m; }
            end = hi; outroFound = true; break;
          }
          prev = t;
        }
      }
      if (end - start < 3) throw new Error('偵測出的片段太短');
      return { v: SEG_VER, start: +start.toFixed(2), end: +end.toFixed(2), dur: +dur.toFixed(2), introFound, outroFound };
    } finally {
      v.removeAttribute('src'); v.load(); v.remove();
    }
  }

  function savedSegment(key) {
    try {
      const s = JSON.parse(localStorage.getItem('seg:' + key) || 'null');
      if (s && s.v === SEG_VER) return s;
    } catch (e) {}
    return null;
  }
  async function getSegment(key, src, stream) {
    const old = savedSegment(key); if (old) return old;
    const s = await detectSegment(src, stream);
    try { localStorage.setItem('seg:' + key, JSON.stringify(s)); } catch (e) {}
    return s;
  }

  // ---------- 播放器 ----------
  const $ = id => document.getElementById(id);
  let seg = null, url = null, raf = 0, onCloseCb = null, onHomeCb = null, onErrorCb = null;
  const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function placeMask() {
    const v = $('vid'), st = $('stage'), m = $('mask');
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) { m.style.display = 'none'; return; }
    const bw = st.clientWidth, bh = st.clientHeight;
    const k = Math.min(bw / vw, bh / vh);            // object-fit: contain
    const dw = vw * k, dh = vh * k, ox = (bw - dw) / 2, oy = (bh - dh) / 2;
    Object.assign(m.style, {
      left: (ox + MASK.l * dw) + 'px', top: (oy + MASK.t * dh) + 'px',
      width: (MASK.w * dw) + 'px', height: (MASK.h * dh) + 'px',
      display: $('cMask').checked ? 'block' : 'none'
    });
  }

  function clampT(t) { return Math.max(seg.start, Math.min(seg.end, t)); }

  function render() {
    const v = $('vid');
    if (!seg) return;
    const len = seg.end - seg.start, p = Math.max(0, Math.min(1, (v.currentTime - seg.start) / len));
    $('barFill').style.width = (p * 100) + '%';
    $('barKnob').style.left = (p * 100) + '%';
    $('tNow').textContent = fmt(v.currentTime - seg.start);
    $('tAll').textContent = fmt(len);
    $('cPlay').textContent = v.paused ? '▶' : '⏸';
  }

  function tick() {
    const v = $('vid');
    if (seg && !v.paused) {
      if (v.currentTime >= seg.end - 0.04) { v.pause(); v.currentTime = seg.end; }
      else if (v.currentTime < seg.start - 0.2) v.currentTime = seg.start;
    }
    render();
    raf = requestAnimationFrame(tick);
  }

  function msg(t) { const m = $('pMsg'); m.hidden = !t; m.textContent = t || ''; }

  function segNote(s) {
    const notes = [];
    if (!s.introFound) notes.push('沒找到片頭');
    if (!s.outroFound) notes.push('沒找到片尾');
    return notes.length ? notes.join('、') + '，這段照原片播。' : '';
  }

  // 開片流程（下載好的 blob 與串流都走這條）：
  //   已有偵測結果 → 直接用精確範圍播；
  //   沒有 → 先用經驗值（4.1 秒起、結尾前 8 秒停）馬上開播，另一個隱藏 video 在背景算精確值，算好就換上並存起來。
  async function open({ title, src, key, stream, onClose, onHome, onError }) {
    close(true);
    onCloseCb = onClose; onHomeCb = onHome; onErrorCb = onError;
    url = src;
    $('pTitle').textContent = title;
    $('pNote').textContent = '';
    $('player').hidden = false;
    $('mask').style.display = 'none';
    const v = $('vid');
    seg = null; render();
    msg('載入中⋯');
    const known = savedSegment(key);
    v.src = src;
    try {
      await new Promise((res, rej) => {
        if (v.readyState >= 1) return res();
        v.addEventListener('loadedmetadata', res, { once: true });
        v.addEventListener('error', () => rej(new Error('影片載入失敗')), { once: true });
      });
    } catch (e) {
      if (url === src) msg((onErrorCb && onErrorCb()) || '影片載入失敗，請再點一次。');
      return;
    }
    if (url !== src) return;   // 載入期間已關閉或換片
    const dur = v.duration;
    if (known) {
      seg = known;
      $('pNote').textContent = segNote(seg);
    } else {
      seg = { start: Math.min(GUESS_START, dur / 4), end: Math.max(dur - GUESS_TAIL, dur / 2), guess: true };
      $('pNote').textContent = '正在找片頭片尾的精確位置，先用預設範圍播放⋯';
    }
    v.currentTime = seg.start;
    msg('');
    placeMask();
    window.__seg = seg;   // 測試用
    try { await v.play(); } catch (e) { /* iPad 需要使用者手勢時，按 ▶ 即可 */ }
    cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
    if (known) return;
    getSegment(key, src, stream).then(s => {
      if (url !== src) return;
      seg = s; window.__seg = seg;
      $('pNote').textContent = segNote(s);
      if (v.currentTime > s.end) { v.pause(); v.currentTime = s.end; }
      render();
    }).catch(e => {
      if (url !== src) return;
      $('pNote').textContent = '片頭片尾偵測失敗（' + e.message + '），先用預設範圍播放。';
    });
  }

  function close(silent) {
    const v = $('vid');
    v.pause(); v.removeAttribute('src'); v.load();
    cancelAnimationFrame(raf);
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
    url = null; seg = null;
    $('player').hidden = true;
    if (!silent && onCloseCb) onCloseCb();
  }


  // ---------- 音量 ----------
  // iPad Safari 的 video.volume 是唯讀（永遠 1），只能接 Web Audio 的 GainNode 調。
  // 注意：影片一接上 AudioContext，聲音就只從 context 出；context 若被暫停會整個無聲，
  // 所以只在使用者點擊當下、確定 context 已在跑才接，接不上就退回 video.volume（電腦有效）。
  let actx = null, gain = null, wired = false;
  const VOL_KEY = 'vol';
  let vol = (() => { try { const x = +localStorage.getItem(VOL_KEY); return isFinite(x) && localStorage.getItem(VOL_KEY) !== null ? x : 100; } catch (e) { return 100; } })();
  let muted = false;
  function applyVol() {
    const v = $('vid'), g = muted ? 0 : vol / 100;
    if (wired && gain) { gain.gain.value = g; v.volume = 1; v.muted = false; }
    else { v.volume = Math.min(1, g); v.muted = g === 0; }
    $('cVol').value = vol; $('vPct').textContent = muted ? '靜音' : vol + '%';
    $('cMute').textContent = muted || vol === 0 ? '🔇' : '🔊';
  }
  function wireAudio() {   // 只在使用者動音量時呼叫（點擊當下）；沒動過音量就維持原生播放，最不容易出事
    try {
      // iPad 的 Web Audio 預設會被側邊靜音鍵／靜音模式消音，改成「播放」類別才跟影片一樣有聲
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return applyVol(); actx = new AC(); }
      const wire = () => {
        if (!wired && actx.state === 'running') {
          const src = actx.createMediaElementSource($('vid'));
          gain = actx.createGain(); src.connect(gain); gain.connect(actx.destination); wired = true;
        }
        applyVol();
      };
      if (actx.state === 'running') wire(); else actx.resume().then(wire, applyVol);
    } catch (e) { /* 接不上就用 video.volume */ }
    applyVol();
  }

  function seekRel(d) { const v = $('vid'); if (!seg) return; v.currentTime = clampT(v.currentTime + d); render(); }

  function bind() {
    const v = $('vid');
    applyVol();
    // 接上 Web Audio 後，iPad 切到背景回來 context 會被暫停（無聲），任何點擊都順手喚醒
    document.addEventListener('pointerdown', () => { if (wired && actx.state !== 'running') actx.resume(); }, true);
    $('cVol').oninput = () => { vol = +$('cVol').value; muted = false; try { localStorage.setItem(VOL_KEY, vol); } catch (e) {} wireAudio(); };
    $('cMute').onclick = () => { muted = !muted; wireAudio(); };
    $('cPlay').onclick = () => {
      if (!seg) return;
      if (vol !== 100 && !wired) wireAudio();   // 上次調過音量：第一次按 ▶ 時套用
      if (v.paused) { if (v.currentTime >= seg.end - 0.1) v.currentTime = seg.start; v.play(); } else v.pause();
    };
    $('cBack').onclick = () => seekRel(-10);
    $('cFwd').onclick = () => seekRel(10);
    $('pClose').onclick = () => close();
    $('pHome').onclick = () => { close(true); onHomeCb && onHomeCb(); };
    $('cMask').onchange = placeMask;
    v.addEventListener('loadedmetadata', placeMask);
    v.addEventListener('seeking', () => { if (seg && (v.currentTime < seg.start - 0.05 || v.currentTime > seg.end + 0.05)) v.currentTime = clampT(v.currentTime); });
    v.addEventListener('ended', () => { if (seg) v.currentTime = seg.end; render(); });
    v.addEventListener('error', () => { if (url && seg) msg((onErrorCb && onErrorCb()) || '影片播放中斷，請再點一次。'); });
    window.addEventListener('resize', placeMask);
    window.addEventListener('orientationchange', () => setTimeout(placeMask, 300));
    if (window.ResizeObserver) new ResizeObserver(placeMask).observe($('stage'));
    // 進度條：只對應 [start, end]
    const bar = $('bar');
    const toT = e => { const r = bar.getBoundingClientRect(); const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); return seg.start + p * (seg.end - seg.start); };
    let drag = false;
    bar.addEventListener('pointerdown', e => { if (!seg) return; drag = true; bar.setPointerCapture(e.pointerId); v.currentTime = toT(e); render(); });
    bar.addEventListener('pointermove', e => { if (drag && seg) { v.currentTime = toT(e); render(); } });
    bar.addEventListener('pointerup', () => { drag = false; });
    bar.addEventListener('pointercancel', () => { drag = false; });
  }

  window.Player = { open, close, bind, detectSegment, placeMask };
})();
