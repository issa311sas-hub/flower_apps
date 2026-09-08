/**
 * Cloudflare Worker のエントリポイント
 *
 * ※ 現在は足場のみ。画面・API・日次処理はこれから実装する（README のロードマップ参照）。
 *   割り当てエンジン（src/core/）は移植済みで、旧 GAS 版との一致テストが通っている。
 */

export default {
  /** 画面と API */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({
        ok: true,
        stage: 'scaffold',
        note: '割り当てエンジンのみ実装済み。画面と日次処理は未実装。'
      });
    }

    return new Response(
      '清掃予定管理システム（準備中）\n\n' +
        '割り当てエンジンの移植が完了し、旧システムとの一致テストが通っています。\n' +
        '画面と自動実行はこれから実装します。\n',
      { headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  },

  /** 定期実行（cron は UTC 指定。wrangler.jsonc のコメント参照） */
  async scheduled(event, env, ctx) {
    console.log('[cleaning-schedule] scheduled:', event.cron, '（未実装）');
  }
};
