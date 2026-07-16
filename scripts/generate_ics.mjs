#!/usr/bin/env node
// scripts/generate_ics.mjs — schedule/* → public/retreat.ics
//
// 手寫 iCalendar 產生（不用 `ics` npm 套件，其 VTIMEZONE/VALARM 支援不完整）。
// 規格詳見 DESIGN.md 第 5 節。
//
// 主要 export：
//   generateIcs({ meta, days })              → 完整 retreat.ics 內容字串（純函數，無副作用）
//   generateTestAlarmIcs({ minutes, meta })  → 單一測試事件 ics 內容字串
//
// CLI 直接執行時：讀 schedule/*，寫 public/retreat.ics；
//   `--test-in-minutes N` 額外寫 public/test-alarm.ics。

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCHEDULE_DIR = path.join(ROOT, 'schedule');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------------------------------------------------------------------------
// RFC 5545 行摺疊：每個內容行（含屬性名）以 CRLF 結尾之前 ≤75 octets，
// 續行以單一空白開頭（該空白也計入該續行的 75 octets）。UTF-8 安全切分：
// 絕不在多位元組字元中間切斷。
// ---------------------------------------------------------------------------
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const chunks = [];
  let start = 0;
  let limit = 75; // 第一段：75 octets
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // 不要在 UTF-8 多位元組字元中間切斷：續位元組是 10xxxxxx (0x80-0xBF)
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }
    if (end === start) {
      // 極端情況（單一字元就超過 limit，理論上中文字最多 3 bytes 不會發生）
      end = Math.min(start + limit, bytes.length);
    }
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // 續行：前導空白占 1 octet，故內容最多 74 octets
  }
  return chunks.join('\r\n ');
}

// ---------------------------------------------------------------------------
// TEXT escaping（RFC 5545 3.3.11）：反斜線、分號、逗號、換行
// ---------------------------------------------------------------------------
export function escapeText(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function renderLines(lines) {
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// 日期/時間工具
// ---------------------------------------------------------------------------

// "2026-07-18" + "10:00" → "20260718T100000"
function fmtLocal(dateStr, hhmm) {
  return `${dateStr.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
}

// 純日曆運算（不涉及真實時區換算）：把 dateStr+hhmm 當作 wall-clock，加上分鐘數，
// 處理跨日/跨月進位。用 Date.UTC 僅作為計算器，不代表真實 UTC 時刻。
function addMinutesToLocal(dateStr, hhmm, minutesToAdd) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  const base = Date.UTC(y, m - 1, d, hh, mi);
  const t = new Date(base + minutesToAdd * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    hhmm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
  };
}

// meta.scheduleVersion（ISO 8601 帶 offset）→ ICS UTC 時戳 "YYYYMMDDTHHMMSSZ"
export function toUtcStamp(isoWithOffset) {
  const d = new Date(isoWithOffset);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// 真實 UTC 時刻 → 指定 IANA 時區的 wall-clock 日期/時間（用 Intl，供 --test-in-minutes 用）
function zonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${hour}:${parts.minute}` };
}

function truncate(str, n) {
  return Array.from(String(str ?? '')).slice(0, n).join('');
}

// ---------------------------------------------------------------------------
// VTIMEZONE — America/Chicago（CST/CDT 標準 DST 規則，寫死）
// ---------------------------------------------------------------------------
function buildVtimezone(tzid) {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'X-LIC-LOCATION:America/Chicago',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0600',
    'TZOFFSETTO:-0500',
    'TZNAME:CDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0600',
    'TZNAME:CST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

// ---------------------------------------------------------------------------
// Schedule 資料輔助
// ---------------------------------------------------------------------------

// 依原始順序攤平單一 day 的 timePoints：[{ tp, section }]
function flattenDay(day) {
  const out = [];
  for (const section of day.sections) {
    for (const tp of section.timePoints) {
      out.push({ tp, section });
    }
  }
  return out;
}

function ownerLabelForTask(task, meta) {
  if (task.owners && task.owners.length > 0) {
    return task.owners.map((o) => meta.owners?.[o]?.displayName ?? o).join('、');
  }
  return task.ownerRaw || '未指定';
}

function firstTaskAction(tp) {
  return tp.tasks && tp.tasks[0] ? tp.tasks[0].action : '';
}

function buildDescription(tp, meta) {
  const lines = tp.tasks.map((t) => {
    const ownerLabel = ownerLabelForTask(t, meta);
    const signalPart = t.signal ? `（${t.signal}）` : '';
    const notePart = t.note ? ` — ${t.note}` : '';
    return `【${ownerLabel}】${t.action}${signalPart}${notePart}`;
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// VEVENT 產生（一般 exact/range TimePoint，或 fuzzy anchor 衍生事件）
// ---------------------------------------------------------------------------
function buildVEvent({ tp, section, day, meta, dtstamp, isFuzzy, anchor }) {
  const tz = meta.timezone;
  let startDate, startHHMM, endDate, endHHMM;

  if (isFuzzy) {
    const anchorHHMM = anchor.time.value;
    const offset = tp.time.offsetMinutes ?? 0;
    const start = addMinutesToLocal(day.date, anchorHHMM, offset);
    startDate = start.date;
    startHHMM = start.hhmm;
    const end = addMinutesToLocal(startDate, startHHMM, meta.defaultEventDurationMinutes);
    endDate = end.date;
    endHHMM = end.hhmm;
  } else if (tp.time.kind === 'range') {
    startDate = day.date;
    startHHMM = tp.time.value;
    endDate = day.date;
    endHHMM = tp.time.rangeEnd;
  } else {
    startDate = day.date;
    startHHMM = tp.time.value;
    const end = addMinutesToLocal(day.date, tp.time.value, meta.defaultEventDurationMinutes);
    endDate = end.date;
    endHHMM = end.hhmm;
  }

  const lead = tp.leadMinutesOverride ?? meta.defaultLeadMinutes;
  const summaryCore = tp.periodLabel || truncate(firstTaskAction(tp), 20);
  let summary = `${section.title}｜${summaryCore}`;
  if (tp.isBellRow) summary = `🔔 ${summary}`;
  if (isFuzzy) summary = `≈ ${summary}`;

  const description = buildDescription(tp, meta);
  const uid = `${tp.id}@chan7-2026`;

  const lines = [];
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${dtstamp}`);
  lines.push(`DTSTART;TZID=${tz}:${fmtLocal(startDate, startHHMM)}`);
  lines.push(`DTEND;TZID=${tz}:${fmtLocal(endDate, endHHMM)}`);
  lines.push(`SUMMARY:${escapeText(summary)}`);
  lines.push(`DESCRIPTION:${escapeText(description)}`);

  // 準點提醒（PT0S）：exact/range 與 fuzzy anchor 皆有
  lines.push('BEGIN:VALARM');
  lines.push('ACTION:DISPLAY');
  lines.push(`DESCRIPTION:${escapeText(summary)}`);
  lines.push('TRIGGER:PT0S');
  lines.push('END:VALARM');

  // 提前提醒：僅 exact/range（fuzzy anchor 僅 1 個準點 VALARM）
  if (!isFuzzy) {
    lines.push('BEGIN:VALARM');
    lines.push('ACTION:DISPLAY');
    lines.push(`DESCRIPTION:${escapeText(summary)}`);
    lines.push(`TRIGGER:-PT${lead}M`);
    lines.push('END:VALARM');
  }

  lines.push('END:VEVENT');
  return lines;
}

// ---------------------------------------------------------------------------
// generateIcs — 主要 export，供 build.mjs import
// ---------------------------------------------------------------------------
export function generateIcs({ meta, days }) {
  const tz = meta.timezone;
  const dtstamp = toUtcStamp(meta.scheduleVersion);

  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//chan7-2026//lampkeeper//ZH');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push('X-WR-CALNAME:2026 禪七心燈流程');
  lines.push(`X-WR-TIMEZONE:${tz}`);
  lines.push('X-PUBLISHED-TTL:PT15M');
  lines.push(...buildVtimezone(tz));

  const sortedDays = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const day of sortedDays) {
    const flat = flattenDay(day);
    const byId = new Map(flat.map((x) => [x.tp.id, x]));

    for (const { tp, section } of flat) {
      if (tp.time.kind === 'exact' || tp.time.kind === 'range') {
        lines.push(...buildVEvent({ tp, section, day, meta, dtstamp, isFuzzy: false }));
      } else if (tp.time.kind === 'fuzzy') {
        if (tp.time.anchorTimePointId && meta.icsFuzzyStrategy === 'anchor') {
          const anchorEntry = byId.get(tp.time.anchorTimePointId);
          if (anchorEntry) {
            lines.push(
              ...buildVEvent({
                tp,
                section,
                day,
                meta,
                dtstamp,
                isFuzzy: true,
                anchor: anchorEntry.tp,
              })
            );
          }
        }
        // anchorTimePointId 為 null，或找不到錨點 → 略過，不產生事件
      }
    }
  }

  lines.push('END:VCALENDAR');
  return renderLines(lines);
}

// ---------------------------------------------------------------------------
// generateTestAlarmIcs — --test-in-minutes N 用：單一事件 N 分鐘後，雙 VALARM
// ---------------------------------------------------------------------------
export function generateTestAlarmIcs({ minutes, meta, now = new Date() }) {
  const tz = meta.timezone;
  const target = new Date(now.getTime() + minutes * 60000);
  const { date, hhmm } = zonedParts(target, tz);
  const end = addMinutesToLocal(date, hhmm, meta.defaultEventDurationMinutes);
  const lead = meta.defaultLeadMinutes;
  const summary = `🔔 測試提醒（${minutes} 分鐘後）`;
  const dtstamp = toUtcStamp(now.toISOString());

  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//chan7-2026//lampkeeper//ZH');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push('X-WR-CALNAME:chan7 測試鬧鐘');
  lines.push(`X-WR-TIMEZONE:${tz}`);
  lines.push('X-PUBLISHED-TTL:PT1M');
  lines.push(...buildVtimezone(tz));

  lines.push('BEGIN:VEVENT');
  lines.push(`UID:test-alarm-${now.getTime()}@chan7-2026`);
  lines.push(`DTSTAMP:${dtstamp}`);
  lines.push(`DTSTART;TZID=${tz}:${fmtLocal(date, hhmm)}`);
  lines.push(`DTEND;TZID=${tz}:${fmtLocal(end.date, end.hhmm)}`);
  lines.push(`SUMMARY:${escapeText(summary)}`);
  lines.push(`DESCRIPTION:${escapeText(summary)}`);
  lines.push('BEGIN:VALARM');
  lines.push('ACTION:DISPLAY');
  lines.push(`DESCRIPTION:${escapeText(summary)}`);
  lines.push('TRIGGER:PT0S');
  lines.push('END:VALARM');
  lines.push('BEGIN:VALARM');
  lines.push('ACTION:DISPLAY');
  lines.push(`DESCRIPTION:${escapeText(summary)}`);
  lines.push(`TRIGGER:-PT${lead}M`);
  lines.push('END:VALARM');
  lines.push('END:VEVENT');

  lines.push('END:VCALENDAR');
  return renderLines(lines);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function loadScheduleData(scheduleDir = SCHEDULE_DIR) {
  const meta = JSON.parse(readFileSync(path.join(scheduleDir, 'meta.json'), 'utf8'));
  const dayFiles = readdirSync(scheduleDir)
    .filter((f) => /^day-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const days = dayFiles.map((f) => JSON.parse(readFileSync(path.join(scheduleDir, f), 'utf8')));
  return { meta, days };
}

function parseArgs(argv) {
  const args = { testInMinutes: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--test-in-minutes') {
      args.testInMinutes = Number(argv[i + 1]);
      i++;
    }
  }
  return args;
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const { meta, days } = loadScheduleData(SCHEDULE_DIR);
  if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });

  const ics = generateIcs({ meta, days });
  const icsPath = path.join(PUBLIC_DIR, 'retreat.ics');
  writeFileSync(icsPath, ics, 'utf8');
  console.log(`[generate_ics] retreat.ics 已產生：${icsPath}`);

  const args = parseArgs(process.argv.slice(2));
  if (args.testInMinutes != null && !Number.isNaN(args.testInMinutes)) {
    const testIcs = generateTestAlarmIcs({ minutes: args.testInMinutes, meta });
    const testPath = path.join(PUBLIC_DIR, 'test-alarm.ics');
    writeFileSync(testPath, testIcs, 'utf8');
    console.log(`[generate_ics] test-alarm.ics 已產生（${args.testInMinutes} 分鐘後觸發）：${testPath}`);
  }
}
