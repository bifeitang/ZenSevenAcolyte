#!/usr/bin/env python3
"""xlsx_to_schedule.py — 一次性轉換 2026 禪七逐日心燈流程 xlsx → schedule/*.json + REVIEW.md

僅使用 Python 標準庫（zipfile + xml.etree.ElementTree）。
來源檔（唯讀，絕不修改）：/Users/huyang/Documents/禅七/2026禪七逐日心燈流程 v1.xlsx
輸出目錄：<repo>/schedule/

分頁對應（依 DESIGN.md 第 9 節）：
  sheet1 = 說明與待確認（僅供參考，不轉出獨立檔）
  sheet2 = 第一日 7-18
  sheet3 = 第二日 7-19
  sheet4 = 第三～七日 7-20~24（主表展開為 5 天）
  sheet5 = 第八日 7-25
  sheet6 = 固定動作（每支香）
  sheet7 = 布場（物料清單）

執行方式：
  python3 scripts/xlsx_to_schedule.py

可重跑、冪等：每次執行皆從 xlsx 完整重算並覆寫 schedule/ 下所有輸出檔。
"""

import json
import os
import re
import sys
import zipfile
from datetime import datetime
from zoneinfo import ZoneInfo
import xml.etree.ElementTree as ET

# ---------------------------------------------------------------------------
# 路徑設定
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
XLSX_PATH = "/Users/huyang/Documents/禅七/2026禪七逐日心燈流程 v1.xlsx"
SCHEDULE_DIR = os.path.join(REPO_ROOT, "schedule")
TIMEZONE = "America/Chicago"

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

# ---------------------------------------------------------------------------
# 低階 XLSX 讀取（僅標準庫）
# ---------------------------------------------------------------------------


def col_to_idx(col):
    idx = 0
    for ch in col:
        idx = idx * 26 + (ord(ch) - 64)
    return idx


def parse_ref(ref):
    i = 0
    while ref[i].isalpha():
        i += 1
    return ref[:i], int(ref[i:])


def load_shared_strings(z):
    try:
        data = z.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(data)
    out = []
    for si in root.findall(f"{NS}si"):
        texts = si.findall(f".//{NS}t")
        out.append("".join(t.text or "" for t in texts))
    return out


def load_sheet_raw(z, sheet_path, sst):
    """讀取單一分頁原始內容（未套用 mergeCells forward-fill）。
    回傳 (cells, merges, max_row, max_col)。
    """
    data = z.read(sheet_path)
    root = ET.fromstring(data)
    sheetdata = root.find(f"{NS}sheetData")
    cells = {}
    max_row = 0
    max_col = 0
    for row in sheetdata.findall(f"{NS}row"):
        r = int(row.get("r"))
        for c in row.findall(f"{NS}c"):
            ref = c.get("r")
            col, rr = parse_ref(ref)
            ci = col_to_idx(col)
            t = c.get("t")
            v_el = c.find(f"{NS}v")
            is_el = c.find(f"{NS}is")
            val = None
            if t == "s" and v_el is not None:
                val = sst[int(v_el.text)]
            elif t == "inlineStr" and is_el is not None:
                texts = is_el.findall(f".//{NS}t")
                val = "".join(x.text or "" for x in texts)
            elif t == "str" and v_el is not None:
                val = v_el.text
            elif v_el is not None:
                val = v_el.text
            if val is not None:
                cells[(r, ci)] = val
                max_row = max(max_row, r)
                max_col = max(max_col, ci)

    merges = []
    mc = root.find(f"{NS}mergeCells")
    if mc is not None:
        for m in mc.findall(f"{NS}mergeCell"):
            ref = m.get("ref")
            a, b = ref.split(":")
            ca, ra = parse_ref(a)
            cb, rb = parse_ref(b)
            merges.append((ra, col_to_idx(ca), rb, col_to_idx(cb)))

    return cells, merges, max_row, max_col


def load_sheet_grid(z, sheet_path, sst):
    """讀取單一分頁，回傳 (grid, max_row, max_col)，對「所有」mergeCells 做
    forward-fill（某 cell 落在合併範圍內且非左上角 → 取左上角值）。
    用於 sheet6（固定動作）、sheet7（布場）：這兩張表沒有「A 欄空白＝延續上一列」
    的語意衝突，location/title 欄位本就應該整段合併值一致地往下填。
    """
    cells, merges, max_row, max_col = load_sheet_raw(z, sheet_path, sst)
    for (r1, c1, r2, c2) in merges:
        anchor = cells.get((r1, c1))
        if anchor is None:
            continue
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                if r == r1 and c == c1:
                    continue
                if (r, c) not in cells:
                    cells[(r, c)] = anchor
    return cells, max_row, max_col


def load_day_sheet_grid(z, sheet_path, sst):
    """讀取「日表」分頁（sheet2/3/4/5），回傳 (grid, max_row, max_col)。

    日表的 A 欄（時間）是否為空白，是判斷「新 TimePoint」vs「併入目前 TimePoint」
    的關鍵信號；若對 A 欄也做 mergeCells forward-fill，會把「同一時間管轄多列任務」
    的合併（如 A6:A9）誤判成連續多個新 TimePoint，破壞既有邏輯 —— 這類合併本來就
    已經用「A 欄空白」正確表達延續語意，不需要、也不可以 forward-fill。

    因此：
    - 欄 A（col=1）一律不做 forward-fill（保留原始空白）。
    - 其餘欄（B~F）只在「目標列本身的原始 A 欄為空白」（亦即該列本來就是延續列）時
      才 forward-fill；若目標列自己有時間值（代表它是另一個獨立 TimePoint 的起始列，
      只是恰好也落在合併範圍內），則不 forward-fill，避免把前一個 TimePoint 的任務
      內容錯誤地複製到新的 TimePoint（例如第一日 sheet2 的 C4:C5 合併）。
    """
    cells, merges, max_row, max_col = load_sheet_raw(z, sheet_path, sst)
    raw_a_has_value = {r for (r, c) in cells if c == 1}

    for (r1, c1, r2, c2) in merges:
        anchor = cells.get((r1, c1))
        if anchor is None:
            continue
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                if r == r1 and c == c1:
                    continue
                if c == 1:
                    continue  # 欄 A 永不 forward-fill
                if r in raw_a_has_value:
                    continue  # 目標列本身是獨立 TimePoint，不繼承前一列內容
                if (r, c) not in cells:
                    cells[(r, c)] = anchor
    return cells, max_row, max_col


class Workbook:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.sst = load_shared_strings(self.z)
        self._cache = {}

    def sheet(self, n):
        if n not in self._cache:
            loader = load_day_sheet_grid if n in (2, 3, 4, 5) else load_sheet_grid
            self._cache[n] = loader(self.z, f"xl/worksheets/sheet{n}.xml", self.sst)
        return self._cache[n]


# ---------------------------------------------------------------------------
# 負責人正規化
# ---------------------------------------------------------------------------

# 順序：較長 token 優先（避免「監香」誤先吃掉「總監香」的子字串）
OWNER_TOKENS = [
    ("總監香", "duty"),
    ("監香", "duty"),
    ("法輝", "fahui"),
    ("法偉", "fawei"),
    ("侍者", "attendant"),
    ("行堂", "server"),
    ("義工", "volunteer"),
    ("全體", "all"),
    ("法然", "other"),
]

OWNER_TOKEN_RE = re.compile("|".join(re.escape(tok) for tok, _ in OWNER_TOKENS))
OWNER_TOKEN_MAP = dict(OWNER_TOKENS)


def normalize_owner(raw, force_fawei_to_fahui=False):
    """回傳 (owners:list[str], had_unrecognized:bool)。
    force_fawei_to_fahui: 第八日分頁專用，「法偉」字面 token 一律視為 fahui。
    """
    if raw is None or raw.strip() == "":
        return [], False

    matches = []
    for m in OWNER_TOKEN_RE.finditer(raw):
        tok = m.group(0)
        key = OWNER_TOKEN_MAP[tok]
        if tok == "法偉" and force_fawei_to_fahui:
            key = "fahui"
        matches.append((m.start(), key))

    if not matches:
        return ["other"], True

    matches.sort(key=lambda x: x[0])
    owners = list(dict.fromkeys(k for _, k in matches))  # 去重、保留順序
    return owners, False


# ---------------------------------------------------------------------------
# 時間分類
# ---------------------------------------------------------------------------

HHMM_RE = re.compile(r"^\d{2}:\d{2}$")


def frac_to_hhmm(f):
    minutes = round(f * 24 * 60)
    hh = (minutes // 60) % 24
    mm = minutes % 60
    return f"{hh:02d}:{mm:02d}"


def classify_time(raw):
    """回傳 dict：{kind, value, rangeEnd}（不含 raw/anchor/offset，由呼叫端補）。"""
    s = raw.strip()

    # 數字分數 → exact
    try:
        f = float(s)
        if 0 <= f < 1:
            return {"kind": "exact", "value": frac_to_hhmm(f), "rangeEnd": None}
    except ValueError:
        pass

    # 純 "HH:MM" → exact
    if HHMM_RE.match(s):
        return {"kind": "exact", "value": s, "rangeEnd": None}

    # 含 en-dash / 換行的範圍 → "HH:MM–HH:MM"
    if "–" in s or ("-" in s and re.search(r"\d{2}:\d{2}.*[-–].*\d{2}:\d{2}", s, re.S)):
        parts = re.split(r"[–-]", s)
        if len(parts) == 2:
            a = parts[0].strip().replace("\n", "").strip()
            b = parts[1].strip().replace("\n", "").strip()
            if HHMM_RE.match(a) and HHMM_RE.match(b):
                return {"kind": "range", "value": a, "rangeEnd": b}

    # 其餘 → fuzzy
    return {"kind": "fuzzy", "value": None, "rangeEnd": None}


FUZZY_OFFSET = {
    "擊鼓時": 2,
    "開靜後": 40,
}
FUZZY_NO_ANCHOR = {"前一晚", "事先", "下午"}


# ---------------------------------------------------------------------------
# 日表解析（sheet2/3/4/5 共用邏輯）
# ---------------------------------------------------------------------------


def is_bracket(s):
    return isinstance(s, str) and s.strip().startswith("【")


def strip_bracket(s):
    # 去掉【】括號本身（可能不在字串尾端，如「【早課】（板→鐘→鼓…）」）
    return s.strip().replace("【", "").replace("】", "").strip()


class DayParseResult:
    def __init__(self):
        self.sections = []
        self.notes = []  # REVIEW.md 用的異常/修正紀錄（字串列表）
        self.timepoint_count = 0
        self.task_count = 0


def parse_day_table(
    cells,
    max_row,
    id_prefix,
    day_index,
    force_fawei_to_fahui=False,
    stop_section_title=None,
):
    """解析單一日表（跳過表頭 2 列，從第 3 列開始）。
    stop_section_title: 若遇到此標題的 section（如「當日差異對照」），停止解析（不納入 sections）。
    """
    result = DayParseResult()
    section = None
    tp = None
    section_counter = 0
    tp_counter = 0
    last_anchor_id = None  # 同 section 內最近的 exact/range TimePoint id

    r = 3
    while r <= max_row:
        a = cells.get((r, 1))
        b = cells.get((r, 2))
        c = cells.get((r, 3))
        d = cells.get((r, 4))
        e = cells.get((r, 5))
        f = cells.get((r, 6))

        if a is not None and is_bracket(a):
            title = strip_bracket(a)
            if stop_section_title is not None and title == stop_section_title:
                break
            section_counter += 1
            section = {
                "id": f"{id_prefix}-sec-{section_counter}",
                "title": title,
                "timePoints": [],
            }
            result.sections.append(section)
            tp = None
            last_anchor_id = None
            r += 1
            continue

        if a is not None and not is_bracket(a):
            # 新 TimePoint
            if section is None:
                result.notes.append(
                    f"列 {r}：出現時間欄「{a}」但尚無所屬 section，已略過。"
                )
                r += 1
                continue
            tp_counter += 1
            time_info = classify_time(a)
            tp_id = f"{id_prefix}-tp-{tp_counter:02d}"

            time_obj = {
                "kind": time_info["kind"],
                "value": time_info["value"],
                "rangeEnd": time_info["rangeEnd"],
                "raw": a,
                "anchorTimePointId": None,
                "offsetMinutes": None,
            }

            if time_info["kind"] in ("exact", "range"):
                # anchor/offset 保持 None；並更新本 section 的最近錨點
                last_anchor_id = tp_id
            else:
                # fuzzy
                s = a.strip()
                if s in FUZZY_NO_ANCHOR:
                    time_obj["anchorTimePointId"] = None
                    time_obj["offsetMinutes"] = None
                else:
                    time_obj["anchorTimePointId"] = last_anchor_id
                    time_obj["offsetMinutes"] = FUZZY_OFFSET.get(s)
                    if s not in FUZZY_OFFSET and s not in FUZZY_NO_ANCHOR:
                        result.notes.append(
                            f"列 {r}：未知 fuzzy 時間文字「{s}」，"
                            f"anchor={last_anchor_id}，offsetMinutes=null，請人工確認。"
                        )

            period_label = b if b is not None else None
            tp = {
                "id": tp_id,
                "time": time_obj,
                "isBellRow": (period_label == "地鐘"),
                "periodLabel": period_label,
                "leadMinutesOverride": None,
                "tasks": [],
            }
            section["timePoints"].append(tp)
            result.timepoint_count += 1

            if c is not None and c.strip() != "":
                _append_task(tp, c, d, e, f, result, force_fawei_to_fahui, r)
            r += 1
            continue

        # a 為 None → 併入目前 TimePoint
        if tp is None:
            r += 1
            continue
        if c is not None and c.strip() != "":
            _append_task(tp, c, d, e, f, result, force_fawei_to_fahui, r)
        # C 欄也空 → 純格式列，跳過
        r += 1

    return result


def _append_task(tp, c, d, e, f, result, force_fawei_to_fahui, row_no):
    owners, unrecognized = normalize_owner(d, force_fawei_to_fahui)
    owner_raw = d if d is not None else ""
    if force_fawei_to_fahui and d is not None and "法偉" in d:
        result.notes.append(
            f"列 {row_no}：負責人欄原文「{d}」，第八日範本殘留 → 已修正為 fahui。"
        )
    if unrecognized:
        result.notes.append(
            f"列 {row_no}：負責人「{owner_raw}」無法正規化對應，已標記為 other。"
        )

    template_ref = "fixed:sitting-cycle" if ("固定動作" in c) else None

    task_no = len(tp["tasks"]) + 1
    task = {
        "id": f"{tp['id']}-t{task_no}",
        "action": c.strip(),
        "templateRef": template_ref,
        "owners": owners,
        "ownerRaw": owner_raw,
        "signal": e.strip() if (e is not None and e.strip() != "") else None,
        "note": f.strip() if (f is not None and f.strip() != "") else None,
    }
    tp["tasks"].append(task)
    result.task_count += 1


# ---------------------------------------------------------------------------
# 固定動作（sheet6）
# ---------------------------------------------------------------------------

FIXED_ID_MAP = {
    "坐香 · 前 8 分": "fixed:sitting-start-8min",
    "坐香 · 前 3 分": "fixed:sitting-bell-3min",
    "悅眾『止靜』後": "fixed:still-lights-off",
    "維那『開靜』（第一聲引磬）後": "fixed:open-lights-on",
    "行香 / 跑香結束": "fixed:walking-end",
    "時長": "fixed:sitting-duration",
    "早 / 晚課加做": "fixed:sutra-extra",
    "晚課施食加做": "fixed:evening-feeding-extra",
    "過堂（早/午齋）加做": "fixed:meal-hall-extra",
    "養息 / 安板": "fixed:rest-close",
}

# 供 templateRef "fixed:sitting-cycle" 使用的整合文字：
# 由 sheet6 第 2,4,5,6,7 列（前8分上香/止靜關燈/開靜開燈/行香結束/時長規則）綜合而成，
# 對應各日表中「同固定動作」「固定動作（…）」的省略描述。
SITTING_CYCLE_TEXT = (
    "坐香 37 分開靜；長香 43 分開靜（不跑香）；每支香 37 分起座、放腿 3 分、行香 5 分。"
    "前 8 分上香開燈開空調；止靜關燈；開靜開燈開門；行香後上香關燈"
)


def parse_fixed_actions(cells, max_row):
    items = []
    notes = []
    for r in range(2, max_row + 1):
        title = cells.get((r, 1))
        text = cells.get((r, 2))
        if title is None or text is None:
            continue
        title = title.strip()
        text = text.strip()
        item_id = FIXED_ID_MAP.get(title)
        if item_id is None:
            item_id = "fixed:" + re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
            notes.append(f"固定動作分頁列 {r} 標題「{title}」無預設 id 對照，已自動產生 id「{item_id}」。")
        items.append({"id": item_id, "title": title, "text": text})

    items.append(
        {
            "id": "fixed:sitting-cycle",
            "title": "每支香標準流程",
            "text": SITTING_CYCLE_TEXT,
        }
    )
    return items, notes


# ---------------------------------------------------------------------------
# 布場 / 物料清單（sheet7）
# ---------------------------------------------------------------------------

# 只取「心燈物料準備」(rows 3-18) 與「其他物料準備」(rows 31-39) 兩張表；
# rows 123-312 為舊年度（12/27~1/2）殘留範本資料，與 2026/7 禪七無關，不納入輸出
# （已記錄於 REVIEW.md）。
PREP_ROW_RANGES = [(3, 18), (31, 39)]


def parse_prep_checklist(cells, max_row):
    items = []
    notes = []
    counter = 0
    for start, end in PREP_ROW_RANGES:
        for r in range(start, end + 1):
            location = cells.get((r, 1))
            item = cells.get((r, 2))
            note = cells.get((r, 4))
            if item is None or item.strip() == "":
                continue
            counter += 1
            items.append(
                {
                    "id": f"prep-{counter}",
                    "location": location.strip() if location else None,
                    "item": item.strip(),
                    "note": note.strip() if (note and note.strip() != "") else None,
                }
            )
    notes.append(
        "布場分頁（sheet7）第 123–312 列為舊年度（12/27–1/2）殘留範本資料，"
        "日期與內容與 2026/7 禪七無關，判定為範本殘留，未納入 prep-checklist.json。"
        "如需引用請人工核對原始 xlsx。"
    )
    return items, notes


# ---------------------------------------------------------------------------
# 第三～七日「當日差異對照」
# ---------------------------------------------------------------------------


def parse_diff_table(cells, max_row, start_row):
    diffs = []
    r = start_row
    while r <= max_row:
        a = cells.get((r, 1))
        if a is None:
            r += 1
            continue
        b = cells.get((r, 2))
        c = cells.get((r, 3))
        d = cells.get((r, 4))
        f = cells.get((r, 6))
        diffs.append(
            {
                "row": r,
                "dateLabel": a.strip(),
                "dayLabel": b.strip() if b else None,
                "desc": c.strip() if c else None,
                "ownerVariant": d.strip() if d else None,
                "note": f.strip() if f else None,
            }
        )
        r += 1
    return diffs


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

WEEKDAY_CHAR = {3: "一", 4: "二", 5: "三", 6: "四", 7: "五"}
DAY_CN = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八"}


def clean_day1_label(raw_title):
    # "第一日 · 7/18（六）起七日　〔法輝 + 法偉〕" → 去掉尾端全形空白 + 〔…〕
    s = raw_title.split("　")[0]
    return s.strip()


def main():
    os.makedirs(SCHEDULE_DIR, exist_ok=True)
    wb = Workbook(XLSX_PATH)

    all_notes = []  # REVIEW.md 主體
    id_registry = {}  # id -> 來源說明，用於全域唯一性檢查
    stats = []  # (label, section數, timePoint數, task數)

    def register_ids(day_obj, day_label):
        for sec in day_obj["sections"]:
            _check_id(sec["id"], f"{day_label} section", id_registry)
            for tp in sec["timePoints"]:
                _check_id(tp["id"], f"{day_label} timePoint", id_registry)
                for task in tp["tasks"]:
                    _check_id(task["id"], f"{day_label} task", id_registry)

    # ---------------- 固定動作 ----------------
    cells6, max_row6, _ = wb.sheet(6)
    fixed_actions, fixed_notes = parse_fixed_actions(cells6, max_row6)
    all_notes.extend(fixed_notes)
    for fa in fixed_actions:
        _check_id(fa["id"], "fixed-actions", id_registry)

    # ---------------- 布場 ----------------
    cells7, max_row7, _ = wb.sheet(7)
    prep_items, prep_notes = parse_prep_checklist(cells7, max_row7)
    all_notes.extend(prep_notes)
    for p in prep_items:
        _check_id(p["id"], "prep-checklist", id_registry)

    # ---------------- 第一日 7/18 ----------------
    cells2, max_row2, _ = wb.sheet(2)
    day1_title_raw = cells2.get((1, 1))
    day1_label = clean_day1_label(day1_title_raw)
    r1 = parse_day_table(cells2, max_row2, id_prefix="d1", day_index=1)
    day1 = {
        "date": "2026-07-18",
        "dayIndex": 1,
        "label": day1_label,
        "participants": ["fahui", "fawei"],
        "sections": r1.sections,
    }
    all_notes.extend([f"[第一日 7/18] {n}" for n in r1.notes])
    register_ids(day1, "第一日 7/18")
    stats.append(("2026-07-18 第一日", len(day1["sections"]), r1.timepoint_count, r1.task_count))

    # ---------------- 第二日 7/19 ----------------
    cells3, max_row3, _ = wb.sheet(3)
    day2_label = cells3.get((1, 1)).strip()
    r2 = parse_day_table(cells3, max_row3, id_prefix="d2", day_index=2)
    day2 = {
        "date": "2026-07-19",
        "dayIndex": 2,
        "label": day2_label,
        "participants": ["fahui", "fawei"],
        "sections": r2.sections,
    }
    all_notes.extend([f"[第二日 7/19] {n}" for n in r2.notes])
    register_ids(day2, "第二日 7/19")
    stats.append(("2026-07-19 第二日", len(day2["sections"]), r2.timepoint_count, r2.task_count))

    # ---------------- 第三～七日 7/20–7/24（sheet4 展開） ----------------
    cells4, max_row4, _ = wb.sheet(4)
    diff_start = None
    for r in range(3, max_row4 + 1):
        v = cells4.get((r, 1))
        if is_bracket(v) and strip_bracket(v) == "當日差異對照":
            diff_start = r + 1
            break
    diffs = parse_diff_table(cells4, max_row4, diff_start) if diff_start else []

    diff_intro = (
        "[第三～七日 7/20–7/24] 以 sheet4（第三～七日 7-20~24）主表結構展開為 5 個獨立日檔"
        "（id 前綴 d3..d7），5 天的 sections/timePoints/tasks 內容彼此完全相同（全文照抄主表），"
        "僅 date/dayIndex/label/participants 與各 id 前綴不同。"
        "差異僅影響 participants（7/22–7/24 僅 fahui）與「當日差異對照」表列出的備註重點，"
        "不做結構性改動。"
    )
    diff_lines = [
        f"{d['dateLabel']}（{d['dayLabel']}）：{d['desc']}"
        + (f"｜負責人備註原文：{d['ownerVariant']}" if d["ownerVariant"] else "")
        + (f"｜備註：{d['note']}" if d["note"] else "")
        for d in diffs
    ]

    days_3to7 = []
    date_map = {3: "07-20", 4: "07-21", 5: "07-22", 6: "07-23", 7: "07-24"}
    participants_map = {
        3: ["fahui", "fawei"],
        4: ["fahui", "fawei"],
        5: ["fahui"],
        6: ["fahui"],
        7: ["fahui"],
    }
    day_label_cn = {3: "第三日", 4: "第四日", 5: "第五日", 6: "第六日", 7: "第七日"}

    for day_index in range(3, 8):
        id_prefix = f"d{day_index}"
        rN = parse_day_table(
            cells4,
            max_row4,
            id_prefix=id_prefix,
            day_index=day_index,
            stop_section_title="當日差異對照",
        )
        date_str = f"2026-{date_map[day_index]}"
        weekday = WEEKDAY_CHAR[day_index]
        label = f"{day_label_cn[day_index]} · 7/{date_map[day_index].split('-')[1]}（{weekday}）"
        day_obj = {
            "date": date_str,
            "dayIndex": day_index,
            "label": label,
            "participants": participants_map[day_index],
            "sections": rN.sections,
        }
        all_notes.extend([f"[{label}] {n}" for n in rN.notes])
        register_ids(day_obj, label)
        stats.append((f"{date_str} {day_label_cn[day_index]}", len(day_obj["sections"]), rN.timepoint_count, rN.task_count))
        days_3to7.append(day_obj)

    # ---------------- 第八日 7/25 ----------------
    cells5, max_row5, _ = wb.sheet(5)
    day8_label = cells5.get((1, 1)).strip()
    r8 = parse_day_table(
        cells5, max_row5, id_prefix="d8", day_index=8, force_fawei_to_fahui=True
    )
    day8 = {
        "date": "2026-07-25",
        "dayIndex": 8,
        "label": day8_label,
        "participants": ["fahui"],
        "sections": r8.sections,
    }
    all_notes.append(
        "[第八日 7/25] 已知資料修正：本分頁負責人欄原文含「法偉」為範本殘留"
        "（法偉僅參與 7/18–7/21，7/25 不應出現），一律改為 fahui："
    )
    all_notes.extend([f"  {n}" for n in r8.notes])
    register_ids(day8, "第八日 7/25")
    stats.append(("2026-07-25 第八日", len(day8["sections"]), r8.timepoint_count, r8.task_count))

    all_days = [day1, day2] + days_3to7 + [day8]

    # ---------------- meta.json ----------------
    schedule_version = datetime.now(ZoneInfo(TIMEZONE)).isoformat(timespec="seconds")
    meta = {
        "retreatId": "chan7-2026",
        "timezone": TIMEZONE,
        "scheduleVersion": schedule_version,
        "owners": {
            "fahui": {"displayName": "法輝", "color": "#3b5bdb"},
            "fawei": {"displayName": "法偉", "color": "#e8590c"},
            "attendant": {"displayName": "侍者", "color": "#868e96"},
            "server": {"displayName": "行堂", "color": "#868e96"},
            "duty": {"displayName": "監香", "color": "#868e96"},
            "volunteer": {"displayName": "義工", "color": "#868e96"},
            "all": {"displayName": "全體", "color": "#868e96"},
            "other": {"displayName": "其他", "color": "#868e96"},
        },
        "defaultLeadMinutes": 7,
        "defaultEventDurationMinutes": 1,
        "icsFuzzyStrategy": "anchor",
    }

    # ---------------- 寫檔 ----------------
    written = []

    def write_json(name, obj):
        path = os.path.join(SCHEDULE_DIR, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        written.append(path)

    write_json("meta.json", meta)
    write_json("fixed-actions.json", fixed_actions)
    write_json("prep-checklist.json", prep_items)
    for day_obj in all_days:
        write_json(f"day-{day_obj['date']}.json", day_obj)

    # ---------------- REVIEW.md ----------------
    review_path = os.path.join(SCHEDULE_DIR, "REVIEW.md")
    with open(review_path, "w", encoding="utf-8") as fh:
        fh.write("# schedule/ 轉換異常與修正清單（REVIEW.md）\n\n")
        fh.write(
            f"由 `scripts/xlsx_to_schedule.py` 於 {schedule_version} 自動產生，"
            f"來源：`{XLSX_PATH}`（唯讀，未修改）。\n\n"
        )
        fh.write("## ID 穩定性紀律\n\n")
        fh.write(
            "改版時**不可改動既有 id**（ics UID 與 Firestore 勾選皆以 id 為 key）；"
            "新增項用新 id，刪除項直接刪。所有 section/timePoint/task/fixed-action/prep-checklist "
            "的 id 已於本次產生時做過全域唯一性檢查（見下方統計）。\n\n"
        )
        fh.write("## 轉換過程異常 / 修正清單\n\n")
        if all_notes:
            for n in all_notes:
                fh.write(f"- {n}\n")
        else:
            fh.write("（無）\n")

        fh.write("\n## 第三～七日（7/20–7/24）展開說明\n\n")
        fh.write(diff_intro + "\n\n")
        fh.write("原表「當日差異對照」逐列摘要：\n\n")
        for line in diff_lines:
            fh.write(f"- {line}\n")

        fh.write("\n## 每日 section / timePoint / task 數量統計\n\n")
        fh.write("| 日期 | sections | timePoints | tasks |\n")
        fh.write("|---|---|---|---|\n")
        total_sec = total_tp = total_task = 0
        for label, nsec, ntp, ntask in stats:
            fh.write(f"| {label} | {nsec} | {ntp} | {ntask} |\n")
            total_sec += nsec
            total_tp += ntp
            total_task += ntask
        fh.write(f"| **合計** | **{total_sec}** | **{total_tp}** | **{total_task}** |\n")

    written.append(review_path)

    print("已產生以下檔案：")
    for p in written:
        print(" -", os.path.relpath(p, REPO_ROOT))

    return written


def _check_id(id_, source, registry):
    if id_ in registry:
        raise SystemExit(
            f"致命錯誤：id「{id_}」重複出現（來源：{registry[id_]} 與 {source}），"
            "ID 必須全域唯一。"
        )
    registry[id_] = source


if __name__ == "__main__":
    main()
