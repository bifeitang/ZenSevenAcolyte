// assets/js/app.js — 主 Alpine 元件（DESIGN.md 3.5）。
// 對同步層只透過 firestore-sync.js 匯出的 initSync/toggleCheck 介面呼叫（見 DESIGN.md 3.4），
// 本檔不實作同步邏輯本身。

import * as resolve from "./resolve.js";
import { checkPin, isUnlocked, setUnlocked } from "./pin-gate.js";
import { initSync, toggleCheck as syncToggleCheck } from "./firestore-sync.js";

const IDENTITY_KEY = "chan7.identity";
const VERSION_KEY = "chan7.scheduleVersion";

/** 把「YYYY-MM-DD」+「HH:MM」+ IANA 時區轉成正確的 UTC Date（處理 DST）。 */
function zonedTimeToDate(dateStr, hhmm, timeZone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const asZoned = new Date(guess.toLocaleString("en-US", { timeZone }));
  const asUTC = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  const diff = asUTC.getTime() - asZoned.getTime();
  return new Date(guess.getTime() + diff);
}

/** 取得指定時區的目前時刻 "HH:MM"（24 小時制，zero-padded）。 */
function formatHHMMInZone(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(date).replace(/^24:/, "00:");
}

function chan7App() {
  return {
    // ---------- state（DESIGN.md 3.5）----------
    unlocked: false,
    identity: null,
    meta: null,
    days: [],
    fixedActions: [],
    prepChecklist: [],
    activeDate: null,
    checks: {},
    syncStatus: "local",
    now: new Date(),

    // ---------- 輔助 UI state ----------
    pinInput: "",
    pinError: false,
    showPast: false,
    loadError: false,
    updateAvailable: false,
    settingsOpen: false,
    _tickTimer: null,

    // ---------- 啟動 ----------
    async init() {
      this.unlocked = isUnlocked();
      try {
        this.identity = localStorage.getItem(IDENTITY_KEY) || null;
      } catch {
        this.identity = null;
      }

      // 排練模式：URL 帶 ?simnow=2026-07-18T14:30 可模擬任意時刻（測試提醒/收合邏輯用）
      // 必須在 loadSchedule() 之前設定，否則「今天」的判定（自動選日）會用真實時間
      const simnow = new URLSearchParams(location.search).get("simnow");
      if (simnow) {
        const parsed = new Date(simnow);
        if (!Number.isNaN(parsed.getTime())) this._simNow = parsed;
      }
      this.now = this._simNow ?? new Date();

      await this.loadSchedule();

      if (this.unlocked && this.identity) {
        this.startSync();
      }

      this._tickTimer = setInterval(() => {
        this.now = this._simNow ?? new Date();
      }, 30000);
    },

    async loadSchedule() {
      try {
        const res = await fetch("data/schedule.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.meta = data.meta;
        this.fixedActions = data.fixedActions ?? [];
        this.prepChecklist = data.prepChecklist ?? [];
        this.days = data.days ?? [];
        this.loadError = false;

        let cachedVersion = null;
        try {
          cachedVersion = localStorage.getItem(VERSION_KEY);
        } catch {
          /* ignore */
        }
        if (cachedVersion && this.meta?.scheduleVersion && cachedVersion !== this.meta.scheduleVersion) {
          this.updateAvailable = true;
        }
        try {
          if (this.meta?.scheduleVersion) {
            localStorage.setItem(VERSION_KEY, this.meta.scheduleVersion);
          }
        } catch {
          /* ignore */
        }

        if (!this.activeDate) {
          const today = resolve.todayDate(this.now, this.meta?.timezone);
          this.activeDate = this.days.some((d) => d.date === today)
            ? today
            : this.days[0]?.date ?? null;
        }
      } catch (err) {
        this.loadError = true;
        console.error("[chan7] 讀取 data/schedule.json 失敗", err);
      }
    },

    // ---------- PIN / 身份 ----------
    async submitPin() {
      this.pinError = false;
      const ok = await checkPin(this.pinInput);
      if (ok) {
        setUnlocked();
        this.unlocked = true;
        this.pinInput = "";
        if (this.identity) this.startSync();
      } else {
        this.pinError = true;
        this.pinInput = "";
      }
    },

    pressPinKey(digit) {
      if (this.pinInput.length >= 8) return;
      this.pinInput += String(digit);
    },

    backspacePin() {
      this.pinInput = this.pinInput.slice(0, -1);
    },

    chooseIdentity(id) {
      this.identity = id;
      try {
        localStorage.setItem(IDENTITY_KEY, id);
      } catch {
        /* ignore */
      }
      this.startSync();
    },

    switchIdentity(id) {
      if (id === this.identity) return;
      this.chooseIdentity(id);
    },

    // ---------- 同步層（介面見 firestore-sync.js / DESIGN.md 3.4） ----------
    startSync() {
      if (!this.meta || !this.identity) return;
      this.syncStatus = "pending";
      initSync({
        retreatId: this.meta.retreatId,
        identity: this.identity,
        onChecksChanged: (checksMap) => {
          this.checks = checksMap ?? {};
        },
        onStatusChanged: (status) => {
          this.syncStatus = status;
        },
      }).catch((err) => {
        console.error("[chan7] initSync 失敗", err);
        this.syncStatus = "offline";
      });
    },

    async toggleTask(taskId) {
      if (!this.identity) return;
      const prevChecked = this.checks?.[taskId]?.[this.identity]?.checked ?? false;
      const nextChecked = !prevChecked;
      const at = new Date().toISOString();
      this.checks = {
        ...this.checks,
        [taskId]: {
          ...(this.checks[taskId] ?? {}),
          [this.identity]: { checked: nextChecked, at },
        },
      };
      try {
        await syncToggleCheck(taskId, this.identity, nextChecked);
      } catch (err) {
        console.error("[chan7] toggleCheck 失敗", err);
      }
    },

    otherIdentity() {
      return this.identity === "fahui" ? "fawei" : "fahui";
    },

    // 流程步驟編號：同一時間點內只對 display==='step' 的任務連續編號
    stepNo(timePoint, taskIndex) {
      let n = 0;
      for (let i = 0; i <= taskIndex; i++) {
        if (timePoint.tasks[i]?.display === "step") n++;
      }
      return n;
    },

    // 物料清單進度：任一人勾過即算完成一項
    itemProgress(task) {
      const items = task.items ?? [];
      const done = items.filter(
        (it) =>
          this.isCheckedBy(`${task.id}-${it.id}`, "fahui") ||
          this.isCheckedBy(`${task.id}-${it.id}`, "fawei")
      ).length;
      return `${done}/${items.length}`;
    },

    isCheckedBy(taskId, who) {
      return !!this.checks?.[taskId]?.[who]?.checked;
    },

    checkboxClasses(taskId) {
      const self = this.isCheckedBy(taskId, this.identity);
      const other = this.isCheckedBy(taskId, this.otherIdentity());
      return {
        "is-self-checked": self,
        "is-other-checked": other,
        "is-both-checked": self && other,
      };
    },

    checkboxStyle(taskId) {
      const selfColor = this.meta?.owners?.[this.identity]?.color ?? "#868e96";
      const otherColor = this.meta?.owners?.[this.otherIdentity()]?.color ?? "#868e96";
      return `--self-color:${selfColor}; --other-color:${otherColor};`;
    },

    // ---------- 頁籤 / 時間軸 ----------
    shortDateLabel(day) {
      const [, m, d] = day.date.split("-");
      return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
    },

    setActiveDate(date) {
      this.activeDate = date;
    },

    get activeDay() {
      return this.days.find((d) => d.date === this.activeDate) ?? null;
    },

    get activeSections() {
      return this.activeDay?.sections ?? [];
    },

    ownerChips(task) {
      return resolve.ownerChips(task, this.meta);
    },

    timeBadge(tp) {
      return resolve.timeBadge(tp);
    },

    resolveTemplate(task) {
      return resolve.resolveTemplate(task, this.fixedActions);
    },

    // ---------- now/next 卡 ----------
    // ---------- 已過時間點自動收合 ----------

    // 目前時間點：僅在「檢視的日期＝今天」時，取文件順序中最後一個已到時間的 exact/range 時間點
    get currentTpId() {
      if (!this.meta || this.activeDate !== this.todayStr) return null;
      const day = this.activeDay;
      if (!day) return null;
      const nowHHMM = this.nowHHMM;
      let cur = null;
      for (const s of day.sections) {
        for (const tp of s.timePoints) {
          const t = tp.time;
          if ((t.kind === "exact" || t.kind === "range") && t.value <= nowHHMM) cur = tp.id;
        }
      }
      return cur;
    },

    // 已過的時間點集合：文件順序中位於「目前時間點」之前的所有時間點
    get pastTpIds() {
      const curId = this.currentTpId;
      const ids = new Set();
      if (!curId) return ids;
      for (const s of this.activeDay.sections) {
        for (const tp of s.timePoints) {
          if (tp.id === curId) return ids;
          ids.add(tp.id);
        }
      }
      return ids;
    },

    isPastTp(tp) {
      return this.pastTpIds.has(tp.id);
    },

    sectionVisible(section) {
      if (this.showPast) return true;
      return section.timePoints.some((tp) => !this.pastTpIds.has(tp.id));
    },

    get todayStr() {
      if (!this.meta) return null;
      return resolve.todayDate(this.now, this.meta.timezone);
    },

    get nowHHMM() {
      if (!this.meta) return "00:00";
      return formatHHMMInZone(this.now, this.meta.timezone);
    },

    get nextInfo() {
      if (!this.meta || !this.days.length) return null;
      const sorted = [...this.days].sort((a, b) => a.date.localeCompare(b.date));
      const todayStr = this.todayStr;
      const nowHHMM = this.nowHHMM;
      const todayIdx = sorted.findIndex((d) => d.date === todayStr);
      const startIdx = todayIdx === -1 ? 0 : todayIdx;
      for (let i = startIdx; i < sorted.length; i++) {
        const day = sorted[i];
        const filterHHMM = i === startIdx && todayIdx !== -1 ? nowHHMM : "00:00";
        const found = resolve.nextTimePoint(day, filterHHMM);
        if (found) return { ...found, day };
      }
      return null;
    },

    get countdownText() {
      const info = this.nextInfo;
      if (!info || !this.meta) return "--:--";
      const target = zonedTimeToDate(info.day.date, info.timePoint.time.value, this.meta.timezone);
      const diffMs = target.getTime() - this.now.getTime();
      if (diffMs <= 0) return "00:00";
      const totalSeconds = Math.floor(diffMs / 1000);
      if (totalSeconds < 3600) {
        const mm = Math.floor(totalSeconds / 60);
        const ss = totalSeconds % 60;
        return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
      }
      const totalMinutes = Math.floor(totalSeconds / 60);
      const h = Math.floor(totalMinutes / 60);
      const mm = totalMinutes % 60;
      if (h < 24) return `${h} 時 ${mm} 分`;
      const d = Math.floor(h / 24);
      return `${d} 天 ${h % 24} 時 ${mm} 分`;
    },

    nextTaskSummaries() {
      const info = this.nextInfo;
      if (!info) return [];
      return (info.timePoint.tasks ?? []).slice(0, 2).map((t) => t.action.split("\n")[0]);
    },

    // ---------- 設定抽屜 ----------
    get webcalLink() {
      const basePath = location.pathname.replace(/index\.html$/, "").replace(/\/$/, "");
      return `webcal://${location.host}${basePath}/retreat.ics`;
    },

    get icsHttpLink() {
      const basePath = location.pathname.replace(/index\.html$/, "").replace(/\/$/, "");
      return `${location.origin}${basePath}/retreat.ics`;
    },

    identityLabel(id) {
      return this.meta?.owners?.[id]?.displayName ?? id;
    },

    identityColor(id) {
      return this.meta?.owners?.[id]?.color ?? "#868e96";
    },

    openSettings() {
      this.settingsOpen = true;
    },

    closeSettings() {
      this.settingsOpen = false;
    },

    reload() {
      location.reload();
    },
  };
}

document.addEventListener("alpine:init", () => {
  // eslint-disable-next-line no-undef
  Alpine.data("chan7App", chan7App);
});
