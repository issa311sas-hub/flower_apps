# schedule-auto-assign

民泊清掃予定の自動割り当てシステム。

## 概要

沖縄の民泊事業(9ユニット)の清掃スケジュールを自動化する。
Beds24から出力されるExcelの予約データと、Googleカレンダー上のスタッフ出勤可否を突合し、清掃担当を自動割り当てしてカレンダーに反映する。

## 技術スタック

- Google スプレッドシート（管理画面・データ入力）
- Google Apps Script（マッチングロジック・自動実行）
- Google Calendar API（スタッフ予定の読み取り・割り当て結果の書き込み）

## ドキュメント

- [要件定義](docs/requirements.md)
- [設計判断ログ](docs/decisions.md)
- [サンプルデータ](docs/sample-data/)

## ステータス

要件定義・設計フェーズ（実装未着手）
