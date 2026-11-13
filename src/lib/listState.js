// 記事リストの純粋な状態操作 (フィルタ・楽観的更新・未読数)。
// Vue に依存しない関数だけにし、単体テストで振る舞いを固定する。

export function createListState() {
  return { articles: [], feeds: [], total: 0, feedId: '', filter: 'all', generatedAt: null };
}

// list API の応答を state へ取り込む。append=true は「もっと見る」の追記で、
// 既存 id と重複する記事は追加しない。
export function applyListResponse(state, payload, { append = false } = {}) {
  const incoming = Array.isArray(payload?.articles) ? payload.articles : [];
  const articles = append
    ? [...state.articles, ...incoming.filter((a) => !state.articles.some((x) => x.id === a.id))]
    : incoming;
  return {
    ...state,
    articles,
    feeds: Array.isArray(payload?.feeds) ? payload.feeds : state.feeds,
    total: typeof payload?.total === 'number' ? payload.total : articles.length,
    generatedAt: payload?.generatedAt || state.generatedAt,
  };
}

// 表示条件 (フィード＋ビュー) に合う記事だけを返す。サーバー側でも絞るが、
// 楽観的更新で状態が変わった記事をその場で出し分けるためにクライアントでも行う。
export function visibleArticles(state) {
  let out = state.articles.slice();
  if (state.feedId) out = out.filter((a) => a.feedId === state.feedId);
  if (state.filter === 'unread') out = out.filter((a) => !a.isRead);
  if (state.filter === 'starred') out = out.filter((a) => a.isStarred);
  return out;
}

// 1件の既読・スターを差し替えた新しい articles を返す (元の配列は壊さない)。
export function patchArticle(articles, articleId, patch) {
  return articles.map((a) => {
    if (a.id !== articleId) return a;
    const next = { ...a };
    if (patch.isRead !== undefined) next.isRead = patch.isRead;
    if (patch.isStarred !== undefined) next.isStarred = patch.isStarred;
    return next;
  });
}

// フィード別未読数と全体の未読数。サーバー応答の feeds が正本だが、
// 楽観的更新時は読み込んだ記事分だけでも即時に反映できるよう、
// 読み込み済み記事から数え直す補助も用意する。
export function unreadTotal(articles) {
  return articles.reduce((n, a) => n + (a.isRead ? 0 : 1), 0);
}

export function markAllReadInList(state, feedId = '') {
  const articles = state.articles.map((a) =>
    !feedId || a.feedId === feedId ? { ...a, isRead: true } : a
  );
  const feeds = state.feeds.map((f) => {
    if (feedId && f.id !== feedId) return f;
    // フィルタ対象外フィードは、読み込んでいない記事の未読が残り得るため
    // 全既読ボタンの対象フィードだけを 0 にする (対象外は応答の再取得で直る)。
    return { ...f, unreadCount: 0 };
  });
  return { ...state, articles, feeds };
}
