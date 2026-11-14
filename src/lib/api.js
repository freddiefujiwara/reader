// reader-gas の /exec JSON API への POST ラッパー。
// GAS の Web App はカスタムヘッダー付きのリクエストで CORS プリフライトが
// 通らないため、tweet の post.js と同じく Content-Type: text/plain で
// JSON 文字列を送る (サーバー側は postData.contents を JSON.parse する)。
import { API_URL } from '../config.js';

export async function postJson(body, { fetcher = fetch, apiUrl = API_URL } = {}) {
  if (!apiUrl) throw new Error('api_not_configured');
  const res = await fetcher(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
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

// 記事一覧 (状態マージ済み・新しい順) ＋フィード一覧 (未読数付き)。
// -> { ok, articles, total, feeds, generatedAt }
export function listArticles(sessionToken, { feedId = '', filter = 'all', limit = 50, offset = 0 } = {}, opts) {
  const body = { action: 'list', sessionToken, filter, limit, offset };
  if (feedId) body.feedId = feedId;
  return postJson(body, opts);
}

// 既読・スターの付け外し (オーナーセッションのみ)。
export function markArticle(sessionToken, articleId, patch = {}, opts) {
  const body = { action: 'mark', sessionToken, articleId };
  if (patch.isRead !== undefined) body.isRead = patch.isRead;
  if (patch.isStarred !== undefined) body.isStarred = patch.isStarred;
  return postJson(body, opts);
}

// まとめて既読化 (オーナーセッションのみ)。feedId 省略で全フィード。
export function markAllRead(sessionToken, feedId = '', opts) {
  const body = { action: 'markAllRead', sessionToken };
  if (feedId) body.feedId = feedId;
  return postJson(body, opts);
}

// フィード管理の一覧 (オーナーセッションのみ)。
// -> { ok, feeds: [{id, title, url, category, enabled, isPrivate,
//     lastStatus, lastError, lastFetchedAt, unreadCount}] }
export function listFeeds(sessionToken, opts) {
  return postJson({ action: 'listFeeds', sessionToken }, opts);
}

// フィードの追加・更新 (オーナーセッションのみ)。
// isPrivate はサーバー側が URL のホスト (a.ze.gs) から決めるため、
// 送った値は参考値で、確定値は応答の feed で確認する。
// -> { ok, feed } / 検証エラーは error: 'invalid' + serverMessage。
export function saveFeed(sessionToken, feed, opts) {
  return postJson({ action: 'saveFeed', sessionToken, feed }, opts);
}

// フィードの削除 (オーナーセッションのみ)。記事もあわせて消える。
export function deleteFeed(sessionToken, feedId, opts) {
  return postJson({ action: 'deleteFeed', sessionToken, feedId }, opts);
}

export function reorderFeeds(sessionToken, feedIds, opts) {
  return postJson({ action: 'reorderFeeds', sessionToken, feedIds }, opts);
}
