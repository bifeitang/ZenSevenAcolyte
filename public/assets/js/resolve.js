// resolve.js — 純函數，無副作用；node 與瀏覽器皆可 import。
// 依 DESIGN.md 3.1 節簽名逐一實作。輸入資料一律視為 schedule/*.json 的結構（見 DESIGN.md 2 節）。

/**
 * 依 meta.owners 把 task.owners 轉成 UI 用的 chip 陣列。
 * @param {{owners: string[]}} task
 * @param {{owners: Record<string, {displayName:string, color:string}>}} meta
 * @returns {{key:string, displayName:string, color:string, isPrimary:boolean}[]}
 */
export function ownerChips(task, meta) {
  const owners = task?.owners ?? [];
  const ownerMeta = meta?.owners ?? {};
  return owners.map((key) => {
    const info = ownerMeta[key];
    return {
      key,
      displayName: info ? info.displayName : key,
      color: info ? info.color : "#868e96",
      isPrimary: key === "fahui" || key === "fawei",
    };
  });
}

/**
 * 把 TimePoint 的時間資訊轉成畫面顯示用的徽章。
 * @param {{time: {kind: "exact"|"range"|"fuzzy", value: string|null, rangeEnd: string|null, raw: string}}} tp
 * @returns {{text: string, approx: boolean}}
 */
export function timeBadge(tp) {
  const t = tp?.time ?? {};
  if (t.kind === "exact") {
    return { text: t.value, approx: false };
  }
  if (t.kind === "range") {
    return { text: `${t.value}–${t.rangeEnd}`, approx: false };
  }
  // fuzzy（或未知 kind 時退回 raw 文字，仍標記 approx）
  return { text: t.raw ?? "", approx: true };
}

/**
 * 若 task.templateRef 指向 fixed-actions.json 中的項目，回傳其 text；否則 null。
 * @param {{templateRef: string|null}} task
 * @param {{id:string, title:string, text:string}[]} fixedActions
 * @returns {string|null}
 */
export function resolveTemplate(task, fixedActions) {
  const ref = task?.templateRef;
  if (!ref) return null;
  const list = fixedActions ?? [];
  const found = list.find((fa) => fa.id === ref);
  return found ? found.text : null;
}

/**
 * 把一日資料的 sections/timePoints 攤平成陣列，保留原始順序。
 * @param {{sections: {id:string, title:string, timePoints:object[]}[]}} day
 * @returns {{section:object, timePoint:object}[]}
 */
export function flattenTimePoints(day) {
  const out = [];
  const sections = day?.sections ?? [];
  for (const section of sections) {
    const timePoints = section.timePoints ?? [];
    for (const timePoint of timePoints) {
      out.push({ section, timePoint });
    }
  }
  return out;
}

/**
 * 找出「現在之後」最接近的一個 exact/range TimePoint（僅比較 time.value）。
 * @param {object} day
 * @param {string} nowHHMM  "HH:MM" 24 小時制
 * @returns {{timePoint:object, section:object}|null}
 */
export function nextTimePoint(day, nowHHMM) {
  const entries = flattenTimePoints(day);
  let best = null;
  for (const entry of entries) {
    const t = entry.timePoint.time;
    if (t.kind !== "exact" && t.kind !== "range") continue;
    if (!t.value) continue;
    if (t.value > nowHHMM) {
      if (best === null || t.value < best.timePoint.time.value) {
        best = entry;
      }
    }
  }
  return best;
}

/**
 * 把 Date 轉成指定時區（預設 America/Chicago，實務上呼叫端應傳入 meta.timezone）的 "YYYY-MM-DD"。
 * @param {Date} tzNow
 * @param {string} [timezone] 選填；未提供時退回 America/Chicago（呼叫端建議一律傳入 meta.timezone，避免硬編碼）
 * @returns {string}
 */
export function todayDate(tzNow, timezone = "America/Chicago") {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(tzNow);
}
