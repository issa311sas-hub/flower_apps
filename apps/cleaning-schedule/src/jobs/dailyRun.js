/**
 * 日次処理（旧 GAS 版の runAllAuto に相当）
 *
 *   Beds24から取得 → 予約を保存 → 割り当て → 次ゲスト数 → 保存 → 実行ログ
 *
 * 旧版はエラーを握りつぶして Logger に書くだけだったため、
 * 停止しても誰も気づけなかった（実際に外注コスト増につながった）。
 * ここでは必ず実行ログに残し、異常は通知テーブルに積む。
 */

import { jstToday, nowIso, addDays } from '../core/dates.js';
import { assign } from '../core/assign.js';
import { computeNextGuests } from '../core/nextGuests.js';
import { fetchBookings } from '../integrations/beds24.js';
import { listStaff, toAssignStaff } from '../db/staff.js';
import { applyFetchedBookings, listActiveBookings } from '../db/bookings.js';
import { getCapacityMap } from '../db/availability.js';
import { loadExisting, saveAssignments } from '../db/assignments.js';
import { getSettings, setSetting } from '../db/settings.js';
import { startRun, finishRun } from '../db/runs.js';
import { recordNotification, acknowledgeKind } from '../db/notifications.js';

/**
 * @param {object} env Worker の環境（DB, TOKEN_ENC_KEY）
 * @param {{kind?: 'cron'|'manual', triggeredBy?: string, now?: number, fetchImpl?: Function, sleep?: Function}} options
 */
export async function runDaily(env, options = {}) {
  const db = env.DB;
  const kind = options.kind ?? 'cron';
  const nowMs = options.now ?? Date.now();
  const at = nowIso(nowMs);
  const today = jstToday(nowMs);

  const runId = await startRun(db, kind, { triggeredBy: options.triggeredBy ?? null, at });

  try {
    const settings = await getSettings(db);
    const fetchDays = settings.fetch_days ?? 90;

    // 1. Beds24 から取得
    const fetched = await fetchBookings(
      db,
      env.TOKEN_ENC_KEY,
      { today, fetchDays },
      { fetch: options.fetchImpl, sleep: options.sleep, now: () => nowMs }
    );

    if (fetched.bookings.length === 0) {
      await finishRun(db, runId, {
        ok: false,
        stats: { fetched: 0 },
        error: '取得できた予約が0件でした。',
        at
      });
      await recordNotification(
        db,
        {
          kind: 'zero_bookings',
          level: 'warn',
          subject: '予約データが0件でした',
          body:
            'Beds24 から取得した予約が0件だったため、割り当てを行いませんでした。\n' +
            '本当に予約が0件であれば問題ありませんが、通常はユニットマッピングの設定漏れが原因です。\n' +
            (fetched.unmappedRooms.length > 0
              ? `未設定の roomId:unitId → ${fetched.unmappedRooms.join(', ')}\n`
              : '')
        },
        { at }
      );
      return { ok: false, runId, reason: 'zero_bookings', fetched };
    }

    // 2. 予約を保存（取得結果から消えたものはキャンセル扱い）
    const saved = await applyFetchedBookings(db, fetched.bookings, fetched.range, at);

    // 3. 割り当て
    const bookings = await listActiveBookings(db);
    const staff = await listStaff(db);
    const existing = await loadExisting(db);

    // 割り当ては延期先（+1/+2日）の枠も見るため、前後に余裕を持たせて取得する
    const capacity = await getCapacityMap(db, {
      from: addDays(today, -3),
      to: addDays(today, fetchDays + 3)
    });

    const result = assign({
      today,
      bookings,
      existing,
      staff: toAssignStaff(staff),
      capacity,
      params: {
        maxDeferDays: settings.max_defer_days ?? 2,
        outsourceWindowDays: settings.outsource_window_days ?? 14
      }
    });

    // 4. 次ゲスト数を求めて保存
    const nextGuests = computeNextGuests(bookings, result.assignments);
    const savedAssignments = await saveAssignments(db, result.assignments, { nextGuests, runId, at });

    // 5. 実行ログ
    const message =
      `取得 ${fetched.bookings.length}件 / 割り当て ${result.stats.total}件` +
      `（確定 ${result.stats.confirmed} / 延期 ${result.stats.deferred} / ` +
      `外注 ${result.stats.outsourced} / 未割当 ${result.stats.unassigned}）`;

    await finishRun(db, runId, {
      ok: true,
      stats: { fetched: fetched.bookings.length, ...result.stats },
      message,
      at
    });

    // 取得も割り当ても通った時点で、失敗・滞留を伝えていた警告は用済み。
    // 消さないと、直ったあとも管理画面に古い警告が残り続ける。
    //
    // ⚠ ここは**日次処理が成功したとき**だけ。見張り役（keepAlive）は常に
    //   ok で終わるので、finishRun 側に置くと、記録した直後の警告を
    //   自分で消してしまう。
    //
    // ⚠ 'unassigned' は消さない。あれは「いまの状態」を伝えるもので、
    //   実行が成功しても未割当は残りうる。消すとスロットル（12時間）のせいで
    //   次の実行でも積み直されず、未割当があるのに何も出なくなる。
    for (const kind of ['run_error', 'zero_bookings', 'stale_run']) {
      await acknowledgeKind(db, kind, at);
    }

    // 表示用。滞留の判定そのものは runs の実績から求めるので、これには依存しない
    await setSetting(db, 'last_success_run_at', at, at);

    // 6. 気づいてほしいことを通知に積む
    //
    // 正常時も1日1回だけ知らせる。「今日も動いた」が届かないこと自体が、
    // 止まっていることの合図になる（旧版はこれが無くて止まっても気づけなかった）。
    if (String(settings.notify_daily_summary ?? '1') === '1') {
      await recordNotification(
        db,
        {
          kind: 'daily_summary',
          level: 'info',
          subject: `清掃の割り当てを更新しました（${today}）`,
          body: message
        },
        { at, throttleHours: 6 }
      );
    }

    if (result.stats.unassigned > 0) {
      await recordNotification(
        db,
        {
          kind: 'unassigned',
          level: 'warn',
          subject: `未割当が ${result.stats.unassigned}件あります`,
          body:
            `担当が決まっていない清掃が ${result.stats.unassigned}件あります。\n` +
            '管理画面の割り当て一覧で「要確認」の行をご確認ください。\n\n' +
            message
        },
        { at }
      );
    }
    for (const warning of result.warnings) {
      await recordNotification(
        db,
        { kind: 'assign_warning', level: 'warn', subject: '割り当ての設定を確認してください', body: warning },
        { at }
      );
    }

    return {
      ok: true,
      runId,
      today,
      fetched,
      saved,
      savedAssignments,
      stats: result.stats,
      message
    };
  } catch (error) {
    const detail = error?.message ?? String(error);

    await finishRun(db, runId, { ok: false, error: detail, at });
    await recordNotification(
      db,
      {
        kind: error?.permanent ? 'auth_expired' : 'run_error',
        level: 'error',
        subject: error?.permanent ? 'Beds24 の再接続が必要です' : '自動実行がエラーで停止しました',
        body:
          `${detail}\n\n` +
          (error?.permanent
            ? '■ 復旧手順\n' +
              '1. Beds24 管理画面 → SETTINGS → MARKETPLACE → API で招待コードを発行\n' +
              '   （スコープに bookings と properties を含める。有効期限は24時間）\n' +
              '2. このシステムの管理画面から招待コードを入力\n'
            : '管理画面の実行ログで詳細を確認してください。') +
          '\n※ 復旧するまで清掃予定は更新されません。'
      },
      { at }
    );

    return { ok: false, runId, error: detail, permanent: !!error?.permanent };
  }
}
