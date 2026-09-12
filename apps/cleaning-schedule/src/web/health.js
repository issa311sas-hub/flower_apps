/**
 * 死活監視が見る「いまの状態」（/api/health の中身）
 *
 * 外からはステータスコードしか見ない監視サービスが多いので、
 * 異常の判定（`problems`）をここに集めている。1つでも積まれれば 503 になる。
 *
 * 値そのものより、**異常を見落とさないこと**を優先して作ってある。
 * 「まだ一度も動いていない」も異常として扱うのはそのため
 * （cron が登録されていない状態と区別がつかないため。docs/decisions.md 参照）。
 */

import { listUnitNames, listUnitMap } from '../db/units.js';
import { listStaff } from '../db/staff.js';
import { getRunHealth, getCronHealth } from '../db/runs.js';
import { getSchemaState, listPendingMigrations } from '../db/migrate.js';
import { getAuthStatus, STATE } from '../db/beds24Auth.js';
import { countUsers } from '../db/users.js';
import { getSetting, checkPepperFingerprint } from '../db/settings.js';
import { MIGRATIONS } from '../db/migrations.js';

/** D1 につながっているか、初期データが入っているかを確認する */
export async function checkHealth(env) {
  const health = {
    ok: true,
    stage: 'm14',
    d1: { connected: false }
  };

  if (!env.DB) {
    health.ok = false;
    health.d1.error = 'D1 バインディング(DB)が設定されていません。wrangler.jsonc の database_id を確認してください。';
    return health;
  }

  try {
    const units = await listUnitNames(env.DB);
    const staff = await listStaff(env.DB);
    const run = await getRunHealth(env.DB);
    const cron = await getCronHealth(env.DB);
    const schema = await getSchemaState(env.DB);
    const auth = await getAuthStatus(env.DB);
    const fingerprint = await checkPepperFingerprint(env.DB, env.SESSION_PEPPER ?? '');
    const pending = await listPendingMigrations(env.DB, MIGRATIONS);

    health.d1 = {
      connected: true,
      units: units.length,
      unitOrder: units,
      staff: staff.map((s) => s.name),
      tableCount: schema.tableCount,
      tables: schema.tables,
      // SQLite / Cloudflare が自動で作る管理用の表。アプリのデータではない
      internalTables: schema.internalTables,
      users: await countUsers(env.DB),
      unitMap: (await listUnitMap(env.DB)).length,
      // 未適用があると、アプリが古いスキーマのまま動くことになる
      pendingMigrations: pending,
      lastSuccessRunAt: run.lastSuccessAt,
      staleDays: run.staleDays,
      // Cloudflare の cron から最後に呼ばれた時刻。
      // 「呼ばれていない」と「呼ばれたが失敗した」を切り分けるための値
      lastCronEventAt: cron.lastEventAt,
      lastCronExpression: (await getSetting(env.DB, 'last_cron_expression', '')) || null
    };

    health.beds24 = {
      state: auth.state,
      connected: auth.hasToken,
      lastOkAt: auth.lastOkAt,
      daysUntilExpiry: auth.daysUntilExpiry,
      lastError: auth.lastError
    };

    // 秘密の設定は「あるかどうか」だけ返す（値は絶対に返さない）
    health.secrets = {
      SESSION_PEPPER: !!env.SESSION_PEPPER,
      TOKEN_ENC_KEY: !!env.TOKEN_ENC_KEY,
      // 保存済みのパスワードが、いまの SESSION_PEPPER で照合できるか。
      // false なら誰もログインできない（鍵が入れ替わっている）
      pepperMatchesPasswords: fingerprint.known ? fingerprint.matches : null
    };

    // 外から見て「いま異常か」を判定する。
    // 初回セットアップ中（まだ一度も実行していない）は異常扱いにしない。
    const problems = [];

    if (units.length === 0 || staff.length === 0) {
      problems.push('初期データが入っていません。/setup を開いてください。');
      health.d1.error = '初期データが入っていません。/setup を開いてください。';
    }
    if (auth.state === STATE.NEEDS_RECONNECT) {
      problems.push('Beds24 の再接続が必要です。招待コードを発行し直してください。');
    }
    // cron から呼ばれていないことは、日次処理の失敗とは別の問題。
    // 見に行く先も直し方も違うので、別々に伝える
    if (cron.isSilent) {
      problems.push(
        `Cloudflare の自動実行から ${cron.silentDays}日間 呼ばれていません。Cron Triggers の設定を確認してください。`
      );
    }

    if (run.neverRun) {
      // 「まだ一度も」を黙って通すと、cron が登録されていないことに誰も気づけない。
      // 初期データが入っている＝セットアップは済んでいるので、猶予を置く理由がない
      problems.push('自動実行がまだ一度も成功していません。cron の設定を確認してください。');
    } else if (run.isStale) {
      problems.push(`自動実行が ${run.staleDays}日間 成功していません。`);
    }
    if (fingerprint.known && !fingerprint.matches) {
      problems.push('SESSION_PEPPER が変わっているため、誰もログインできません。');
    }
    if (pending.length > 0) {
      problems.push(
        `未適用のデータベース更新が ${pending.length}件あります。管理画面を開いて「いま更新する」を押してください。`
      );
    }

    health.problems = problems;
    health.ok = problems.length === 0;
  } catch (e) {
    health.ok = false;
    health.d1.error = `D1 へのクエリに失敗しました: ${e.message}`;
    health.d1.hint = 'マイグレーションが未実行の可能性があります。/setup を開いてください。';
  }

  return health;
}
