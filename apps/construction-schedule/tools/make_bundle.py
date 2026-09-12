#!/usr/bin/env python3
"""vba/*.bas と vba/userform/*.txt を、1つのテキストファイルにまとめる。

M90_Loader（ローダー）がこのファイルを読んで、モジュールを一括で入れ替える。
利用者はこの1ファイルをダウンロードするだけで済む。

出力 : dist/工程表マクロ.txt （UTF-8）

    python tools/make_bundle.py

■ なぜ UTF-8 のままでよいか
ローダーは ADODB.Stream で UTF-8 として読み、CodeModule.AddFromString で
流し込む。VBE の「ファイルのインポート」（ANSI 決め打ち）を通らないので、
Shift-JIS へ変換する必要がなく、文字化けも起きない。

■ 目印
各モジュールの前に次の行を入れる。ローダーはこれで切り分ける。

    '>>>MODULE:M00_Config
    '>>>USERFORM:F_イベント入力
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VBA = os.path.join(ROOT, "vba")
FORMS = os.path.join(VBA, "userform")
OUT_DIR = os.path.join(ROOT, "dist")
OUT_NAME = "工程表マクロ.txt"

MARK_MODULE = "'>>>MODULE:"
MARK_FORM = "'>>>USERFORM:"

# ローダー自身も入れておく（入れ替えはされないが、中身を追えるようにする）
LOADER = "M90_Loader"


def strip_header(src):
    """Attribute 行を落とす。

    AddFromString で流し込むときは Attribute 行を書けない
    （ファイル形式のためのもので、コードとしては書けない）。
    """
    out = []
    for line in src.splitlines():
        if line.startswith("Attribute "):
            continue
        out.append(line)
    # 先頭の空行を落とす
    while out and not out[0].strip():
        out.pop(0)
    return "\n".join(out).rstrip() + "\n"


def main():
    if not os.path.isdir(VBA):
        sys.exit(f"{VBA} がありません。")

    modules = sorted(f for f in os.listdir(VBA) if f.endswith(".bas"))
    if not modules:
        sys.exit(f"{VBA} に .bas がありません。")

    forms = []
    if os.path.isdir(FORMS):
        forms = sorted(f for f in os.listdir(FORMS) if f.endswith(".txt"))

    parts = []
    parts.append(
        "'=====================================================================\n"
        "' 工程表マクロ － 全モジュールをまとめたファイル\n"
        "'\n"
        "' このファイルは直接インポートできません。\n"
        "' Excel で「ボタン_マクロを更新」を実行し、このファイルを選んでください。\n"
        "' （M90_Loader モジュールを最初に1回だけ取り込んでおく必要があります）\n"
        "'\n"
        f"' モジュール : {len(modules)} 個 / ユーザーフォーム : {len(forms)} 個\n"
        "'=====================================================================\n"
    )

    listed = []
    for name in modules:
        base = os.path.splitext(name)[0]
        src = open(os.path.join(VBA, name), encoding="utf-8").read()
        parts.append(f"\n{MARK_MODULE}{base}\n")
        parts.append(strip_header(src))
        listed.append(base)

    for name in forms:
        base = os.path.splitext(name)[0]
        src = open(os.path.join(FORMS, name), encoding="utf-8").read()
        parts.append(f"\n{MARK_FORM}{base}\n")
        parts.append(strip_header(src))
        listed.append(base)

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, OUT_NAME)
    with open(out_path, "w", encoding="utf-8", newline="\r\n") as f:
        f.write("".join(parts))

    size = os.path.getsize(out_path)
    print(f"{out_path}  ({size:,} バイト)")
    for name in listed:
        mark = "  ← 入れ替え対象外（実行中のため）" if name == LOADER else ""
        print(f"  {name}{mark}")
    print()
    print("利用者がダウンロードするのはこの1ファイルだけです。")
    print("初回だけ vba/sjis/M90_Loader.bas を手で取り込んでください。")


if __name__ == "__main__":
    main()
