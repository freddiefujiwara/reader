// フィード XML の取得。ブラウザから直接取れない (CORS) ため、
// url-fetch-gas をプロキシとして使う:
//   GET <exec>?u=<encodeURIComponent(fetchUrl)>&token=<値>
//   -> { url, content, error } (content がフィード XML の生テキスト)
// 失敗したフィードはその回だけ諦め、ローカルの記事を残す (呼び出し側の判断)。
import { parseFeedXml } from './feedParse.js';
import { withRetry } from './retry.js';

// url-fetch-gas の /exec URL (portfolio-treemap と同じデプロイ)。
export const URL_FETCH_API_URL =
  'https://script.google.com/macros/s/AKfycbx6iFGnB5EaSVedN5mk8F1L0iO9orwZZiOz_2m6wIRzHA1XsU555ib0Ex2LMCR1nLOvhw/exec';

// url-fetch-gas のトークン認証 (本番で有効化済み。トークンなしは
// {"error":"Error: Unauthorized."} になる)。値はビルド時に CI が
// GitHub Secret URL_FETCH_TOKEN を環境変数 VITE_URL_FETCH_TOKEN
// として渡し、Vite が import.meta.env 経由で埋め込む
// (portfolio-treemap と同じ方式)。未設定の環境 (テスト・ローカル)
// では token パラメータ自体を付けない。対象は url-fetch-gas 経由の
// 取得だけで、reader-gas へのリクエストには付けない。
export const URL_FETCH_TOKEN = (import.meta.env && import.meta.env.VITE_URL_FETCH_TOKEN) || '';

export function proxyUrl(fetchUrl, base = URL_FETCH_API_URL, token = URL_FETCH_TOKEN) {
  const url = `${base}?u=${encodeURIComponent(fetchUrl)}`;
  return token ? `${url}&token=${encodeURIComponent(token)}` : url;
}

// api.js と同じ方針: ネットワーク失敗 (TypeError) のときだけ1回送り直す。
function isRetryable(err) {
  return err instanceof TypeError;
}

export async function fetchFeedXml(fetchUrl, { fetcher = fetch, proxyBase = URL_FETCH_API_URL, token = URL_FETCH_TOKEN, retries = 1, retryDelayMs = 900, timeoutMs = 30000 } = {}) {
  return withRetry(async () => {
    // 応答が返らないまま固まるリクエストを打ち切る (タイムアウトは
    // AbortError になり、再試行対象の TypeError には含めない)。
    // 1件の固まりで全フィードの更新が止まるのを防ぐ。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetcher(proxyUrl(fetchUrl, proxyBase, token), { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || data.error) throw new Error((data && data.error) || 'fetch_failed');
    if (typeof data.content !== 'string' || !data.content) throw new Error('empty_content');
    return data.content;
  }, { retries, retryDelayMs, isRetryable });
}

// フィード1件を取得してエントリまで変換する。失敗しても投げず、
// { ok: false } で返して呼び出し側がそのフィードをスキップできるようにする。
export async function fetchOneFeed(feed, opts) {
  const fetchUrl = feed.fetchUrl || feed.url;
  try {
    const xml = await fetchFeedXml(fetchUrl, opts);
    return { feed, ok: true, entries: parseFeedXml(xml, feed), error: null };
  } catch (error) {
    return { feed, ok: false, entries: [], error };
  }
}

// 全フィードを同時実行数の上限つきで取得する。結果は入力順で返す。
export async function fetchAllFeeds(feeds, { concurrency = 6, ...opts } = {}) {
  const list = Array.isArray(feeds) ? feeds : [];
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const idx = next++;
      results[idx] = await fetchOneFeed(list[idx], opts);
    }
  }
  const workers = [];
  const width = Math.max(1, Math.min(concurrency, list.length));
  for (let i = 0; i < width; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
