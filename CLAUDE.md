# flower_apps

業務効率化のための社内向けアプリケーション集。1テーマ = 1アプリを `apps/` 以下に追加していくリポジトリ。

## 現在の状況

- 「民泊清掃予定の自動割り当て Web アプリ」(`apps/cleaning-schedule/`) **本番稼働中**。
  Cloudflare Workers + D1。旧版(GAS)からの切り替えは完了しており、旧版は停止している。

  実装済み: 割り当てエンジンの移植と旧版との一致テスト（parity）、データ層、認証、
  スタッフ画面（予定の一覧・カレンダー表示、出勤入力のカレンダー/一覧）、
  管理画面（割り当て一覧・手動固定、タイムライン、出勤回答の一覧、設定、実行ログ）、
  Beds24連携、Slack通知、清掃完了報告（使用状況・設備・追加サービスと**現地精算金額の月次集計**）、
  稼働監視（`/api/health` は異常時503、cron の呼び出し記録、UptimeRobot からの死活監視）、
  マイグレーション運用（`schema_migrations` と管理画面からの適用）。

  残っていること:
  - **旧スプレッドシートの割り当て結果と数行つき合わせる。**
    ユニットの対応づけ間違いは、予約が取れて画面も正常に見えるため、これでしか見つからない。
  - 未着手: 給与計算（件数 × 単価 − 現地精算）、管理者による代理入力、
    出勤未入力のスタッフへの Slack 催促。

  方針と障害の記録は `apps/cleaning-schedule/docs/decisions.md`、
  手順は `apps/cleaning-schedule/docs/setup-cloudflare-beginner.md`。
- 「予定自動割り当てアプリ」(`apps/schedule-auto-assign/`) 旧版(GAS)。v8 まで実装済み。
  `cleaning-schedule` へ移行済みで、**停止している**。
  割り当てロジックの参照元（parity テストの比較対象）として残すが、
  **稼働させる先としては使えない。** Beds24 のトークン更新に
  `refreshToken` ではなく `token` ヘッダを送る不具合があり（`src/Code.gs:1720`）、
  動かしても予約を取得できない。旧版が静かに止まった原因もおそらくこれ
  （`apps/cleaning-schedule/docs/decisions.md` に経緯）。
- 「ホームメーカー工程表の自動化マクロ」(`apps/construction-schedule/`) Phase 1 実装完了。
  Phase 1 は v13（業者をシートから読む・祝日は稼働日）まで実装済み。Phase 2 は工事店さまへの確認事項の回答待ち（`docs/03-open-questions.md`)。

## 開発方針

### エージェント運用

- 通常はデフォルトの単一エージェントで作業する。複数エージェントの「チーム編成」は、明確に並列化できる大規模タスクがある場合のみ検討する。
- 現時点でこのリポジトリに `.claude/agents/` によるカスタムエージェント定義は置かない。将来、特定の役割分担(例: フロント/バックエンド/QAを常に並列で回す)が明確に有効だと分かった場合のみ追加を検討する。

### スキル運用

- タスクの開始時・完了時は `.claude/skills/skill-curator/SKILL.md` の手順に従い、関連スキルの検索・活用と、再利用可能な知見のスキル化を行う。
- 現在のスキル: `skill-curator`、`cloudflare-workers-ops`（Cloudflare/D1 の運用と、外部API移植の落とし穴）。

## ディレクトリ構成

- `apps/<app-name>/` : 各業務効率化アプリのソース一式。アプリ名は内容が分かる英語スラッグを使う(例: `schedule-auto-assign`)。
- `.claude/skills/` : このリポジトリ専用のスキル定義。
