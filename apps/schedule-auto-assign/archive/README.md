# archive

Code.gs の変更履歴を日付・バージョン別に保管するフォルダ。

```
archive/
  2026-07-20/
    v1/            ← 初版
      Code.gs
      CHANGELOG.md
    v2/            ← 同日に2回目の変更があった場合
      Code.gs
      CHANGELOG.md
  2026-07-25/
    v1/
      ...
```

## ルール
- 日付は変更を行った日（YYYY-MM-DD）
- 同日に複数回変更がある場合は v1, v2, ... と番号を振る
- 各バージョンに CHANGELOG.md を置き、変更内容を記録する
