/**
 * 小さなルータ
 *
 * 画面数が少ないのでフレームワークは使わない。
 * `/me/complete/:bookingId` のような単純なパラメータだけ扱えれば足りる。
 */

/** '/a/:b/c' を正規表現とパラメータ名に分解する */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((part) => {
      if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(part.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

/** 登録順に、メソッドとパスが一致する最初のルートを返す */
function find(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const matched = route.regex.exec(pathname);
    if (!matched) continue;

    const params = {};
    route.names.forEach((name, i) => {
      params[name] = decodeURIComponent(matched[i + 1]);
    });
    return { handler: route.handler, params };
  }
  return null;
}

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    routes.push({ method, ...compile(pattern), handler });
  };

  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),

    /**
     * @returns {{handler: Function, params: object}|null}
     */
    match(method, pathname) {
      const hit = find(routes, method, pathname);
      if (hit) return hit;

      // HEAD は GET と同じ状態・ヘッダを返し、本文だけ返さない決まり。
      //
      // UptimeRobot などの死活監視は **まず HEAD で叩き、失敗したら GET でやり直す**。
      // ここが無いと HEAD が毎回404になり、1回の巡回が2往復になるうえ、
      // 監視を「HEADのみ」に設定した場合は健全なのに常時停止と誤検知する。
      // 死活監視の窓口が、監視のやり方しだいで嘘をつく状態になっていた。
      if (method === 'HEAD') return find(routes, 'GET', pathname);

      return null;
    }
  };
}
