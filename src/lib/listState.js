// 記事リストの純粋な状態操作 (フィルタ・既読・未読数)。
// Vue に依存しない関数だけにし、単体テストで振る舞いを固定する。
// v2 では記事も未読数もローカルが正本なので、未読数は読み込んだ記事から数える。

export function createListState() {
  return { articles: [], feeds: [], feedId: '', category: '', filter: 'all' };
}

// フィード一覧からカテゴリ名を出現順に取り出す (カテゴリ行の表示用)。
// 空カテゴリは含めない。
export function feedCategories(feeds) {
  const seen = [];
  (feeds || []).forEach((f) => {
    const c = String(f.category || '').trim();
    if (c && !seen.includes(c)) seen.push(c);
  });
  return seen;
}

// 表示条件 (フィード＋カテゴリ＋ビュー) に合う記事だけを返す。
// 楽観的更新で状態が変わった記事をその場で出し分けるためにクライアントで行う。
export function visibleArticles(state) {
  let out = state.articles.slice();
  if (state.category) {
    const inCategory = {};
    (state.feeds || []).forEach((f) => {
      if (String(f.category || '').trim() === state.category) inCategory[f.id] = true;
    });
    out = out.filter((a) => inCategory[a.feedId]);
  }
  if (state.feedId) out = out.filter((a) => a.feedId === state.feedId);
  if (state.filter === 'unread') out = out.filter((a) => !a.isRead);
  return out;
}

// 1件の既読を差し替えた新しい articles を返す (元の配列は壊さない)。
export function patchArticle(articles, articleId, patch) {
  return articles.map((a) => {
    if (a.id !== articleId) return a;
    const next = { ...a };
    if (patch.isRead !== undefined) next.isRead = patch.isRead;
    return next;
  });
}

// ローカルの記事から数えた未読数をフィードへ付け直す。
// サーバー応答の unreadCount は使わず、端末に居る記事だけが数えられる。
export function withUnreadCounts(feeds, articles) {
  const counts = {};
  (articles || []).forEach((a) => {
    if (!a.isRead) counts[a.feedId] = (counts[a.feedId] || 0) + 1;
  });
  return (feeds || []).map((f) => ({ ...f, unreadCount: counts[f.id] || 0 }));
}

// 新しい順 (publishedAt、無ければ fetchedAt) に並べ替えた配列を返す。
export function sortArticlesDesc(articles) {
  return (articles || []).slice().sort((a, b) => {
    const ta = Date.parse(a.publishedAt || a.fetchedAt || '') || 0;
    const tb = Date.parse(b.publishedAt || b.fetchedAt || '') || 0;
    if (tb !== ta) return tb - ta;
    const fa = Date.parse(a.fetchedAt || '') || 0;
    const fb = Date.parse(b.fetchedAt || '') || 0;
    if (fb !== fa) return fb - fa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// すべて既読の対象範囲 (フィード指定が優先、次にカテゴリ、無ければ全体) に
// 入るフィードIDの集合。
export function markAllReadScope(state, feedId = '', category = '') {
  const inScope = (f) => {
    if (feedId) return f.id === feedId;
    if (category) return String(f.category || '').trim() === category;
    return true;
  };
  const scopedFeedIds = {};
  (state.feeds || []).forEach((f) => { if (inScope(f)) scopedFeedIds[f.id] = true; });
  return scopedFeedIds;
}

export function markAllReadInList(state, feedId = '', category = '') {
  const scopedFeedIds = markAllReadScope(state, feedId, category);
  const all = !feedId && !category;
  const articles = state.articles.map((a) =>
    all || scopedFeedIds[a.feedId] ? { ...a, isRead: true } : a
  );
  const feeds = state.feeds.map((f) => {
    if (!all && !scopedFeedIds[f.id]) return f;
    return { ...f, unreadCount: 0 };
  });
  return { ...state, articles, feeds };
}

// フィードチップの表示対象。未読フィルタのときは未読があるフィードだけに
// 絞る (未読ゼロなら「すべて」だけが残る)。ただし選択中のフィードは、
// 未読がゼロでも行き場が無くならないよう残す。
export function visibleFeedChips(state) {
  let feeds = Array.isArray(state?.feeds) ? state.feeds : [];
  if (state?.category) {
    feeds = feeds.filter((f) => String(f.category || '').trim() === state.category);
  }
  if (state?.filter === 'unread') {
    return feeds.filter((f) => (f.unreadCount || 0) > 0 || f.id === state.feedId);
  }
  return feeds;
}
