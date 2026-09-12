# apps

業務効率化アプリを1つずつ追加していくディレクトリ。各アプリは `apps/<app-name>/` に、内容が分かる英語スラッグ名で配置する。

| app-name | 内容 | 状況 |
|---|---|---|
| `cleaning-schedule` | 民泊清掃予定の自動割り当て Web アプリ（Cloudflare） | 実装中（割り当てエンジン完了） |
| `schedule-auto-assign` | 民泊清掃予定の自動割り当て（GAS版） | 旧版。`cleaning-schedule` へ移行中のため凍結 |
| `construction-schedule` | ホームメーカー工程表の自動化マクロ | Phase 1 実装完了・テスト待ち |
