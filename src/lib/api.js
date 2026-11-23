// reader-gas の /exec JSON API への POST ラッパー。
// GAS の Web App はカスタムヘッダー付きのリクエストで CORS プリフライトが
// 通らないため、tweet の post.js と同じく Content-Type: text/plain で
// JSON 文字列を送る (サーバー側は postData.contents を JSON.parse する)。
import { API_URL } from '../config.js';
import { withRetry } from './retry.js';

// fetch のネットワーク失敗 (Safari の "Load failed" など) は TypeError で来る。
// 端末がスリープから復帰した直後の最初のリクエストがこれで落ちやすい。
function isRetryable(err) {
  if (err instanceof TypeError) return true;
  return /^HTTP 5\d\d$/.test(String((err && err.message) || ''));
}

export async function postJson(body, { fetcher = fetch, apiUrl = API_URL, retries = 1, retryDelayMs = 900, timeoutMs = 30000 } = {}) {
  if (!apiUrl) throw new Error('api_not_configured');
  // 全 action は冪等 (既読化・保存・削除・並び替え) なので、
  // ネットワーク失敗と 5xx のときだけ1回だけ送り直す。
  return withRetry(async () => {
    // 応答が返らないまま固まるリクエストを打ち切る。タイムアウトは
    // AbortError になり、再試行対象 (TypeError / 5xx) には含めない
    // (固まっている相手へすぐ送り直しても同じ結果になるため)。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetcher(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || data.ok !== true) {
      const err = new Error((data && data.error) || 'api_error');
      // 検証エラー (invalid) など、サーバーが人間向けの理由を返す場合は
      // message を別途持たせておき、画面側でそのまま出せるようにする。
      if (data && typeof data.message === 'string') err.serverMessage = data.message;
      throw err;
    }
    return data;
  }, { retries, retryDelayMs, isRetryable });
}

// Google IDトークンをオーナーセッションに交換する。
// -> { ok, sessionToken, expiresAt, role: 'owner' }
export function exchangeSession(idToken, opts) {
  return postJson({ action: 'exchange_session', idToken }, opts);
}

// 一時アクセスリンクのトークンを読み取り専用セッションに交換する。
// -> { ok, sessionToken, expiresAt, role: 'readonly', readonly: true }
export function exchangeShare(shareToken, opts) {
  return postJson({ action: 'exchange_share', shareToken }, opts);
}

// 記事一覧 (状態マージ済み・新しい順) ＋フィード一覧。
// v2 ではフィード一覧 (fetchUrl 付き) の取得と、既読状態の初回取り込みに使う。
// -> { ok, articles, total, feeds, generatedAt }
export function listArticles(sessionToken, { feedId = '', category = '', filter = 'all', limit = 50, offset = 0 } = {}, opts) {
  const body = { action: 'list', sessionToken, filter, limit, offset };
  if (feedId) body.feedId = feedId;
  if (category) body.category = category;
  return postJson(body, opts);
}

// フィード管理の一覧 (オーナーセッションのみ)。
// -> { ok, feeds: [{id, title, url, category, sortDirection,
//     lastStatus, lastError, lastFetchedAt, unreadCount}] }
export function listFeeds(sessionToken, opts) {
  return postJson({ action: 'listFeeds', sessionToken }, opts);
}

// フィードの追加・更新 (オーナーセッションのみ)。
// -> { ok, feed } / 検証エラーは error: 'invalid' + serverMessage。
export function saveFeed(sessionToken, feed, opts) {
  return postJson({ action: 'saveFeed', sessionToken, feed }, opts);
}

// フィードの削除 (オーナーセッションのみ)。記事もあわせて消える。
export function deleteFeed(sessionToken, feedId, opts) {
  return postJson({ action: 'deleteFeed', sessionToken, feedId }, opts);
}

// 記事へのスターの付け外し (オーナーセッションのみ。readonly は
// サーバー側で forbidden)。スターはサーバーが正本で、実効スター
// (starred) はサーバーの list 応答で同期される。on のときは手動で
// 付けた印 (star_state: 'on')、off のときは手動で外した印 ('off')
// としてサーバーに残る。
// -> { ok }
export function setStar(sessionToken, articleId, on, opts) {
  return postJson({ action: 'set_star', sessionToken, id: articleId, on: !!on }, opts);
}

export function reorderFeeds(sessionToken, feedIds, opts) {
  return postJson({ action: 'reorderFeeds', sessionToken, feedIds }, opts);
}

// 視聴ログの送信 (オーナーセッションのみ。readonly はサーバー側で
// forbidden)。イベントは {ts, type, feed_id, feed_title, article_id,
// article_title, seconds} の配列で、1リクエスト最大50件。視聴ログは
// 落ちても困らない情報なので、postJson の再試行は切って1回だけ送る
// (再送で二重に貯めない)。
// -> { ok, saved }
export function logEvents(sessionToken, events, opts) {
  return postJson({ action: 'log_events', sessionToken, events }, { retries: 0, ...opts });
}

// 視聴の週次集計 (オーナーセッションのみ)。weekly は確定済みの週の
// 集計、current は今週分 (未集計) をその場で集計したもので、どちらも
// {week, feed_id, feed_title, views, opens, plays, seconds} の配列。
// -> { ok, weekly, currentWeek, current }
export function getStats(sessionToken, opts) {
  return postJson({ action: 'stats', sessionToken }, opts);
}

// 共有リンク (マジックリンク) の発行 (オーナーセッションのみ)。
// リンクは30日有効で、発行するとそれまでのリンクは無効になる。
// -> { ok, token, expiresAt } (token は平文。この応答でしか得られない)
export function issueShareLink(sessionToken, opts) {
  return postJson({ action: 'issueShareLink', sessionToken }, opts);
}

// 共有リンクの状態 (オーナーセッションのみ)。サーバーはトークンの
// ハッシュしか持たないため、ここで分かるのは有効かどうかと期限だけ。
// -> { ok, active, expiresAt }
export function getShareLinkStatus(sessionToken, opts) {
  return postJson({ action: 'getShareLinkStatus', sessionToken }, opts);
}

// 共有リンクの無効化 (オーナーセッションのみ)。
// -> { ok }
export function revokeShareLink(sessionToken, opts) {
  return postJson({ action: 'revokeShareLink', sessionToken }, opts);
}
