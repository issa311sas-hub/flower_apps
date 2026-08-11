#!/usr/bin/env python3
"""vba/*.bas (UTF-8) から、VBE インポート用の Shift-JIS 版を生成する。

VBE の「ファイルのインポート」は .bas を OS の ANSI コードページとして読む。
日本語版 Windows では CP932(Shift-JIS) なので、UTF-8 のままインポートすると
マクロ名・シート名・判定文字列がすべて文字化けする。

    vba/       … UTF-8。編集するのはこちら（GitHub 上で読めるのもこちら）
    vba/sjis/  … CP932。Excel に取り込むのはこちら（このスクリプトが生成）

使い方:
    python tools/make_import_bas.py

vba/ を編集したら、必ずこれを実行して vba/sjis/ を作り直すこと。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "vba")
DST = os.path.join(SRC, "sjis")

# VBE は CRLF を前提にしている
NEWLINE = "\r\n"


PROC_RE = re.compile(r"^\s*(Public\s+|Private\s+|Friend\s+)?(Sub|Function|Property)\s", re.I)
END_RE = re.compile(r"^\s*End\s+(Sub|Function|Property)\s*$", re.I)
DECL_RE = re.compile(r"^\s*(Public|Private|Dim|Global)\s+(Const\s+|WithEvents\s+)?[A-Za-z_]", re.I)


def check_declarations(path, text):
    """モジュールレベルの宣言がプロシージャより後ろに無いか確かめる。

    VBA は Const / Dim などのモジュールレベル宣言を冒頭の宣言セクションに
    まとめる必要がある。途中に書くと
    「End Sub、End Function または End Property 以降には、コメントのみが
    記述できます」というコンパイルエラーになる。
    Excel を開くまで気づけないので、ここで止める。
    """
    inside = False
    seen_proc = False
    for i, line in enumerate(text.split("\n"), 1):
        s = line.strip()
        if not s or s.startswith("'"):
            continue
        if PROC_RE.match(line):
            inside, seen_proc = True, True
            continue
        if END_RE.match(line):
            inside = False
            continue
        if not inside and seen_proc and DECL_RE.match(line):
            raise SystemExit(
                f"{os.path.basename(path)} の {i} 行目にモジュールレベルの宣言があります:\n"
                f"    {s}\n"
                f"VBA では Const / Dim はモジュール冒頭の宣言セクションにまとめる必要があります。\n"
                f"このままでは Excel でコンパイルエラーになります。"
            )


def convert(path, out_path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()

    check_declarations(path, text)

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = NEWLINE.join(text.split("\n"))

    try:
        data = text.encode("cp932")
    except UnicodeEncodeError as e:
        bad = text[e.start:e.end]
        line = text[: e.start].count("\n") + 1
        raise SystemExit(
            f"{os.path.basename(path)} の {line} 行目に "
            f"Shift-JIS で表せない文字があります: {bad!r}\n"
            f"半角の代替文字に置き換えてください。"
        )

    # CP932 で往復しても壊れないことを確認する。
    # 波ダッシュ(U+301C)のように往復で別の文字になるものを取りこぼさないため。
    back = data.decode("cp932")
    if back != text:
        for i, (x, y) in enumerate(zip(text, back)):
            if x != y:
                line = text[:i].count("\n") + 1
                raise SystemExit(
                    f"{os.path.basename(path)} の {line} 行目で往復に失敗しました: "
                    f"{x!r} (U+{ord(x):04X}) -> {y!r} (U+{ord(y):04X})\n"
                    f"CP932 と往復できる文字に置き換えてください。"
                )
        raise SystemExit(f"{os.path.basename(path)} の往復に失敗しました（長さ違い）。")

    with open(out_path, "wb") as fh:
        fh.write(data)
    return len(data)


def main():
    if not os.path.isdir(SRC):
        sys.exit(f"{SRC} が見つかりません。")
    os.makedirs(DST, exist_ok=True)

    names = sorted(f for f in os.listdir(SRC) if f.endswith(".bas"))
    if not names:
        sys.exit(f"{SRC} に .bas がありません。")

    for name in names:
        size = convert(os.path.join(SRC, name), os.path.join(DST, name))
        print(f"  {name:<28} -> vba/sjis/{name}  ({size:,} バイト)")

    print(f"\n{len(names)} ファイルを CP932 で書き出しました。")
    print("Excel には vba/sjis/ の方をインポートしてください。")


if __name__ == "__main__":
    main()
