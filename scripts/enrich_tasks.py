#!/usr/bin/env python3
"""為 schedule/day-*.json 的任務加上顯示型態標註：

  display = "checklist" : 物料/佈場/整理類 → items[] 逐項可勾選（購物清單式）
  display = "step"      : 法會進行中的流程 → 編號步驟 + cue（時機）高亮，不設勾選框
  display 缺省          : 一般離散職責 → 維持單一勾選框

可重複執行（冪等）：每次從 action/note 原文重新推導。
分類規則若需調整，改本檔的 OVERRIDES / 關鍵字清單後重跑即可。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEDULE = ROOT / "schedule"

# ── 明確覆寫：task id → display（優先於一切規則；"simple" 表示強制缺省）──
OVERRIDES = {
    "d1-tp-05-t2": "step",       # 呼班誦文：流程稿而非物料清單
    "d2-tp-20-t4": "checklist",  # 佈置下午講戒場地：物料/佈置清單
    "d2-tp-29-t1": "checklist",  # 藥石時段：開門/打掃/平灰 檢核清單
}

# 法會/流程情境（比對 section 標題 + periodLabel）
CEREMONY_KEYS = [
    "灑淨", "起七", "晚課", "早課", "解七", "施食", "起香", "基本行儀",
    "過堂", "儀軌", "坐香", "團體照", "茶會", "心得分享", "拉班", "第", "支香",
]
# 這些 periodLabel 即使位於法會 section 內也維持「離散職責」
SIMPLE_PERIODS = ["上香", "開門", "地鐘", "收供水", "準備", "物料", "整理", "起板", "趙州茶"]
# 任務動作以這些開頭者一律維持離散職責
SIMPLE_ACTION_RE = re.compile(
    r"^(敲地鐘|上香|上供水|開前鐵門|起床|調整燈光|大磬三聲|確認休息區|打掃|音響充電|準備)"
)

LOC_PREFIX_RE = re.compile(r"^(新禪堂|舊禪堂|圖書館|齋堂|二樓|物料|其他)：\s*(.*)$")
QTY_FRAG_RE = re.compile(r"^\d")

CUE_PATTERNS = [
    re.compile(r"^(.*?)\s*-{2,}>\s*(.+)$"),                                   # X ---> Y
    re.compile(r"^(施食後|開靜後|止靜後|行香後|灑淨後|就座畢|半陣鼓)[，,]?\s*(.{2,})$"),  # 常見觸發詞開頭
    re.compile(r"^(.*『[^』]*』(?:[^，,：]{0,8}?(?:半陣鼓時?|時|後))?)[，,：]?\s*(.{2,})$"),
    re.compile(r"^(.{2,22}?(?:之後的贊子半陣鼓|半陣鼓時?|大悲咒中間|結束後|問訊後|三皈依後|止靜後|開靜後|行香後|施食後|灑淨後|」時|畢))[，,]?\s*(.{2,})$"),
    re.compile(r"^(靜坐|開靜|止靜|施食|呼班)：\s*(.+)$"),                        # 階段名：動作
]
# 白名單：cue 僅在高信心時採用（避免把動作列舉誤切成觸發詞）
CUE_ACCEPT = re.compile(
    r"^(?:[^；;、，]{0,6}『[^』]*』(?:半陣鼓時?)?"
    r"|四生九有、三皈依後"
    r"|[^；;、，]{0,14}(?:之後的贊子半陣鼓|半陣鼓時?|大悲咒中間|結束後|問訊後|止靜後|開靜後|行香後|施食後|灑淨後|」時|畢)"
    r"|施食後|開靜後|止靜後|行香後|灑淨後|就座畢|半陣鼓|靜坐|開靜|止靜|施食|呼班)$"
)


def split_items(action: str, note: str | None):
    """把物料清單文字拆成 [{group, text}]。"""
    src = action if action else ""
    if re.match(r"^確認晚課物料", src) and note:
        src = note
    items = []
    for rawline in re.split(r"[\n；;。]", src):
        line = rawline.strip().strip("，, ")
        if not line:
            continue
        m = LOC_PREFIX_RE.match(line)
        group = None
        if m:
            group, line = m.group(1), m.group(2).strip()
            if not line:
                continue
        parts = [p.strip() for p in line.split("、") if p.strip()]
        if len(parts) == 1 and line.count("，") >= 2:
            parts = [p.strip() for p in line.split("，") if p.strip()]
        enumerated = len(parts) >= 2
        out = []
        for p in parts:
            if enumerated and "，" in p:
                frags = [f.strip() for f in p.split("，") if f.strip()]
                merged = []
                for f in frags:
                    if merged and (QTY_FRAG_RE.match(f) or len(f) <= 2):
                        merged[-1] = merged[-1] + " " + f
                    else:
                        merged.append(f)
                out.extend(merged)
            else:
                out.append(p)
        for text in out:
            items.append({"group": group, "text": text})
    return items


def is_checklist(task, tp, section):
    a = task.get("action") or ""
    if LOC_PREFIX_RE.search(a) or "\n物料：" in a:
        return True
    if re.match(r"^確認晚課物料", a) and task.get("note"):
        return True
    period = (tp.get("periodLabel") or "") + (section.get("title") or "")
    prep_ctx = any(k in period for k in ["佈場", "整理", "安板", "養息", "準備", "撤場", "出坡"])
    enum_n = len(re.split(r"[、；\n]", a))
    return prep_ctx and enum_n >= 3


def is_ceremony_ctx(tp, section):
    period = tp.get("periodLabel") or ""
    title = section.get("title") or ""
    if any(k in period for k in SIMPLE_PERIODS):
        return False
    return any(k in period or k in title for k in CEREMONY_KEYS)


def extract_cue(action: str):
    first_line = action.split("\n", 1)[0]
    for pat in CUE_PATTERNS:
        m = pat.match(first_line)
        if m:
            cue, rest = m.group(1).strip(), m.group(2).strip()
            if 2 <= len(cue) <= 24 and CUE_ACCEPT.match(cue):
                tail = action.split("\n", 1)
                rest_full = rest + ("\n" + tail[1] if len(tail) > 1 else "")
                return cue, rest_full
    return None, action


def enrich_day(path: Path):
    day = json.loads(path.read_text())
    stats = {"checklist": 0, "step": 0, "simple": 0}
    for section in day["sections"]:
        for tp in section["timePoints"]:
            ceremony = is_ceremony_ctx(tp, section)
            for task in tp["tasks"]:
                # 冪等：先清掉舊標註
                for k in ("display", "items", "cue", "stepAction"):
                    task.pop(k, None)
                ov = OVERRIDES.get(task["id"])
                a = task.get("action") or ""
                if ov == "simple":
                    stats["simple"] += 1
                    continue
                if ov == "checklist" or (ov is None and is_checklist(task, tp, section)):
                    items = split_items(a, task.get("note"))
                    if len(items) >= 2:
                        task["display"] = "checklist"
                        task["items"] = [
                            {"id": f"i{n+1}", "group": it["group"], "text": it["text"]}
                            for n, it in enumerate(items)
                        ]
                        stats["checklist"] += 1
                        continue
                if ov == "step" or (
                    ov is None and ceremony and not SIMPLE_ACTION_RE.match(a)
                ):
                    task["display"] = "step"
                    cue, rest = extract_cue(a)
                    if cue:
                        task["cue"] = cue
                        task["stepAction"] = rest
                    stats["step"] += 1
                    continue
                stats["simple"] += 1
    path.write_text(json.dumps(day, ensure_ascii=False, indent=2) + "\n")
    return day, stats


def main():
    report = "--report" in sys.argv
    totals = {"checklist": 0, "step": 0, "simple": 0}
    for path in sorted(SCHEDULE.glob("day-*.json")):
        day, stats = enrich_day(path)
        for k in totals:
            totals[k] += stats[k]
        if report:
            print(f"\n════ {day['label']} ════")
            for s in day["sections"]:
                for tp in s["timePoints"]:
                    tlabel = tp["time"].get("value") or tp["time"].get("raw")
                    for t in tp["tasks"]:
                        d = t.get("display")
                        if d == "checklist":
                            print(f"[清單] {tlabel} {t['id']}")
                            for it in t["items"]:
                                g = f"（{it['group']}）" if it["group"] else ""
                                print(f"    ☐ {g}{it['text']}")
                        elif d == "step":
                            cue = f"〔{t['cue']}〕" if t.get("cue") else "〔—〕"
                            act = (t.get("stepAction") or t["action"]).split("\n")[0][:50]
                            print(f"[步驟] {tlabel} {t['id']} {cue} {act}")
    print(f"\n合計: {totals}")


if __name__ == "__main__":
    main()
