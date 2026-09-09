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
  };
}
