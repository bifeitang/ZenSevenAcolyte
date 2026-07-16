// assets/js/firestore-sync.js
//
// 統一同步介面（見 DESIGN.md 3.4 節）：
//   initSync({ retreatId, identity, onChecksChanged, onStatusChanged })
//   toggleCheck(taskId, identity, checked)
//
// 依 assets/js/firebase-config.js 的 firebaseConfig 決定後端：
//   firebaseConfig === null → LocalBackend   （localStorage + storage 事件）
//   firebaseConfig !== null → FirestoreBackend（Firestore 即時同步 + 離線持久化）
//
// 兩種後端行為完全一致，呼叫端（app.js）不需要知道目前是哪一種。

import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_SDK_VERSION = "11.6.1";
const GSTATIC_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

const LOCAL_STORAGE_KEY = "chan7.checks";

const IDENTITIES = ["fahui", "fawei"];

/**
 * checkedBy 補齊 fahui/fawei 兩個欄位，缺的欄位補 { checked:false, at:null }，
 * 讓呼叫端不需要自己判斷欄位是否存在。
 */
function normalizeCheckedBy(checkedBy) {
  const result = {};
  for (const id of IDENTITIES) {
    result[id] = (checkedBy && checkedBy[id]) || { checked: false, at: null };
  }
  return result;
}

// ────────────────────────────────────────────────────────────────
// LocalBackend：純 localStorage，供未設定 Firebase 的使用者離線使用。
// ────────────────────────────────────────────────────────────────

class LocalBackend {
  constructor() {
    this._onChecksChanged = null;
    this._onStatusChanged = null;
    this._storageListener = null;
  }

  async init({ onChecksChanged, onStatusChanged }) {
    this._onChecksChanged = onChecksChanged;
    this._onStatusChanged = onStatusChanged;

    // 同瀏覽器的「其他」分頁修改 localStorage 時會收到 storage 事件；
    // 目前分頁自己寫入不會觸發 storage 事件，因此 toggleCheck() 內會手動 emit。
    this._storageListener = (event) => {
      if (event.key !== LOCAL_STORAGE_KEY) return;
      this._emit();
    };
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("storage", this._storageListener);
    }

    this._emit();
    this._onStatusChanged?.("local");
  }

  _readAll() {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const normalized = {};
      for (const taskId of Object.keys(parsed)) {
        normalized[taskId] = normalizeCheckedBy(parsed[taskId]);
      }
      return normalized;
    } catch (err) {
      console.error("[firestore-sync] LocalBackend 讀取 localStorage 失敗", err);
      return {};
    }
  }

  _writeAll(checks) {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(checks));
  }

  _emit() {
    this._onChecksChanged?.(this._readAll());
  }

  async toggleCheck(taskId, identity, checked) {
    const checks = this._readAll();
    const existing = checks[taskId] || normalizeCheckedBy(null);
    checks[taskId] = {
      ...existing,
      [identity]: { checked, at: Date.now() },
    };
    this._writeAll(checks);
    this._emit();
    this._onStatusChanged?.("local");
  }
}

// ────────────────────────────────────────────────────────────────
// FirestoreBackend：即時同步 + 離線持久化。
// ────────────────────────────────────────────────────────────────

class FirestoreBackend {
  constructor() {
    this._retreatId = null;
    this._onChecksChanged = null;
    this._onStatusChanged = null;
    this._db = null;
    this._fs = null; // { doc, setDoc, serverTimestamp }
    this._unsubscribe = null;
  }

  async init({ retreatId, identity, onChecksChanged, onStatusChanged }) {
    this._retreatId = retreatId;
    this._onChecksChanged = onChecksChanged;
    this._onStatusChanged = onStatusChanged;

    this._onStatusChanged?.("pending");

    let appApi, authApi, fsApi;
    try {
      [appApi, authApi, fsApi] = await Promise.all([
        import(`${GSTATIC_BASE}/firebase-app.js`),
        import(`${GSTATIC_BASE}/firebase-auth.js`),
        import(`${GSTATIC_BASE}/firebase-firestore.js`),
      ]);
    } catch (err) {
      console.error("[firestore-sync] Firebase SDK 載入失敗，視為離線", err);
      this._onStatusChanged?.("offline");
      return;
    }

    const { initializeApp } = appApi;
    const { getAuth, signInAnonymously } = authApi;
    const {
      initializeFirestore,
      getFirestore,
      persistentLocalCache,
      persistentMultipleTabManager,
      collection,
      doc,
      setDoc,
      onSnapshot,
      serverTimestamp,
    } = fsApi;

    this._fs = { doc, setDoc, serverTimestamp };

    const app = initializeApp(firebaseConfig);

    // 開啟離線持久化：優先使用新版 persistentLocalCache API；
    // 若目前載入的 SDK 版本沒有這個 export（理論上 11.6.1 有），退回 getFirestore()。
    try {
      if (typeof persistentLocalCache === "function") {
        this._db = initializeFirestore(app, {
          localCache: persistentLocalCache({
            tabManager:
              typeof persistentMultipleTabManager === "function"
                ? persistentMultipleTabManager()
                : undefined,
          }),
        });
      } else {
        this._db = getFirestore(app);
      }
    } catch (err) {
      console.warn(
        "[firestore-sync] 離線持久化初始化失敗，改用預設（無持久化）Firestore 實例",
        err
      );
      this._db = getFirestore(app);
    }

    const auth = getAuth(app);
    try {
      await signInAnonymously(auth);
    } catch (err) {
      console.error("[firestore-sync] 匿名登入失敗", err);
      this._onStatusChanged?.("offline");
      return;
    }

    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("offline", () => this._onStatusChanged?.("offline"));
      window.addEventListener("online", () => this._onStatusChanged?.("pending"));
    }

    const checksCol = collection(this._db, "retreats", this._retreatId, "checks");

    this._unsubscribe = onSnapshot(
      checksCol,
      { includeMetadataChanges: true },
      (snapshot) => {
        const checksMap = {};
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          checksMap[docSnap.id] = normalizeCheckedBy(data.checkedBy);
        });
        this._onChecksChanged?.(checksMap);

        if (snapshot.metadata.hasPendingWrites) {
          this._onStatusChanged?.("pending");
        } else if (snapshot.metadata.fromCache) {
          this._onStatusChanged?.("offline");
        } else {
          this._onStatusChanged?.("synced");
        }
      },
      (err) => {
        console.error("[firestore-sync] onSnapshot 錯誤", err);
        this._onStatusChanged?.("offline");
      }
    );
  }

  async toggleCheck(taskId, identity, checked) {
    if (!this._db) {
      throw new Error("[firestore-sync] Firestore 尚未初始化完成，無法寫入");
    }
    const { doc, setDoc, serverTimestamp } = this._fs;
    const ref = doc(this._db, "retreats", this._retreatId, "checks", taskId);
    try {
      // 注意：dot-path（"checkedBy.xxx"）只有 updateDoc 支援；setDoc+merge 會把它
      // 當成字面欄位名，違反 firestore.rules 的 hasOnly 而被拒。改用巢狀物件——
      // setDoc 的 merge 對巢狀 map 深度合併，只更新自己的 checkedBy.{identity}，
      // 不會覆蓋對方的欄位，雙人仍零寫入衝突。
      await setDoc(
        ref,
        {
          taskId,
          checkedBy: { [identity]: { checked, at: Date.now() } },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (err) {
      console.error("[firestore-sync] toggleCheck 寫入失敗", err);
      this._onStatusChanged?.("offline");
      throw err;
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 對外統一介面
// ────────────────────────────────────────────────────────────────

let _backend = null;

export async function initSync({ retreatId, identity, onChecksChanged, onStatusChanged }) {
  _backend = firebaseConfig ? new FirestoreBackend() : new LocalBackend();
  await _backend.init({ retreatId, identity, onChecksChanged, onStatusChanged });
  return _backend;
}

export async function toggleCheck(taskId, identity, checked) {
  if (!_backend) {
    throw new Error("[firestore-sync] 尚未呼叫 initSync()，無法 toggleCheck()");
  }
  return _backend.toggleCheck(taskId, identity, checked);
}

// 供測試使用（非公開契約的一部分，app.js 不應依賴這個 export）。
export const _internal = { LocalBackend, FirestoreBackend, normalizeCheckedBy };
