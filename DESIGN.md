# 2026 禪七心燈流程 App — 設計契約（DESIGN.md）

本文件是所有實作 worker 的**統一契約**。任何檔案介面、資料結構、命名以此為準。
UI 文案一律**繁體中文**。程式碼為 plain JavaScript（ESM）與 Python 3，**不用 TypeScript、不用 bundler**。

## 0. 專案背景

兩位心燈（法輝 `fahui`、法偉 `fawei`）在 2026/7/18–7/25 禪七中依時間表執行任務。
來源資料：`/Users/huyang/Documents/禅七/2026禪七逐日心燈流程 v1.xlsx`（8 分頁）。
產品：PWA（GitHub Pages 靜態站）+ Firestore 勾選同步 + webcal 訂閱 .ics 提醒。

- 法偉只參與 7/18–7/21；7/22–7/25 法輝單獨。
- **已知資料修正**：第八日（7/25）分頁中負責人「法偉」為範本殘留，一律改為 `fahui`，並記錄到 `schedule/REVIEW.md` 供使用者核對。
- 時區：`America/Chicago`（待使用者最終確認，全部從 meta.json 讀取，不得硬編碼）。

## 1. 目錄結構

```
chan7-app/
├── DESIGN.md                     # 本文件
├── index.html                    # PWA app shell（root，build 時複製進 public/）
├── manifest.webmanifest
├── sw.js
├── assets/
│   ├── css/app.css
│   ├── vendor/alpine.min.js      # 本地 vendor（離線可靠），Alpine.js 3.x
│   └── js/
│       ├── app.js                # 主 Alpine 元件 + 渲染 + now/next 倒數
│       ├── resolve.js            # 純函數：schedule 資料解析輔助
│       ├── pin-gate.js           # PIN 驗證
│       ├── firebase-config.js    # export const firebaseConfig = null（使用者之後貼入）
│       └── firestore-sync.js     # 同步層（Firestore 或 local 模式）
├── schedule/                     # ✅ 單一事實來源（人工可直接編輯）
│   ├── meta.json
│   ├── fixed-actions.json
│   ├── prep-checklist.json       # 布場分頁（物料清單）
│   ├── REVIEW.md                 # 轉換時的異常/修正清單，供使用者核對
│   └── day-2026-07-18.json … day-2026-07-25.json（共 8 個）
├── schema/
│   ├── day.schema.json           # JSON Schema draft-07
│   └── meta.schema.json
├── scripts/
│   ├── xlsx_to_schedule.py       # 一次性轉換（僅 Python 標準庫：zipfile + ElementTree）
│   ├── build.mjs                 # schedule/* → public/（含驗證）
│   └── generate_ics.mjs          # schedule/* → public/retreat.ics
├── public/                       # build 輸出（git-ignore 除外亦可提交；CI 會重建）
├── firestore.rules
├── package.json                  # devDeps: ics, ajv（僅腳本用）
├── .gitignore                    # node_modules/
└── .github/workflows/deploy.yml
```

## 2. Schedule JSON Schema（權威定義）

### 2.1 `meta.json`

```jsonc
{
  "retreatId": "chan7-2026",
  "timezone": "America/Chicago",
  "scheduleVersion": "2026-07-16T12:00:00-05:00",
  "owners": {
    "fahui":     { "displayName": "法輝", "color": "#3b5bdb" },
    "fawei":     { "displayName": "法偉", "color": "#e8590c" },
    "attendant": { "displayName": "侍者", "color": "#868e96" },
    "server":    { "displayName": "行堂", "color": "#868e96" },
    "duty":      { "displayName": "監香", "color": "#868e96" },
    "volunteer": { "displayName": "義工", "color": "#868e96" },
    "all":       { "displayName": "全體", "color": "#868e96" },
    "other":     { "displayName": "其他", "color": "#868e96" }
  },
  "defaultLeadMinutes": 7,
  "defaultEventDurationMinutes": 1,
  "icsFuzzyStrategy": "anchor"
}
```

負責人正規化對照：法輝→fahui、法偉→fawei、侍者→attendant、行堂→server、監香/總監香→duty、義工→volunteer、全體→all、其他無法對應者→other（`ownerRaw` 保留原文，UI 顯示 ownerRaw）。「法然」等個別人名 → other。一格多人（換行/頓號分隔）→ owners 陣列多個值。

### 2.2 `day-YYYY-MM-DD.json`

```jsonc
{
  "date": "2026-07-18",
  "dayIndex": 1,
  "label": "第一日 · 7/18（六）起七日",
  "participants": ["fahui", "fawei"],
  "sections": [
    {
      "id": "d1-sec-1",
      "title": "報到 · 佈場",           // 去掉【】括號
      "timePoints": [ /* TimePoint[] */ ]
    }
  ]
}
```

### 2.3 TimePoint

```jsonc
{
  "id": "d1-tp-04",
  "time": {
    "kind": "exact",              // "exact" | "range" | "fuzzy"
    "value": "10:00",             // exact/range 必填，"HH:MM" 24 小時制
    "rangeEnd": null,             // 僅 range："16:00"
    "raw": "0.4166666666666667",  // 原始儲存格內容字串
    "anchorTimePointId": null,    // 僅 fuzzy：同日最近「前一個」exact/range TimePoint 的 id；若無則 null
    "offsetMinutes": null         // 僅 fuzzy：估計偏移分鐘（擊鼓時≈+2、開靜後≈+40；不確定可 null）
  },
  "isBellRow": false,             // 時段/香次 為「地鐘」→ true
  "periodLabel": "基本行儀",       // B 欄（時段/香次），可為 null
  "leadMinutesOverride": null,    // 覆寫提前提醒分鐘數（起七/解七/施食等由人工後續調整）
  "tasks": [ /* Task[] */ ]
}
```

fuzzy `value` 為 null，`raw` 存原文（如「擊鼓時」「開靜後」「前一晚」「事先」「下午」）。
`raw` 為「前一晚」「事先」「下午」者：`anchorTimePointId: null`（不產生 ics 事件）。

### 2.4 Task

```jsonc
{
  "id": "d1-tp-04-t1",            // {timePointId}-t{序號從1}
  "action": "確認圖書館(英)與舊禪堂(中)基本行儀場地；…",
  "templateRef": null,            // 動作含「同固定動作」→ "fixed:sitting-cycle"
  "owners": ["fahui", "fawei"],
  "ownerRaw": "法輝\n法偉",        // 原文；空白格 → "" 且 owners: []
  "signal": "前 3 分",             // E 欄，可 null
  "note": "新禪堂 ➡️ 寮房 …"       // F 欄，可 null
}
```

### 2.5 `fixed-actions.json`

```jsonc
[
  { "id": "fixed:sitting-start-8min", "title": "坐香 · 前 8 分", "text": "上香（依段）、開燈、開空調（約 75–76°F 或依實況）、測音響（法會/開示時）" },
  { "id": "fixed:sitting-bell-3min",  "title": "坐香 · 前 3 分", "text": "敲地鐘（各日表已獨立成列）" },
  { "id": "fixed:still-lights-off",   "title": "悅眾『止靜』後", "text": "關燈（留佛前燈）、禪堂關門" },
  { "id": "fixed:open-lights-on",     "title": "維那『開靜』後", "text": "開燈、開禪堂門" },
  { "id": "fixed:walking-end",        "title": "行香 / 跑香結束", "text": "上香 → 關燈" },
  { "id": "fixed:sitting-cycle",      "title": "每支香標準流程", "text": "坐香 37 分開靜；長香 43 分開靜（不跑香）；每支香 37 分起座、放腿 3 分、行香 5 分。前 8 分上香開燈開空調；止靜關燈；開靜開燈開門；行香後上香關燈" }
]
```

（實際內容以 xlsx「固定動作（每支香）」分頁為準，parser 產生；上為結構示意。任務動作文字含「同固定動作」或「固定動作（…）」→ `templateRef: "fixed:sitting-cycle"`。）

### 2.6 `prep-checklist.json`（布場分頁）

```jsonc
[ { "id": "prep-1", "location": "新禪堂", "item": "主法拜墊", "note": null } ]
```

### 2.7 ID 穩定性紀律（寫進 REVIEW.md 開頭給使用者看）

改版時**不可改動既有 id**（ics UID 與 Firestore 勾選皆以 id 為 key）；新增項用新 id，刪除項直接刪。

## 3. 模組介面契約（JS）

全部 ESM。Alpine 3.x 從 `assets/vendor/alpine.min.js` 載入（實作時用 curl 從 https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js 下載 vendor）。

### 3.1 `resolve.js`（純函數，無副作用，node 與瀏覽器皆可 import）

```js
export function ownerChips(task, meta)      // → [{key, displayName, color, isPrimary}]  isPrimary: fahui/fawei
export function timeBadge(tp)               // → {text, approx:boolean}  exact:"13:57" range:"15:00–16:00" fuzzy: raw + approx:true
export function resolveTemplate(task, fixedActions) // → string|null（templateRef 對應的 text）
export function flattenTimePoints(day)      // → [{section, timePoint}] 依原始順序
export function nextTimePoint(day, nowHHMM) // → {timePoint, section}|null  僅比較 kind=exact/range 的 value > nowHHMM，取最小
export function todayDate(tzNow)            // 傳入 Date → "YYYY-MM-DD"（以 meta.timezone 計）
```

### 3.2 `pin-gate.js`

```js
export const PIN_HASH = "<sha256 hex of default PIN '0718'>";  // 註解說明如何換 PIN
export async function checkPin(input)   // sha256(input) === PIN_HASH
export function isUnlocked() / setUnlocked()   // localStorage key: "chan7.unlocked"
```

### 3.3 `firebase-config.js`

```js
// 使用者建立 Firebase 專案後，把 console 給的 config 物件貼進來：
export const firebaseConfig = null;   // null = 本機模式（localStorage），非 null = Firestore 模式
```

### 3.4 `firestore-sync.js`

```js
// 統一介面，兩種後端：firebaseConfig 為 null → LocalBackend（localStorage + storage 事件），否則 FirestoreBackend
export async function initSync({ retreatId, identity, onChecksChanged, onStatusChanged })
//   identity: "fahui"|"fawei"
//   onChecksChanged(checksMap): { [taskId]: { fahui:{checked,at}, fawei:{checked,at} } }
//   onStatusChanged(status): "synced"|"pending"|"offline"|"local"
export async function toggleCheck(taskId, identity, checked)
//   Firestore: setDoc(merge) 於 retreats/{retreatId}/checks/{taskId}，dot-path 只寫 checkedBy.{identity}
```

Firestore 模式：`signInAnonymously` → `onSnapshot(collection)` 即時監聽；`enableIndexedDbPersistence`（或新版 `persistentLocalCache`）開離線持久化。SDK 用 `https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js`、`firebase-auth.js`、`firebase-firestore.js` ESM import（sw.js runtime-cache 這些 URL）。
LocalBackend：localStorage key `chan7.checks`，同瀏覽器多分頁用 `storage` 事件同步；狀態回報 `"local"`。

### 3.5 `app.js`（Alpine root 元件 `chan7App()`）

State：`unlocked, identity, meta, days[], fixedActions, activeDate, checks, syncStatus, now`
Views：PIN 畫面 → 身份選擇 → 主畫面（頁籤 + now/next 卡 + 時間軸）＋設定抽屜。
- 啟動：fetch `data/schedule.json`（network-first，失敗用 cache，SW 負責）；比對 localStorage 快取的 `scheduleVersion`，不同 → 頂部顯示「流程已更新」提示條（點擊 reload）。
- 每 30 秒 tick 更新 now/next 倒數。
- checkbox 點擊：樂觀更新 `checks` → `toggleCheck()`。
- 設定抽屜：webcal 訂閱連結（`webcal://{location.host}{basePath}/retreat.ics`）+ 訂閱教學 + 身份切換 + 版本資訊。

### 3.6 `index.html`

單頁，`<script type="module">` 引入 app.js，`x-data="chan7App()"`。`<meta name="viewport">`、`apple-mobile-web-app-capable`、`apple-touch-icon`（用內嵌 SVG→PNG 產一個簡單燈形 icon，180px，放 assets/icon-180.png；manifest 引用 192/512 版）。

### 3.7 `sw.js`

- `CACHE_NAME = "chan7-v1"`。install：precache app shell（index.html、css、js、vendor、manifest、icons）。
- fetch 策略：`data/schedule.json` → network-first + cache fallback；同源其他 → cache-first + 背景更新（stale-while-revalidate）；`www.gstatic.com/firebasejs` → cache-first（immutable 版本化 URL）。`retreat.ics` 不快取。

## 4. UI 視覺規格（app.css）

- 設計 token：`--fahui:#3b5bdb; --fawei:#e8590c; --neutral:#868e96; --bell-bg:#fff9db; --bell-border:#fab005;`
- 淺色為主，`prefers-color-scheme: dark` 提供深色（背景 #1a1b1e、卡片 #25262b，主色微調亮）。
- 字體：system-ui / -apple-system；基準 16px；時間徽章 tabular-nums 加粗。
- 版面：max-width 640px 置中；日頁籤水平捲動 pill（當日高亮）；section 標題 sticky（`【` `】`樣式重現）；時間點卡片：左欄 64px 時間徽章，右欄任務列。
- 任務列：負責人色點＋名字（小 chip，底色 = owner color 15% 透明、文字 = owner color）；動作文字換行完整顯示；signal 為淺灰 badge；note 為 13px 灰字完整顯示；checkbox 44×44 觸控區，右側對齊。對方已勾 → checkbox 外環用對方顏色；自己勾 → 填色 = 自己顏色；雙方勾 → 雙色。
- `isBellRow` 卡片：左邊框 3px `--bell-border`、背景 `--bell-bg`（深色模式降飽和）。
- now/next 卡：頂部常駐，大字倒數（mm:ss 或 h:mm），顯示下一時間點時間、periodLabel、任務前 2 條摘要。
- 同步狀態：右上角小圓點 🟢synced/🟡pending/🔴offline/⚪local + 文字。

## 5. `generate_ics.mjs` 規格

- 讀 `schedule/meta.json` + 全部 day json。**不用 `ics` npm 套件**（其 VTIMEZONE/VALARM 支援不完整）——直接字串產生 iCalendar，較可控。行摺疊：每行 ≤75 octets（RFC 5545 folding，UTF-8 安全切分）。
- VCALENDAR：`VERSION:2.0`、`PRODID:-//chan7-2026//lampkeeper//ZH`、`CALSCALE:GREGORIAN`、`METHOD:PUBLISH`、`X-WR-CALNAME:2026 禪七心燈流程`、`X-WR-TIMEZONE:{tz}`、`X-PUBLISHED-TTL:PT15M`。
- 內嵌 `VTIMEZONE` for America/Chicago（CST/CDT 標準規則，寫死正確的 DST RRULE 區塊即可）。
- 每個 exact/range TimePoint → VEVENT：
  - `UID:{timePointId}@chan7-2026`、`DTSTAMP`（用 scheduleVersion 轉 UTC，保持可重現）、`DTSTART;TZID={tz}:{date}T{HHMM}00`、DTEND = range ? rangeEnd : start+defaultEventDurationMinutes。
  - `SUMMARY:{sectionTitle}｜{periodLabel 或首任務 action 前 20 字}`；地鐘列 SUMMARY 加前綴「🔔 」。
  - `DESCRIPTION`：該時間點全部任務逐行 `【負責人】動作（信號）— 備註`，`\n` 逸出為 `\\n`。
  - VALARM×2：`ACTION:DISPLAY` + `TRIGGER:PT0S`；`TRIGGER:-PT{lead}M`（lead = leadMinutesOverride ?? defaultLeadMinutes）。DESCRIPTION 同 SUMMARY。
- fuzzy 且 anchorTimePointId 非 null 且 icsFuzzyStrategy="anchor" → 錨定時間+offset（offset null 則 +0）產 VEVENT，SUMMARY 前綴「≈ 」，僅 1 個準點 VALARM。anchor 為 null → 略過。
- 另支援 `--test-in-minutes N`：產生 `public/test-alarm.ics`（單一事件 N 分鐘後，帶雙 VALARM），供真機通知演練。

## 6. `build.mjs` 規格

1. 讀 schema/*.json，用 ajv 驗證 meta 與 8 個 day 檔（額外自訂檢查：id 唯一性、fuzzy anchor 存在、templateRef 存在於 fixed-actions、owners 值合法）。失敗 → 非零退出並列出錯誤。
2. 合併輸出 `public/data/schedule.json`：`{ meta, fixedActions, prepChecklist, days:[…8 天] }`。
3. 複製 app shell（index.html、manifest、sw.js、assets/**）到 public/。
4. 呼叫 generate_ics.mjs 邏輯（import 其 export 的 `generateIcs()`）寫 `public/retreat.ics`。
5. `package.json` scripts：`"build": "node scripts/build.mjs"`。

## 7. `firestore.rules`

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /retreats/chan7-2026/checks/{taskId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.taskId == taskId
        && request.resource.data.keys().hasOnly(['taskId','checkedBy','updatedAt']);
      allow update: if request.auth != null
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['checkedBy','updatedAt']);
      allow delete: if false;
    }
  }
}
```

## 8. `deploy.yml`

push to main → checkout → setup-node 22 → `npm ci` → `npm run build` → upload `public/` → deploy GitHub Pages（`actions/configure-pages` + `actions/upload-pages-artifact` + `actions/deploy-pages`，permissions: pages write, id-token write）。

## 9. Parser（xlsx_to_schedule.py）要點

- 僅標準庫。解析 `xl/worksheets/sheet{2,3,4,5}.xml`（第一/二/三～七/八日）、sheet6（固定動作）、sheet7（布場）、sharedStrings、**`mergeCells`**（合併範圍需 forward-fill 值到整個範圍的首欄位置意義上——實務：某 cell 落在合併範圍內且非左上角 → 取左上角值）。
- 每張日表：跳過表頭 2 列；A 欄含【…】→ 新 section；A 欄有值（時間）→ 新 TimePoint（時間分類：數字分數→HH:MM exact、"HH:MM" exact、"HH:MM–HH:MM" 或含 en-dash/換行的範圍→range、其他文字→fuzzy）；A 欄空 → task 併入目前 TimePoint。C 欄（動作）為 task 主體；某列 C 欄也空則跳過（純格式列）。
- fuzzy anchor：同 section 內往前找最近 exact/range TimePoint id；「擊鼓時」offset=2、「開靜後」offset=40、其餘 null。「前一晚/事先/下午」anchor=null。
- 第三～七日：以 sheet4 主表展開為 7/20–7/24 五個檔（id 前綴 d3..d7），再依表尾「當日差異對照」在 REVIEW.md 中記錄差異說明（開示/小參/長香），並將可機械套用者套用：7/23、7/24 的小參已在主表備註中，無需結構改動；差異主要影響 participants（7/22–24 僅 fahui）與備註，全文照抄主表即可。**7/22–25 的 participants 僅 ["fahui"]**；7/18–21 為兩人。
- 第八日：負責人「法偉」→ 改 `fahui`，ownerRaw 保留原文，REVIEW.md 記錄每一處（列位置＋原文）。
- 輸出：schedule/ 下全部 json + REVIEW.md（異常清單：無法分類的時間、無法正規化的負責人、法偉修正處、第三～七日展開說明、ID 紀律說明）。
- dayIndex：7/18=1 … 7/25=8。TimePoint id：`d{dayIndex}-tp-{兩位序號}`（全日連續編號）。section id：`d{dayIndex}-sec-{序號}`。

## 10. 驗收清單（Verify phase 用）

1. `python3 scripts/xlsx_to_schedule.py` 可重跑且冪等。
2. `npm install && npm run build` 成功；ajv 0 錯誤；public/ 結構完整。
3. `python3 -c "icalendar 往返解析 retreat.ics"`（pip 無 icalendar 則用自寫檢查：UID 唯一、每 VEVENT 有 2 VALARM（≈ 事件 1 個）、行長 ≤75 octets、DTSTART 帶 TZID、總事件數與 exact/range TimePoint 數吻合）。
4. `node --input-type=module -e "import('./assets/js/resolve.js')"` 各純函數單元自測（nextTimePoint 邊界：日首/日末/fuzzy 忽略）。
5. 本機 `python3 -m http.server -d public` + 瀏覽器驗證（由 Advisor 主迴圈執行）。
