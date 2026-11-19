# 課堂動畫（iPad 網頁 App，PWA）

一對一上課時用 iPad 播教學動畫。iPad Safari 打開網址 →「分享 → 加入主畫面」就像一般 App。
影片放在老師的 Google 雲端硬碟「教學動畫備份/」，點了才下載，存在 iPad 裡，之後離線也能播。

> 這個資料夾裡**所有畫面文字、檔名、manifest、圖示都不放品牌字樣**（學生在第三方平台上課，避免被判引流）。
> 改任何畫面文字後，用 `grep -rn -i -E "<品牌關鍵字>" .` 掃一次整個資料夾（關鍵字見上層 roadmap）。

## 架構

```
首頁（國小／國中／高中三排、六科）
  └ 科目 → 分組（生物／理化／地科、學測／分科…、新上架）→ 冊 → 章「第N章 章名」→ 影片卡片
                                                                       │ 點
           ┌───────────────────────────────────────────────────────────┘
           ▼
  已下載？──否──► Drive API alt=media（帶登入 token）→ 進度條 → 存 Cache API
           │是
           ▼
  Cache → blob → URL.createObjectURL → 播放器
     ├ 隱藏 video＋96x54 canvas 掃片頭片尾 → 只播 [start, end]
     └ 右上黑框依影片實際顯示區（含 letterbox）疊上
```

- **目錄**：`data/catalog.json` 是固定目錄樹（科目→…→章→片名）。登入後 App 讀 Drive「教學動畫備份/」各科資料夾（逐層、略過底線開頭資料夾，例如 `_720p_1114`、`_舊版成片_1114`；檔名結尾 `_old1115` 這類舊版也略過），用「科目＋正規化片名」對到目錄的葉子。
  - 正規化：去 `.mp4`、去 `YYYYMMDD_高物_` 這類前綴、NFKC、去空白、轉小寫（`app.js` 的 `norm()`，跟 `build_catalog.py` 的 `display_name()` 要一致）。
  - **Drive 裡有、目錄裡沒有的片 → 自動出現在該科的「新上架」分組**，新動畫不用改程式也看得到。
  - 對應結果存在 localStorage（`drivemap`），沒網路也能顯示目錄；超過 12 小時且登入還有效時，開 App 自動重掃（`config.js` 可改）。管理頁有「重新讀取雲端清單」。
- **登入**：Google OAuth 2.0 implicit redirect flow（`response_type=token`，scope `drive.readonly`），整頁導去 Google 再導回 App，從網址 `#access_token` 取 token 存 localStorage（含到期時間，約 1 小時）。**不用彈窗**：iPad「加入主畫面」的獨立視窗裡彈窗常拿不回結果。token 過期時已下載的影片照樣能播，只有下載新片才要求重新登入。
- **下載快取**：Cache API `class-videos-v1`，key 是 `__video/<fileId>?md5=<md5Checksum>`。Drive 上的檔案換版（md5 變了）就當新片重抓，舊版自動刪掉。啟動時呼叫 `navigator.storage.persist()`。
- **播放器**（`player.js`）：
  - 片頭片尾偵測照 `detect.py`：96x54、四角各一小塊，最小值 ≥235 算純白；片頭從 0 往後每 0.25 秒找「不白且平均亮度 ≤200」的點（二分法細化到 0.03 秒）＝start；片尾從尾端往前每 0.5 秒找最後一個不白的點，細化後的「白底開始」＝end（片尾問候語念在白底上，白底一出現就停）。結果依 `fileId:md5` 存 localStorage（`seg:` 開頭），第二次開秒播。偵測失敗退回整支播放，畫面下方小字註明。
  - 進度條只代表 [start, end]，拖不到外面；±10 秒、播放／暫停都夾在範圍內；到 end 自動停，再按 ▶ 從 start 重播。
  - 右上黑框：相對影片畫面 left 84.3%、top 4.1%、width 12.3%、height 10.4%（1080p 約 x1618–1854、y44–156），依 `object-fit: contain` 的實際顯示區計算；轉向、改尺寸時重算。可用「右上黑框」勾選框暫時關掉（不記憶，每次開片都預設開）。
- **離線**：`sw.js` 只快取 App 本身的檔案（先回快取、背景更新），不攔 googleapis 或任何外部請求，也不碰影片快取。

## 檔案用途

| 檔案 | 用途 |
|---|---|
| `index.html` | 唯一頁面；含 apple-touch-icon、apple-mobile-web-app-capable |
| `app.css` | 版面（間距 8 的倍數、圓角 8、字級最小 14、標題字重 800、一律淺色底） |
| `app.js` | 目錄導覽、登入、Drive 對應、下載快取、整章下載、管理頁 |
| `player.js` | 播放器、片頭片尾偵測、黑框 |
| `config.js` | **CLIENT_ID（部署前要換）**、Drive 資料夾名稱、清單自動重掃間隔 |
| `sw.js` | Service worker（App 外殼離線快取）；部署新版時改 `VERSION` |
| `manifest.webmanifest` | 名稱「課堂動畫」、standalone、淺色 theme、圖示 |
| `icons/icon-180/192/512.png` | 通用播放圖示，`make_icons.py` 產生 |
| `data/catalog.json` | 目錄樹，`build_catalog.py` 產生（App 讀這份） |
| `data/catalog_sample.json` 等四份 json | 目錄來源（國中自然片單、高中章對照、國中自然章名、數學架構） |
| `build_catalog.py` | 產生 `data/catalog.json` |
| `make_icons.py` | 產生圖示 |
| `_shots/` | 本機自驗截圖（不必部署） |

## 測試模式

網址加 `?dev=1`：右上多一顆「🧪 本機影片」，選一支本機 mp4 直接進播放器（不必登入），用來測片頭片尾偵測與黑框。

本機預覽（一定綁 127.0.0.1，用完關掉）：

```bash
cd <這個資料夾> && python3 -m http.server 8765 --bind 127.0.0.1
# 開 http://127.0.0.1:8765/?dev=1 ，用完 Ctrl+C
```

## 更新目錄

平常新增動畫**不必動 App**：備份到 Drive「教學動畫備份/<科目>/…」後，App 重新讀清單時會放進該科「新上架」。

要把新片排進正確的冊／章：

1. 更新 `data/` 裡的來源 json（國中自然改 `catalog_sample.json` 與 `jr_sci_chapters.json`；高中改 `hs_map.json`；數學改 `math_chapters.json`）。
2. `python3 build_catalog.py`（印出各科支數，確認數字合理）。
3. 把 `sw.js` 的 `VERSION` 改一個新字串（iPad 才會換新外殼與目錄）。
4. 重新部署（見下）。

## 部署（預定 GitHub Pages）

網址形如 `https://<帳號>.github.io/<repo>/`。程式裡所有路徑都是相對路徑，放子路徑可以直接用。repo 名稱與帳號名稱也不要帶品牌字樣。

1. 建一個 GitHub repo（可以 Private＋Pages，或 Public；影片不在 repo 裡，repo 只有程式與目錄）。
2. 把本資料夾內容放到 repo 根目錄（`_shots/`、`make_icons.py` 可不放）。
3. Settings → Pages → Source 選 main branch / root。
4. 等 Pages 網址可開後，做下面〈OAuth 用戶端〉，把 CLIENT_ID 填進 `config.js` 再推一次。
5. iPad Safari 開網址 → 登入 Google → 分享 →「加入主畫面」。

## OAuth 用戶端（老師在 Google Cloud Console 建）

1. 建（或選）一個專案 → 「API 和服務 → 程式庫」啟用 **Google Drive API**。
2. 「OAuth 同意畫面」：使用者類型「外部」，發布狀態維持「測試」，**測試使用者加入老師放影片的那個 Google 帳號**（測試狀態下 token 一樣是約 1 小時，只是同意畫面會顯示「未經驗證」，自己用沒關係）。範圍加 `https://www.googleapis.com/auth/drive.readonly`。
3. 「憑證 → 建立憑證 → OAuth 用戶端 ID」，類型選 **網頁應用程式**：
   - **已授權的 JavaScript 來源（Authorized JavaScript origins）**：`https://<帳號>.github.io`（只到網域，不含路徑、結尾不加斜線）
   - **已授權的重新導向 URI（Authorized redirect URIs）**：`https://<帳號>.github.io/<repo>/`（**結尾要有斜線**，要跟 App 算出來的完全一樣：網址去掉 `index.html` 後的目錄路徑）
   - 本機測登入時另加 `http://127.0.0.1:8765` 與 `http://127.0.0.1:8765/`（不需要可以不加）
4. 把產生的用戶端 ID（`xxxx.apps.googleusercontent.com`）填進 `config.js` 的 `CLIENT_ID`。用戶端 ID 不是密碼，放在公開網頁裡是正常的；**不需要也不要放用戶端密碼**。

## 已知限制與待驗證

- 只在 Mac 的 Chrome（headless）實測過；**iPad Safari 還沒實機測**。最需要在 iPad 上確認的三件事：
  1. 加入主畫面後，登入導去 Google 再導回來，token 有沒有留在 App 裡（iOS 的主畫面 App 與 Safari 的 localStorage 是分開的，要在主畫面 App 裡登入）。
  2. 隱藏 video 的 canvas 取像在 iPad 上有沒有取到畫面（程式已先 play/pause 一次；若偵測失敗，畫面會小字註明並整支播）。
  3. 大檔（80 MB 上下）從 Cache 讀成 blob 播放的順暢度。
- 下載時整支先放在記憶體再寫進快取，單支幾百 MB 以上可能吃緊（目前成片約 30–80 MB）。
- iPad 的儲存空間上限由系統決定；沒取得永久保存時，空間不足系統可能清掉影片，管理頁有顯示狀態。
- Drive 若出現同科同名的兩支片，取修改時間較新的那支。
