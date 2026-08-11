#!/usr/bin/env python3
"""過去の工程表(.xls)を解析して、工程の実測期間を抽出する。

docs/02-duration-hypothesis.md の数字はこのスクリプトで作った。
新しい過去データが手に入ったら、同じコマンドで対応表を作り直せる。

使い方:
    pip install xlrd==2.0.2
    python analyze_chart.py <工程表が入っているディレクトリ>

.xls (BIFF8) 専用。xlrd 2.x は .xlsx を読めないので、
新しい形式で渡された場合は Excel で「Excel 97-2003 ブック」に保存し直すこと。
"""

import os
import re
import sys
import json
import statistics as st
from collections import defaultdict
from datetime import date

import xlrd

# --- 工程表のレイアウト (xlrd の 0 始まりインデックス) ---
ROW_DATE = 2          # 日付行
COL_DATE_FIRST = 16   # 日付エリアの先頭列
ROW_BLOCK_1ST = 4     # 最初の物件ブロック
BLOCK_ROWS = 6

COL_NAME = 10         # 邸名   (ブロック先頭行)
COL_TYPE = 12         # タイプ (先頭行 +1)
COL_TSUBO = 13        # 坪数   (先頭行 +2)

# ブロック内の行オフセット
OFS_KUTAI, OFS_KUTAI_SUB, OFS_NOTE, OFS_KOTE, OFS_KISO, OFS_KISO_SUB = range(6)

CLR_HOLIDAY = 50      # 黄緑 (153,204,0) 日曜・祝日
CLR_BLACK = 8         # 黒
KUTAI_COLORS = {60, 46}   # 茶 / 薄紫 = 躯体の2チーム
NO_FILL = {64, 65, 0, None}

ANCHORS = (
    "CO", "先足", "足場", "穴明け", "防水", "シーリング", "乾燥", "断熱工事",
    "内部配管", "先床施工", "UB設置", "M1", "M3", "M4", "M5",
    "６日養生", "グラインドコラム", "養生期間",
)


def load_sheet(path):
    """シート '1' と、日付↔列の対応を返す。"""
    wb = xlrd.open_workbook(path, formatting_info=True)
    sh = wb.sheet_by_name("1")
    dates = {}
    for c in range(sh.ncols):
        v = sh.cell_value(ROW_DATE, c)
        if isinstance(v, float) and v > 40000:
            dates[c] = xlrd.xldate_as_datetime(v, wb.datemode).date()
    return wb, sh, dates


def find_blocks(sh):
    """邸名で始まる物件ブロックの開始行を返す。"""
    blocks, r = [], ROW_BLOCK_1ST
    while r < sh.nrows:
        v = sh.cell_value(r, COL_NAME)
        if isinstance(v, str) and v.endswith("邸"):
            blocks.append(r)
            r += BLOCK_ROWS
        else:
            r += 1
    return blocks


def extract(path):
    """1ファイルから物件ごとの工程実測値を取り出す。"""
    wb, sh, dates = load_sheet(path)
    if not dates:
        return []
    xf = wb.xf_list
    cols = sorted(dates)
    win = (dates[cols[0]], dates[cols[-1]])

    def bg(row, col):
        b = xf[sh.cell_xf_index(row, col)].background.pattern_colour_index
        return None if b in NO_FILL or b == CLR_HOLIDAY else b

    out = []
    for b in find_blocks(sh):
        typ = str(sh.cell_value(b + 1, COL_TYPE)).strip()
        if not typ:
            continue

        # 躯体: 上2行のチーム色
        kutai = sorted({dates[c] for off in (OFS_KUTAI, OFS_KUTAI_SUB)
                        for c in cols if bg(b + off, c) in KUTAI_COLORS})
        kstart = kutai[0] if kutai else None

        # 契約着工日: 基礎行の黒1マス
        chakko = sorted({dates[c] for off in (OFS_KISO, OFS_KISO_SUB)
                         for c in cols if bg(b + off, c) == CLR_BLACK})

        # コテ: コテ行の黒帯
        kote = sorted({dates[c] for c in cols if bg(b + OFS_KOTE, c) == CLR_BLACK})

        # 基礎: 基礎行の色帯のうち、躯体着手より前のもの（黒マーカーは除く）
        kiso = []
        for c in cols:
            col = bg(b + OFS_KISO, c) or bg(b + OFS_KISO_SUB, c)
            if col is None or col == CLR_BLACK:
                continue
            if kstart and dates[c] >= kstart:
                continue
            kiso.append(dates[c])

        anchors = {}
        for off in range(BLOCK_ROWS):
            for c in cols:
                v = sh.cell_value(b + off, c)
                if isinstance(v, str) and v.strip() in ANCHORS:
                    anchors.setdefault(v.strip(), []).append(str(dates[c]))

        out.append(dict(
            file=os.path.basename(path),
            window=[str(win[0]), str(win[1])],
            name=str(sh.cell_value(b, COL_NAME)).replace("　", " ").strip(),
            type=typ,
            tsubo=str(sh.cell_value(b + 2, COL_TSUBO)).strip(),
            kiso=[str(kiso[0]), str(kiso[-1]), len(kiso)] if kiso else None,
            kutai=[str(kutai[0]), str(kutai[-1]), len(kutai)] if kutai else None,
            kote=[str(kote[0]), str(kote[-1]), len(kote)] if kote else None,
            chakko=[str(x) for x in chakko],
            anchors=anchors,
        ))
    return out


def dedupe(records):
    """同一物件が複数ファイルに出るので、最も情報量が多いものを残す。"""
    best = {}
    for r in records:
        key = (r["name"], r["type"])
        score = (r["kiso"] is not None) + (r["kutai"] is not None) + len(r["anchors"]) * 0.01
        if key not in best or best[key][0] < score:
            best[key] = (score, r)
    return [v[1] for v in best.values()]


def to_date(s):
    return date(*map(int, s.split("-")))


def clean(records):
    """契約着工日〜躯体完了が表示期間に完全に収まっているものだけ残す。"""
    rows = []
    for r in records:
        if not (r["kiso"] and r["kutai"] and r["chakko"]):
            continue
        m = re.match(r"^([A-Z]+?)(\d?)([EF])(\d+)$", r["type"])
        if not m:
            continue
        ks, ke = to_date(r["kiso"][0]), to_date(r["kiso"][1])
        qs, qe = to_date(r["kutai"][0]), to_date(r["kutai"][1])
        ch = to_date(r["chakko"][0])
        w0, w1 = to_date(r["window"][0]), to_date(r["window"][1])
        if (ch - w0).days < 3 or (qe - w1).days > -10:
            continue
        lag = (ks - ch).days
        if not 0 <= lag <= 10:      # 表示期間の端で拾い損ねたもの
            continue
        rows.append(dict(
            name=r["name"], type=r["type"],
            kind=m.group(1), floors=m.group(2) or "?", area=int(m.group(4)),
            kiso_days=r["kiso"][2], kiso_span=(ke - ks).days + 1,
            kutai_days=r["kutai"][2],
            kote_days=r["kote"][2] if r["kote"] else None,
            lag_chakko_kiso=lag, gap_kiso_kutai=(qs - ke).days,
        ))
    return rows


BANDS = [(0, 32), (33, 39), (40, 47), (48, 55), (56, 70), (71, 100), (101, 999)]


def band_of(area):
    for lo, hi in BANDS:
        if lo <= area <= hi:
            return f"{lo or 25}〜{hi}坪"
    return "?"


def report(rows):
    print(f"対象物件: {len(rows)} 件\n")
    print("=== 広さ帯 × 工程（中央値・稼働日数） ===")
    print(f"{'広さ帯':<12}{'件数':>4}{'基礎':>8}{'基礎暦':>8}{'躯体':>8}{'コテ':>8}")
    grouped = defaultdict(list)
    for x in rows:
        grouped[band_of(x["area"])].append(x)
    for lo, hi in BANDS:
        b = band_of(lo)
        v = grouped.get(b)
        if not v:
            continue
        def med(f):
            z = [y[f] for y in v if y[f] is not None]
            return f"{st.median(z):.0f}" if z else "-"
        print(f"{b:<12}{len(v):>4}{med('kiso_days'):>8}{med('kiso_span'):>8}"
              f"{med('kutai_days'):>8}{med('kote_days'):>8}")

    print("\n=== 階数 × 広さ帯 → 躯体日数 ===")
    g2 = defaultdict(list)
    for x in rows:
        g2[(x["floors"], band_of(x["area"]))].append(x["kutai_days"])
    print(f"{'階':<4}" + "".join(f"{band_of(lo):>12}" for lo, _ in BANDS))
    for fl in sorted({x["floors"] for x in rows}):
        line = f"{fl:<4}"
        for lo, _ in BANDS:
            v = g2.get((fl, band_of(lo)))
            line += f"{f'{st.median(v):.0f}({len(v)})':>12}" if v else f"{'-':>12}"
        print(line)

    print("\n=== 工程間インターバル（暦日） ===")
    for f, label in (("lag_chakko_kiso", "契約着工日→基礎着手"),
                     ("gap_kiso_kutai", "基礎完了→躯体着手")):
        v = [x[f] for x in rows]
        print(f"  {label}: 中央値{st.median(v):.0f}  範囲{min(v)}〜{max(v)}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    paths = [os.path.join(src, f) for f in sorted(os.listdir(src)) if f.endswith(".xls")]
    if not paths:
        print(f"{src} に .xls が見つかりません。")
        sys.exit(1)

    records = []
    for p in paths:
        records.extend(extract(p))
    records = dedupe(records)
    rows = clean(records)

    report(rows)

    with open("chart_analysis.json", "w", encoding="utf-8") as fh:
        json.dump({"records": records, "clean": rows}, fh, ensure_ascii=False,
                  indent=1, default=str)
    print("\n詳細を chart_analysis.json に書き出しました。")


if __name__ == "__main__":
    main()
