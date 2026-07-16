# Firebase 設定教學（讓法輝、法偉的勾選即時同步）

這份文件教你如何申請一個**免費**的 Firebase 專案，讓兩人在禪七期間的勾選狀態即時同步。
整個過程約 10 分鐘，不需要輸入信用卡（Firestore 的免費額度 Spark 方案足夠這個 App 使用）。

如果你不想設定 Firebase，也完全沒關係：`assets/js/firebase-config.js` 預設是
`firebaseConfig = null`，App 會自動用「本機模式」運作（勾選只存在自己手機的瀏覽器裡，
右上角同步狀態顯示 ⚪local）。想同步時，照著下面步驟做即可，不影響其他功能。

---

## 步驟 1：建立 Firebase 專案

1. 瀏覽器開啟 <https://console.firebase.google.com/>，用 Google 帳號登入。
2. 點「建立專案」（Create a project / 新增專案）。
3. 專案名稱可以隨意取，例如 `chan7-2026`。
4. 是否啟用 Google Analytics：**選「不啟用」**即可（不需要）。
5. 等待專案建立完成，進入專案總覽頁。

---

## 步驟 2：建立 Firestore Database

1. 左側選單點「建構」（Build）→「Firestore Database」。
2. 點「建立資料庫」（Create database）。
3. 位置（location）選離美國中部近的區域即可（例如 `us-central`），之後不能更改，但這個
   App 用量很小，選哪個區域差異不大。
4. 安全性規則先選「正式環境模式」（Production mode）或「測試模式」皆可 —— 反正
   **步驟 4** 會用專案內的 `firestore.rules` 檔案整個覆蓋掉，所以這裡選什麼不重要。
5. 點「建立」，等待資料庫建立完成。

---

## 步驟 3：啟用「匿名登入」

App 需要先匿名登入才能讀寫 Firestore（不用註冊帳號、不用輸入任何個人資料）。

1. 左側選單「建構」（Build）→「Authentication」。
2. 第一次進入會要你點「開始使用」（Get started）。
3. 上方分頁選「Sign-in method」（登入方式）。
4. 在供應商清單中找到「匿名」（Anonymous），點進去，右上角切換開關打開，按「儲存」。

---

## 步驟 4：貼上安全規則（firestore.rules）

1. 回到「Firestore Database」頁面。
2. 上方分頁選「規則」（Rules）。
3. 把專案根目錄的 `firestore.rules` 檔案內容**整份覆蓋貼上**（取代編輯框裡原本的內容）。
4. 點「發布」（Publish）。

這份規則只允許「已登入的使用者」讀寫 `retreats/chan7-2026/checks/` 底下的勾選文件，
而且寫入時只能動 `checkedBy`、`updatedAt` 欄位、不能刪除文件，避免資料被誤改或亂寫。

---

## 步驟 5：新增網頁應用程式，取得 config

1. 左側選單最上方，點專案名稱旁的齒輪圖示 ⚙️ →「專案設定」（Project settings）。
2. 頁面往下捲到「你的應用程式」（Your apps）。
3. 點網頁圖示 `</>`（Add app → Web）。
4. 應用程式暱稱隨意填（例如 `chan7-web`），**不需要**勾選「同時為此應用程式設定
   Firebase Hosting」。
5. 點「註冊應用程式」（Register app）後，畫面會顯示一段程式碼，裡面有：

   ```js
   const firebaseConfig = {
     apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     storageBucket: "your-project.firebasestorage.app",
     messagingSenderId: "123456789012",
     appId: "1:123456789012:web:xxxxxxxxxxxxxxxxxxxxxx",
   };
   ```

   把這整個物件複製起來（之後隨時可以在「專案設定」頁面下方的「你的應用程式」
   區塊再找到）。

---

## 步驟 6：把 config 貼進專案

打開專案裡的 `assets/js/firebase-config.js`，把最後一行：

```js
export const firebaseConfig = null;
```

改成（把 `{ ... }` 換成你剛剛複製的那份物件）：

```js
export const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:xxxxxxxxxxxxxxxxxxxxxx",
};
```

存檔後，`git commit` + `git push` 到 `main` 分支，GitHub Actions 會自動重新
build、部署到 GitHub Pages。

> 這些 config 值（`apiKey` 等）本來就是設計給瀏覽器端公開使用的識別碼，不是密碼，
> 放進前端程式碼、提交到公開的 GitHub repo 是 Firebase 官方文件建議的正常用法。
> 真正的存取控制是靠步驟 4 的 `firestore.rules`（只有匿名登入後的使用者能讀寫，
> 且只能寫指定欄位）。

---

## 步驟 7：確認同步狀態

重新整理網頁後，右上角的同步狀態小圓點應該會從 ⚪local（本機模式）
變成 🟡pending（連線中）→ 🟢synced（已同步）。
如果手機沒有網路，會顯示 🔴offline，這時勾選仍會照常運作，恢復連線後會自動補送。

法輝、法偉兩支手機都要完成「步驟 6」（貼上**同一份** config、部署後打開網頁）
才會看到彼此的勾選。

---

## 常見問題

**Q: 兩人要各自申請一個 Firebase 專案嗎？**
不用，只要其中一人申請一個專案，把同一份 `firebaseConfig` 貼進程式碼、部署上線，
兩人打開的是「同一個網站」，自然會連到同一個 Firebase 專案。

**Q: 免費額度夠用嗎？**
這個 App 的讀寫量非常小（勾選次數頂多幾百次），遠低於 Firestore Spark（免費）方案
每日額度，正常使用不會產生費用，也不需要綁信用卡。

**Q: 想關閉同步、恢復本機模式怎麼辦？**
把 `assets/js/firebase-config.js` 的 config 改回 `export const firebaseConfig = null;`
即可，不需要刪除 Firebase 專案。

**Q: 要不要把 `firestore.rules` 之外的其他 Firebase 設定也調整？**
不需要。這個 App 只用到 Firestore（存勾選）和 Authentication 的匿名登入，
其他服務（Hosting、Storage、Functions…）都不會用到，不用理會。
