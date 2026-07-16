// assets/js/app.js — 主 Alpine 元件（DESIGN.md 3.5）。
// 對同步層只透過 firestore-sync.js 匯出的 initSync/toggleCheck 介面呼叫（見 DESIGN.md 3.4），
// 本檔不實作同步邏輯本身。

import * as resolve from "./resolve.js";
import { checkPin, isUnlocked, setUnlocked } from "./pin-gate.js";
import { initSync, toggleCheck as syncToggleCheck, saveEdit, deleteEdit } from "./firestore-sync.js";

// 編輯清單任務時，把文字重新拆成 items（鏡射 scripts/enrich_tasks.py 的簡化版規則）
function clientSplitItems(action) {
  const items = [];
  let n = 0;
  for (const rawline of (action ?? "").split(/[\n；;。]/)) {
    let line = rawline.trim().replace(/^[，,\s]+|[，,\s]+$/g, "");
    if (!line) continue;
    let group = null;
    const m = line.match(/^(新禪堂|舊禪堂|圖書館|齋堂|二樓|物料|其他)：\s*(.*)$/);
    if (m) {
      group = m[1];
      line = m[2].trim();
      if (!line) continue;
    }
    let parts = line.split("、").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 1 && (line.match(/，/g) ?? []).length >= 2) {
      parts = line.split("，").map((p) => p.trim()).filter(Boolean);
    }
    for (const text of parts) {
      n += 1;
      items.push({ id: `i${n}`, group, text });
    }
  }
  return items;
}

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
    editMode: false,
    edits: {},
    _rawDays: null,
    editor: null, // { kind:'task'|'add'|'time', tpId, taskId, action, note, signal, owners[], timeValue, isEdited }
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
        this._rawDays = data.days ?? [];
        this.applyEdits();
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
        onEditsChanged: (editsMap) => {
          this.edits = editsMap ?? {};
          this.applyEdits();
        },
      }).catch((err) => {
        console.error("[chan7] initSync 失敗", err);
        this.syncStatus = "offline";
      });
    },

    // ---------- 編輯模式 ----------

    // 把 edits（Firestore 同步的內容修改）套用到原始流程上，產生顯示用的 days
    applyEdits() {
      if (!this._rawDays) return;
      const days = JSON.parse(JSON.stringify(this._rawDays));
      const edits = this.edits ?? {};
      for (const day of days) {
        for (const section of day.sections) {
          for (const tp of section.timePoints) {
            const tpEdit = edits[tp.id];
            if (tpEdit?.kind === "tp-patch" && tpEdit.data) {
              if (tpEdit.data.timeValue) tp.time.value = tpEdit.data.timeValue;
              tp._edited = true;
            }
            tp.tasks = tp.tasks.flatMap((task) => {
              const e = edits[task.id];
              if (!e || e.kind !== "task-patch") return [task];
              if (e.data?.hidden) return [];
              const nt = { ...task, _edited: true };
              for (const f of ["action", "note", "signal", "owners"]) {
                if (e.data?.[f] !== undefined) nt[f] = e.data[f];
              }
              if (e.data?.action !== undefined) {
                // 內容改了：清單重拆項目；步驟丟棄舊 cue（顯示完整新文字）
                if (nt.display === "checklist") nt.items = clientSplitItems(nt.action);
                if (nt.display === "step") {
                  delete nt.cue;
                  delete nt.stepAction;
                }
              }
              return [nt];
            });
            // 新增的任務（附加在該時間點末尾）
            const adds = Object.values(edits)
              .filter((e) => e.kind === "task-add" && e.data?.tpId === tp.id)
              .sort((a, b) => (a.targetId < b.targetId ? -1 : 1));
            for (const a of adds) {
              tp.tasks.push({
                id: a.targetId,
                action: a.data.action ?? "",
                owners: a.data.owners ?? [],
                ownerRaw: "",
                templateRef: null,
                signal: a.data.signal ?? null,
                note: a.data.note ?? null,
                _edited: true,
                _added: true,
              });
            }
          }
          // 任務全被隱藏的時間點不顯示（可從設定「還原已隱藏任務」找回）
          section.timePoints = section.timePoints.filter((tp) => tp.tasks.length > 0);
        }
      }
      this.days = days;
    },

    openTaskEditor(task, tp) {
      this.editor = {
        kind: "task",
        tpId: tp.id,
        taskId: task.id,
        isAdded: !!task._added,
        isEdited: !!task._edited,
        action: task.action ?? "",
        note: task.note ?? "",
        signal: task.signal ?? "",
        owners: [...(task.owners ?? [])],
      };
    },

    openAddEditor(tp) {
      this.editor = {
        kind: "add",
        tpId: tp.id,
        taskId: null,
        action: "",
        note: "",
        signal: "",
        owners: [this.identity],
      };
    },

    openTimeEditor(tp) {
      if (tp.time.kind === "fuzzy") return; // 模糊時間點不支援改時間
      this.editor = {
        kind: "time",
        tpId: tp.id,
        taskId: null,
        timeValue: tp.time.value ?? "",
        isEdited: !!tp._edited,
      };
    },

    toggleEditorOwner(key) {
      const i = this.editor.owners.indexOf(key);
      if (i >= 0) this.editor.owners.splice(i, 1);
      else this.editor.owners.push(key);
    },

    async saveEditor() {
      const ed = this.editor;
      if (!ed) return;
      try {
        if (ed.kind === "task") {
          if (ed.isAdded) {
            // 修改「新增的任務」：直接覆寫原本的 task-add doc
            await saveEdit(ed.taskId, {
              targetId: ed.taskId,
              kind: "task-add",
              data: {
                tpId: ed.tpId,
                action: ed.action.trim(),
                note: ed.note.trim() || null,
                signal: ed.signal.trim() || null,
                owners: ed.owners,
              },
              updatedBy: this.identity,
            });
          } else {
            await saveEdit(ed.taskId, {
              targetId: ed.taskId,
              kind: "task-patch",
              data: {
                action: ed.action.trim(),
                note: ed.note.trim() || null,
                signal: ed.signal.trim() || null,
                owners: ed.owners,
                hidden: false,
              },
              updatedBy: this.identity,
            });
          }
        } else if (ed.kind === "add") {
          if (!ed.action.trim()) return;
          const newId = `${ed.tpId}-x${Date.now()}`;
          await saveEdit(newId, {
            targetId: newId,
            kind: "task-add",
            data: {
              tpId: ed.tpId,
              action: ed.action.trim(),
              note: ed.note.trim() || null,
              signal: ed.signal.trim() || null,
              owners: ed.owners,
            },
            updatedBy: this.identity,
          });
        } else if (ed.kind === "time") {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(ed.timeValue.trim())) return;
          await saveEdit(ed.tpId, {
            targetId: ed.tpId,
            kind: "tp-patch",
            data: { timeValue: ed.timeValue.trim() },
            updatedBy: this.identity,
          });
        }
        this.editor = null;
      } catch (err) {
        console.error("[chan7] 儲存編輯失敗", err);
        alert("儲存失敗，請確認網路與 Firestore 規則已更新");
      }
    },

    async hideEditorTask() {
      const ed = this.editor;
      if (!ed || ed.kind !== "task") return;
      try {
        if (ed.isAdded) {
          await deleteEdit(ed.taskId); // 新增的任務直接整筆移除
        } else {
          await saveEdit(ed.taskId, {
            targetId: ed.taskId,
            kind: "task-patch",
            data: { hidden: true },
            updatedBy: this.identity,
          });
        }
        this.editor = null;
      } catch (err) {
        console.error("[chan7] 隱藏任務失敗", err);
      }
    },

    async revertEditor() {
      const ed = this.editor;
      if (!ed) return;
      try {
        await deleteEdit(ed.kind === "time" ? ed.tpId : ed.taskId);
        this.editor = null;
      } catch (err) {
        console.error("[chan7] 還原失敗", err);
      }
    },

    // 隱藏的任務數（供編輯模式顯示還原入口）
    get hiddenTaskCount() {
      return Object.values(this.edits ?? {}).filter(
        (e) => e.kind === "task-patch" && e.data?.hidden
      ).length;
    },

    async unhideAllTasks() {
      for (const [id, e] of Object.entries(this.edits ?? {})) {
        if (e.kind === "task-patch" && e.data?.hidden) {
          try {
            await deleteEdit(id);
          } catch (err) {
            console.error("[chan7] 還原隱藏任務失敗", id, err);
          }
        }
      }
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
