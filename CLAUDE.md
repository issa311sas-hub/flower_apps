# flower_apps

業務効率化のための社内向けアプリケーション集。1テーマ = 1アプリを `apps/` 以下に追加していくリポジトリ。

## 現在の状況

- 「民泊清掃予定の自動割り当て Web アプリ」(`apps/cleaning-schedule/`) 実装中。
  Cloudflare Workers + D1 への全面移行版。すでに Cloudflare 上で動いている。
  割り当てエンジンの移植と旧版との一致テスト（parity）、データ層、認証、スタッフ画面、
  Beds24連携（接続・ユニット対応づけ・手動実行）まで完了。
  残りは管理画面の続き（手動変更・タイムライン・設定）、Slack通知、旧版との並行稼働と切り替え。
  方針は `apps/cleaning-schedule/docs/decisions.md`、手順は `docs/setup-cloudflare-beginner.md`。
- 「予定自動割り当てアプリ」(`apps/schedule-auto-assign/`) 旧版(GAS)。v8 まで実装済みだが、
  `cleaning-schedule` へ移行中のため凍結。移行完了までロールバック先として残す。
- 「ホームメーカー工程表の自動化マクロ」(`apps/construction-schedule/`) Phase 1 実装完了。
  Phase 1 は v13（業者をシートから読む・祝日は稼働日）まで実装済み。Phase 2 は工事店さまへの確認事項の回答待ち（`docs/03-open-questions.md`)。

## 開発方針

### エージェント運用

- 通常はデフォルトの単一エージェントで作業する。複数エージェントの「チーム編成」は、明確に並列化できる大規模タスクがある場合のみ検討する。
- 現時点でこのリポジトリに `.claude/agents/` によるカスタムエージェント定義は置かない。将来、特定の役割分担(例: フロント/バックエンド/QAを常に並列で回す)が明確に有効だと分かった場合のみ追加を検討する。

### スキル運用

- タスクの開始時・完了時は `.claude/skills/skill-curator/SKILL.md` の手順に従い、関連スキルの検索・活用と、再利用可能な知見のスキル化を行う。

## ディレクトリ構成

- `apps/<app-name>/` : 各業務効率化アプリのソース一式。アプリ名は内容が分かる英語スラッグを使う(例: `schedule-auto-assign`)。
- `.claude/skills/` : このリポジトリ専用のスキル定義。
