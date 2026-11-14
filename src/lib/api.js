// reader-gas の /exec JSON API への POST ラッパー。
// GAS の Web App はカスタムヘッダー付きのリクエストで CORS プリフライトが
// 通らないため、tweet の post.js と同じく Content-Type: text/plain で
// JSON 文字列を送る (サーバー側は postData.contents を JSON.parse する)。
import { API_URL } from '../config.js';

// fetch のネットワーク失敗 (Safari の "Load failed" など) は TypeError で来る。
// 端末がスリープから復帰した直後の最初のリクエストがこれで落ちやすい。
function isRetryable(err) {
  if (err instanceof TypeError) return true;
  return /^HTTP 5\d\d$/.test(String((err && err.message) || ''));
}

export async function postJson(body, { fetcher = fetch, apiUrl = API_URL, retries = 1, retryDelayMs = 900 } = {}) {
  if (!apiUrl) throw new Error('api_not_configured');
  for (let attempt = 0; ; attempt++) {
    try {
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
    } catch (err) {
      // 全 action は冪等 (既読化・保存・削除・並び替え) なので、
      // ネットワーク失敗と 5xx のときだけ1回だけ送り直す。
      if (!isRetryable(err) || attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
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
export function listArticles(sessionToken, { feedId = '', category = '', filter = 'all', limit = 50, offset = 0 } = {}, opts) {
  const body = { action: 'list', sessionToken, filter, limit, offset };
  if (feedId) body.feedId = feedId;
  if (category) body.category = category;
  return postJson(body, opts);
}

// 既読・スターの付け外し (オーナーセッションのみ)。
export function markArticle(sessionToken, articleId, patch = {}, opts) {
  const body = { action: 'mark', sessionToken, articleId };
  if (patch.isRead !== undefined) body.isRead = patch.isRead;
  if (patch.isStarred !== undefined) body.isStarred = patch.isStarred;
  return postJson(body, opts);
}

// まとめて既読化 (オーナーセッションのみ)。feedId / category 省略で全フィード。
export function markAllRead(sessionToken, { feedId = '', category = '' } = {}, opts) {
  const body = { action: 'markAllRead', sessionToken };
  if (feedId) body.feedId = feedId;
  if (category) body.category = category;
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
