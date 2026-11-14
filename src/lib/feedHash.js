// フィード ID は URL から決める: サーバー (reader-gas) と同じ規則で
// SHA-256(URL 文字列そのまま) の小文字 hex の先頭16文字。
// ID を人が入力する仕組みは廃止し、URL がそのまま同一性になる。
// テストベクトルで固定している (test/feedHash.test.js)。
import { sha256Hex } from './articleId.js';

export const FEED_ID_LENGTH = 16;

export async function feedIdFromUrl(url) {
  const hex = await sha256Hex(String(url));
  return hex.slice(0, FEED_ID_LENGTH);
}

// サーバーから受けたフィード一覧の ID を、URL ハッシュへ付け替えた
// 新しい配列を返す (順序と他のフィールドはそのまま)。サーバー側の
// シート移行が済むまでは旧 ID が返ることがあるため、ローカルでは
// 常にこちらを同一性として扱う。fetchUrl はサーバーが付けたものを
// そのまま使う (向こうの ID が埋まっていても取得には使える)。
export async function normalizeFeedIds(feeds) {
  const out = [];
  for (const feed of feeds || []) {
    out.push({ ...feed, id: await feedIdFromUrl(feed?.url) });
  }
  return out;
}
