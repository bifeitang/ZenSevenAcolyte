#!/usr/bin/env node
// scripts/build.mjs — schedule/* → public/（含驗證）
//
// 步驟（DESIGN.md 第 6 節）：
//   1. 讀 schema/*.json，用 ajv 驗證 meta 與 8 個 day 檔＋自訂檢查；失敗 → 非零退出並列出錯誤。
//   2. 合併輸出 public/data/schedule.json：{ meta, fixedActions, prepChecklist, days:[…8 天] }
//   3. 複製 app shell（index.html、manifest、sw.js、assets/**）到 public/（缺檔容錯：警告但不失敗）。
//   4. import generate_ics.mjs 的 generateIcs()，寫 public/retreat.ics。

import Ajv from 'ajv';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  cpSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateIcs } from './generate_ics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'schema');
const SCHEDULE_DIR = path.join(ROOT, 'schedule');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(PUBLIC_DIR, 'data');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function log(msg) {
  console.log(`[build] ${msg}`);
}
function warn(msg) {
  console.warn(`[build] 警告：${msg}`);
}
function fail(errors) {
  console.error('[build] 驗證失敗，共', errors.length, '項錯誤：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. 讀 schedule 資料
// ---------------------------------------------------------------------------
function loadScheduleDir() {
  const meta = readJson(path.join(SCHEDULE_DIR, 'meta.json'));
  const fixedActions = readJson(path.join(SCHEDULE_DIR, 'fixed-actions.json'));
  const prepChecklist = readJson(path.join(SCHEDULE_DIR, 'prep-checklist.json'));
  const dayFiles = readdirSync(SCHEDULE_DIR)
    .filter((f) => /^day-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const days = dayFiles.map((f) => ({
    file: f,
    data: readJson(path.join(SCHEDULE_DIR, f)),
  }));
  return { meta, fixedActions, prepChecklist, days };
}

// ---------------------------------------------------------------------------
// 2. ajv 結構驗證
// ---------------------------------------------------------------------------
function validateSchemas({ meta, days }) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const metaSchema = readJson(path.join(SCHEMA_DIR, 'meta.schema.json'));
  const daySchema = readJson(path.join(SCHEMA_DIR, 'day.schema.json'));

  const validateMeta = ajv.compile(metaSchema);
  const validateDay = ajv.compile(daySchema);

  const errors = [];

  if (!validateMeta(meta)) {
    for (const e of validateMeta.errors) {
      errors.push(`meta.json ${e.instancePath || '/'} ${e.message}`);
    }
  }

  for (const { file, data } of days) {
    if (!validateDay(data)) {
      for (const e of validateDay.errors) {
        errors.push(`schedule/${file} ${e.instancePath || '/'} ${e.message}`);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 1b. 自訂檢查：id 唯一性、fuzzy anchor 存在、templateRef 存在於 fixed-actions、owners 值合法
// ---------------------------------------------------------------------------
function customChecks({ meta, fixedActions, prepChecklist, days }) {
  const errors = [];
  const ownerKeys = new Set(Object.keys(meta.owners || {}));
  const fixedActionIds = new Set(fixedActions.map((f) => f.id));

  const idOwners = new Map(); // id → 出現位置陣列（偵測重複）
  function registerId(id, where) {
    if (!id) return;
    if (!idOwners.has(id)) idOwners.set(id, []);
    idOwners.get(id).push(where);
  }

  for (const fa of fixedActions) registerId(fa.id, 'fixed-actions.json');
  for (const p of prepChecklist) registerId(p.id, 'prep-checklist.json');

  for (const { file, data } of days) {
    // participants owners 合法性
    for (const p of data.participants || []) {
      if (!ownerKeys.has(p)) {
        errors.push(`schedule/${file} participants 含未知 owner "${p}"`);
      }
    }

    // 蒐集本日全部 timePoint id，供 fuzzy anchor 查找
    const tpIdsInDay = new Set();
    for (const section of data.sections) {
      registerId(section.id, `schedule/${file}`);
      for (const tp of section.timePoints) {
        tpIdsInDay.add(tp.id);
      }
    }

    for (const section of data.sections) {
      for (const tp of section.timePoints) {
        registerId(tp.id, `schedule/${file}`);

        if (tp.time.kind === 'fuzzy' && tp.time.anchorTimePointId) {
          if (!tpIdsInDay.has(tp.time.anchorTimePointId)) {
            errors.push(
              `schedule/${file} timePoint ${tp.id} 的 anchorTimePointId "${tp.time.anchorTimePointId}" 在同日找不到對應的 TimePoint`
            );
          }
        }

        for (const task of tp.tasks) {
          registerId(task.id, `schedule/${file}`);

          if (task.templateRef && !fixedActionIds.has(task.templateRef)) {
            errors.push(
              `schedule/${file} task ${task.id} 的 templateRef "${task.templateRef}" 不存在於 fixed-actions.json`
            );
          }

          for (const o of task.owners || []) {
            if (!ownerKeys.has(o)) {
              errors.push(`schedule/${file} task ${task.id} 含未知 owner "${o}"`);
            }
          }
        }
      }
    }
  }

  // 全域 id 唯一性
  for (const [id, wheres] of idOwners.entries()) {
    if (wheres.length > 1) {
      errors.push(`id "${id}" 重複出現於：${wheres.join(', ')}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 3. 複製 app shell（缺檔容錯：警告但不失敗）
// ---------------------------------------------------------------------------
function copyIfExists(srcRel, destRel) {
  const src = path.join(ROOT, srcRel);
  const dest = path.join(PUBLIC_DIR, destRel);
  if (!existsSync(src)) {
    warn(`找不到 ${srcRel}，略過複製（app shell 可能由其他 worker 並行產出中）`);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  log(`已複製 ${srcRel} → public/${destRel}`);
  return true;
}

function copyAppShell() {
  copyIfExists('index.html', 'index.html');
  copyIfExists('manifest.webmanifest', 'manifest.webmanifest');
  copyIfExists('sw.js', 'sw.js');
  copyIfExists('assets', 'assets');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  log('讀取 schedule/* …');
  const { meta, fixedActions, prepChecklist, days } = loadScheduleDir();

  log('ajv 結構驗證中 …');
  const schemaErrors = validateSchemas({ meta, days });
  if (schemaErrors.length > 0) fail(schemaErrors);
  log('ajv 驗證通過（0 錯誤）');

  log('自訂檢查中（id 唯一性 / fuzzy anchor / templateRef / owners）…');
  const custom = customChecks({ meta, fixedActions, prepChecklist, days });
  if (custom.length > 0) fail(custom);
  log('自訂檢查通過');

  // 2. 合併輸出 public/data/schedule.json
  mkdirSync(DATA_DIR, { recursive: true });
  const merged = {
    meta,
    fixedActions,
    prepChecklist,
    days: days.map((d) => d.data),
  };
  const schedulePath = path.join(DATA_DIR, 'schedule.json');
  writeFileSync(schedulePath, JSON.stringify(merged, null, 2), 'utf8');
  log(`已寫入 ${path.relative(ROOT, schedulePath)}（${days.length} 天）`);

  // 3. 複製 app shell
  log('複製 app shell …');
  copyAppShell();

  // 4. 產生 retreat.ics
  log('產生 retreat.ics …');
  const ics = generateIcs({ meta, days: days.map((d) => d.data) });
  const icsPath = path.join(PUBLIC_DIR, 'retreat.ics');
  writeFileSync(icsPath, ics, 'utf8');
  log(`已寫入 ${path.relative(ROOT, icsPath)}`);

  log('build 完成。');
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main();
}

export { loadScheduleDir, validateSchemas, customChecks };
