# デプロイ手順（開発者向け）

Cloudflare への接続と、以降の更新方法。
経営者・スタッフ向けの操作説明は `setup-guide.md`（別途作成）を参照。

---

## いつ接続するか

**全部できてからではなく、早めに1回つなぐことを推奨する。** 理由:

1. アカウント作成・課金設定・権限まわりは、後回しにすると最後に詰まる
2. D1 は SQLite だがテスト環境（`node:sqlite`）と完全に同じではない。
   実物にマイグレーションを当てて初めて分かることがある
3. Beds24 連携は**本物の API でしか検証できない**。手元では確かめようがない
4. スタッフの出勤入力画面は、実機で触ってもらって初めて良し悪しが分かる。
   この画面が使えるかどうかが移行の成否そのものなので、早く触らせたい

一方で、**スタッフに URL を配るのは管理画面まで出来てから**でよい。
ログインが必要なので、デプロイしてあっても関係者以外は何も見られない。

---

## ⚠ 先に確認すること: Beds24 のトークン競合

Beds24 はトークンを取得するたびにリフレッシュトークンを**ローテーション**する
（`Code.gs:1769-1771`）。現行の GAS 版と新システムが同じトークンを使うと、
**片方が突然 401 で止まる**。

公式ドキュメントには「招待コードは複数発行できる」とあるが、
**発行したリフレッシュトークンが同時に複数生きるかは明記されていない**。
そのため、次の順で確かめる。

1. Beds24 で**新しい招待コード**を発行し、新システム側だけを接続する
   （GAS 側のトークンには絶対に触らない）
2. 接続後、GAS 側で「🧹 清掃管理 → Beds24から予約データ取得」を手動実行する
3. **GAS 側が成功すれば共存できる** → そのまま並行稼働に進める
4. GAS 側が 401 で失敗したら共存できない → 並行稼働の期間は
   「新システムが Beds24 を持ち、GAS は Excel 手貼りで動かす」に切り替える

どちらに転んでも作業は進められる。先に知っておくことが重要。

---

## 初回セットアップ

所要 30〜45分。**アカウントは経営者のメールアドレスで作る**（資産を経営者のものにするため）。

### 1. Cloudflare アカウント

1. https://dash.cloudflare.com/sign-up で登録（無料プラン。クレジットカード不要）
2. メールアドレスの確認を済ませる

### 2. 手元の準備

```bash
# Node.js LTS が入っていること
node -v

cd apps/cleaning-schedule
npm install
npx wrangler login       # ブラウザが開くので承認する
```

### 3. D1 データベースを作る

```bash
npx wrangler d1 create cleaning-schedule
```

出力される `database_id` を `wrangler.jsonc` の該当箇所に貼る。

```bash
npx wrangler d1 migrations apply cleaning-schedule --remote
```

`--remote` を付け忘れるとローカルの疑似DBに当たるだけなので注意。

### 4. Secrets を登録する

```bash
npx wrangler secret put SESSION_PEPPER    # 十分に長いランダム文字列
npx wrangler secret put TOKEN_ENC_KEY     # 32バイトのランダム値(base64)
```

生成例:

```bash
openssl rand -base64 32
```

> **Beds24 のリフレッシュトークンは Secrets に入れない。**
> ローテーションするため実行中に書き換える必要があり、Cloudflare の Secrets は
> 実行中に書き換えられない。D1 に暗号化して保存する（その鍵が `TOKEN_ENC_KEY`）。

### 5. デプロイ

```bash
npx wrangler deploy
```

`https://cleaning-schedule.<サブドメイン>.workers.dev` が発行される。この URL を控える。

### 6. 動作確認

```bash
curl https://cleaning-schedule.<サブドメイン>.workers.dev/api/health
```

Cloudflare ダッシュボード → Workers & Pages → cleaning-schedule → Settings → Triggers で
cron が2件（`0 21 * * *` と `0 9 * * *`）登録されていることを確認する。

> **cron は UTC 指定**。`0 21 * * *` は翌日 06:00 JST。日本時間ではないので、
> 「21時に動いている」と勘違いしないこと。

---

## 以降の更新

### GitHub Actions（推奨。ターミナル不要）

`.github/workflows/deploy.yml` を用意してある。
リポジトリの Settings → Secrets and variables → Actions に以下を登録すれば、
`apps/cleaning-schedule/**` への push で自動デプロイされる。

| Secret 名 | 取得方法 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare ダッシュボード → My Profile → API Tokens → Create Token<br>権限は **Workers Scripts:Edit** と **D1:Edit** の2つだけ付ける |
| `CLOUDFLARE_ACCOUNT_ID` | ダッシュボードの Workers ページ右側に表示されている ID |

**マイグレーションは自動実行しない**（`workflow_dispatch` の手動実行にしてある）。
スキーマ変更が push のついでに本番へ当たる事故を防ぐため。

### 手動

```bash
cd apps/cleaning-schedule
npm test          # 先にテストを通すこと（新旧一致テストを含む）
npx wrangler deploy
```

---

## 日常の運用

初回セットアップ後、**経営者はターミナルを触らない**。
予約の取得・割り当て・カレンダー相当の確認はすべて管理画面から行う。

| やりたいこと | 方法 |
|---|---|
| 今すぐ取得して割り当て直す | 管理画面の「今すぐ実行」 |
| スタッフの追加・パスワード再発行 | 管理画面のスタッフ管理 |
| Beds24 の再接続 | 管理画面から招待コードを入力 |
| 実行状況・エラーの確認 | 管理画面のダッシュボードと実行ログ |
| データのバックアップ | 管理画面の CSV エクスポート |

---

## 費用

無料枠に収まる想定。

| 項目 | 無料枠 | 想定 |
|---|---|---|
| Workers リクエスト | 100,000/日 | 200〜500/日 |
| D1 行読み取り / 書き込み | 5,000,000 / 100,000 per 日 | 数千 / 数百 |
| D1 ストレージ | 5 GB | 数 MB |
| Cron Triggers | 5個/アカウント | 2個 |

ひとつだけ注意が要るのが **CPU 時間（無料プランは 1リクエスト 10ms）**。
ログイン時のパスワードハッシュ計算がここに引っかかる可能性がある。
初回デプロイ後に Workers の Observability で実測し、超えるようなら
反復回数を調整するか、Workers 有料プラン（$5/月）に上げる。
