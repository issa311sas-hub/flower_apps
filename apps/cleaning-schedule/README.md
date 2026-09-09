# cleaning-schedule

民泊清掃予定の自動割り当て Web アプリ（Cloudflare Workers + D1）。

`apps/schedule-auto-assign/`（Google スプレッドシート + GAS + Google カレンダー版）の後継。
清掃スタッフが Google カレンダーを使いこなせず、スマホの容量の都合でアプリも入れられないため、
**インストール不要でブラウザから使える Web アプリ**に置き換える。

## 概要

- 沖縄の民泊事業（9ユニット: b2, b3, b4, b5, b6, c4, s1, s2, s3）の清掃担当を自動で割り当てる
- Beds24 API V2 から予約を取得し、スタッフが Web で入力した出勤可能件数と突き合わせる
- スタッフはスマホで「自分の清掃予定の確認」「出勤可能件数の入力」「完了報告」だけを行う
- 経営者は管理画面で確認・手動変更・スタッフ管理・手動実行を行う
- Google カレンダーとスプレッドシートは使わない

## 技術スタック

| 層 | 採用 |
|---|---|
| 実行基盤 | Cloudflare Workers（静的アセット配信つき）+ Cron Triggers |
| DB | Cloudflare D1（SQLite） |
| 画面 | サーバーレンダリングの HTML + 最小限の素の JavaScript（フレームワークなし） |
| テスト | Vitest |

> **なぜ Pages ではなく Workers か**: Cloudflare Pages Functions は Cron Triggers（定期実行）に
> 対応しておらず、このシステムの中心である「毎日の自動実行」ができない。
> 現在の Workers は静的ファイル配信で Pages と同等のため、Workers 1つにまとめている。

## ファイル構成

```
migrations/
  0001_init.sql       ← D1 のスキーマ
  0002_seed_master.sql←   9ユニット・担当者4名・既定の設定
src/
  index.js            ← Worker のエントリ（fetch / scheduled）
  core/               ← ★Cloudflare に依存しない純粋ロジック（テスト対象）
    assign.js         ←   割り当てアルゴリズム（Phase 1〜4）
    deadlines.js      ←   清掃期限の計算
    diff.js           ←   前回との差分計算
    nextGuests.js     ←   「次に泊まる人数」の算出
    dates.js          ←   JST前提の日付ユーティリティ
  db/                 ← D1 アクセス（1テーブル群につき1ファイル）
    settings.js staff.js units.js bookings.js
    availability.js assignments.js runs.js notifications.js
    beds24Auth.js     ←   Beds24のトークン（暗号化して保存）
    migrate.js        ←   /setup で使う初回セットアップ（空のDBのときだけ動く）
  integrations/
    beds24.js         ←   Beds24 API V2（認証・予約取得）
    crypto.js         ←   AES-GCM / PBKDF2（Web Cryptoのみ）
  jobs/
    dailyRun.js       ←   毎朝6時: 取得→割り当て→保存→通知
    keepAlive.js      ←   毎日18時: トークン維持・稼働監視・セッション掃除
tools/
  build-console-sql.mjs ← migrations から Console 貼り付け用SQLを生成（保険）
test/
  parity.test.js      ← ★旧 GAS 版との出力一致テスト（ランダム2000シナリオ）
  legacy/             ←   比較用にコピーした旧ロジック
  core/               ←   業務ルール・日付・純粋性のテスト
  db/                 ←   データ層のテスト（実スキーマ・実SQLで検証）
  support/d1-sqlite.js←   node:sqlite の上に D1 互換APIをかぶせたテスト用アダプタ
wrangler.jsonc        ← Worker 設定（D1 バインディング・cron）
```

**`src/core/` は D1・ネットワーク・現在時刻に触れない**。
この制約は `test/core/purity.test.js` で機械的に検査している。

## 開発

```bash
npm install
npm test          # 割り当てエンジンのテスト（Cloudflare 不要）
npm run dev       # ローカルで Worker を起動
```

## 実装状況

- [x] 割り当てエンジンの移植（旧版とのランダム2000シナリオ一致を確認）
- [x] 清掃期限・差分計算・JST日付ユーティリティ
- [x] D1 スキーマとデータ層（実スキーマに対するテスト42件）
- [x] Beds24 API 連携・日次処理・見張り役（cron 接続済み。Beds24 への実接続は未実施）
- [ ] 認証とスタッフ画面
- [ ] 管理画面
- [ ] Slack 通知・稼働監視
- [ ] デプロイと移行

## ステータス

実装中（割り当てエンジンのみ完了）
