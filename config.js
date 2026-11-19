// 部署前要換：Google Cloud Console → API 和服務 → 憑證 → OAuth 用戶端 ID（網頁應用程式）。
// 設定方式見 README.md〈OAuth 用戶端〉。
window.APP_CONFIG = {
  CLIENT_ID: 'REPLACE_WITH_YOUR_CLIENT_ID.apps.googleusercontent.com',
  DRIVE_ROOT_NAME: '教學動畫備份',   // Drive 裡放成片的資料夾名稱
  MAP_MAX_AGE_HOURS: 12              // 影片清單超過幾小時、且登入還有效時，開 App 自動重掃
};
