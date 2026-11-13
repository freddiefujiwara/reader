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
    throw new Error((data && data.error) || 'api_error');
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
