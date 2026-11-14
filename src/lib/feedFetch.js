// フィード XML の取得。ブラウザから直接取れない (CORS) ため、
// url-fetch-gas をプロキシとして使う:
//   GET <exec>?u=<encodeURIComponent(fetchUrl)>
//   -> { url, content, error } (content がフィード XML の生テキスト)
// 失敗したフィードはその回だけ諦め、ローカルの記事を残す (呼び出し側の判断)。
import { parseFeedXml } from './feedParse.js';

// url-fetch-gas の /exec URL (portfolio-treemap と同じデプロイ)。
export const URL_FETCH_API_URL =
  'https://script.google.com/macros/s/AKfycbx6iFGnB5EaSVedN5mk8F1L0iO9orwZZiOz_2m6wIRzHA1XsU555ib0Ex2LMCR1nLOvhw/exec';

export function proxyUrl(fetchUrl, base = URL_FETCH_API_URL) {
  return `${base}?u=${encodeURIComponent(fetchUrl)}`;
}

// api.js と同じ方針: ネットワーク失敗 (TypeError) のときだけ1回送り直す。
function isRetryable(err) {
  return err instanceof TypeError;
}

export async function fetchFeedXml(fetchUrl, { fetcher = fetch, proxyBase = URL_FETCH_API_URL, retries = 1, retryDelayMs = 900 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetcher(proxyUrl(fetchUrl, proxyBase));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || data.error) throw new Error((data && data.error) || 'fetch_failed');
      if (typeof data.content !== 'string' || !data.content) throw new Error('empty_content');
      return data.content;
    } catch (err) {
      if (!isRetryable(err) || attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
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
