// assets/js/firebase-config.js
//
// 這個檔案控制整個 App 用哪種方式同步「勾選狀態」：
//
//   firebaseConfig = null   → 本機模式（LocalBackend）
//     勾選只存在使用者自己的瀏覽器 localStorage，法輝、法偉兩人的手機
//     看到的勾選狀態「不會」互相同步（僅同一裝置的多個分頁會同步）。
//     不需要任何設定，開箱即用。
//
//   firebaseConfig = { ...Firebase 專案設定... }   → Firestore 模式（FirestoreBackend）
//     兩人的勾選會即時同步（透過 Google Firestore 免費方案）。
//     需要使用者自行申請一個免費 Firebase 專案，並把 Console 給的設定物件貼在下方。
//
// ────────────────────────────────────────────────────────────────
// 使用者操作教學（完整逐步版請見專案根目錄的 FIREBASE_SETUP.md）：
//
// 1. 前往 https://console.firebase.google.com/ 建立一個新專案（免費）。
// 2. 左側選單「建構」→「Firestore Database」→ 建立資料庫（正式環境模式即可，
//    之後會用 firestore.rules 覆蓋安全規則）。
// 3. 左側選單「建構」→「Authentication」→「Sign-in method」→ 啟用「匿名」登入。
// 4. 左側選單「專案設定」（齒輪圖示）→ 頁面下方「你的應用程式」→
//    點「網頁」圖示（</>）新增一個 Web App（不需要 Firebase Hosting）。
// 5. Firebase 會顯示一段 `const firebaseConfig = { apiKey: "...", ... }`，
//    把整個物件複製，取代下方的 `null`，例如：
//
//      export const firebaseConfig = {
//        apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
//        authDomain: "your-project.firebaseapp.com",
//        projectId: "your-project",
//        storageBucket: "your-project.firebasestorage.app",
//        messagingSenderId: "123456789012",
//        appId: "1:123456789012:web:xxxxxxxxxxxxxxxxxxxxxx",
//      };
//
// 6. 把 firestore.rules 貼到 Firestore Database →「規則」分頁並發布。
// 7. 存檔、部署（或重新整理本機頁面），右上角同步狀態應由 ⚪local 變成
//    🟢synced（或連線中的 🟡pending）。
//
// 這些設定值（apiKey 等）本來就是公開給瀏覽器端使用的識別碼，不是密碼，
// 放進前端程式碼、提交到 GitHub 是 Firebase 官方建議的正常用法；
// 實際的存取控制由 firestore.rules（僅允許已登入的匿名使用者讀寫指定文件）負責。
// ────────────────────────────────────────────────────────────────

export const firebaseConfig = null;
