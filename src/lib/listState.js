// 記事リストの純粋な状態操作 (フィルタ・既読・未読数)。
// Vue に依存しない関数だけにし、単体テストで振る舞いを固定する。
// v2 では記事も未読数もローカルが正本なので、未読数は読み込んだ記事から数える。

export function createListState() {
  return { articles: [], feeds: [], feedId: '', category: '', filter: 'all' };
}

// フィードの表示名。タイトル未取得 (YouTube の補完待ちなど) の間は
// URL のホスト名で代替し、それも無ければ ID を出す。
export function feedDisplayName(feed) {
  const title = String(feed?.title || '').trim();
  if (title) return title;
  try {
    const host = new URL(String(feed?.url || '')).hostname;
    if (host) return host;
  } catch {
    // URL として解釈できなければ ID で代替する。
  }
  return String(feed?.id || '');
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

// 選択中のカテゴリを持つフィードが一覧に1つも無いとき、カテゴリ
// 選択を解除すべきかを判定する。最後の1件を別ジャンルへ編集・削除
// するとカテゴリ自体が消え、チップも無くなって手では解除できなく
// なるため、呼び出し側はこれが true のときに選択を '' へ戻す。
// 一覧が空の間 (読み込み中・未取得、またはフィード自体が0件) は
// 解除しない。読み込みが終わる前に絞り込みを消してしまわないため
// で、true になるのは「一覧に1件以上あり、かつ選択中カテゴリを
// 持つフィードが無い」ときだけ。
export function shouldClearCategorySelection(feeds, category) {
  const c = String(category || '').trim();
  if (!c) return false;
  const list = Array.isArray(feeds) ? feeds : [];
  if (list.length === 0) return false;
  return !list.some((f) => String(f?.category || '').trim() === c);
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

// フィード1件のカテゴリだけを差し替えた新しい配列を返す (元の配列は
// 壊さない)。管理画面でのジャンル保存を、タイムライン側の共有状態へ
// 即座に反映するために使う。
export function patchFeedCategory(feeds, feedId, category) {
  return (feeds || []).map((f) => (f.id === feedId ? { ...f, category } : f));
}

// 1件の記事の一部フィールドを差し替えた新しい articles を返す
// (元の配列は壊さない)。差し替えるのは既読 (isRead) とスター
// (starred / starState) だけ。
export function patchArticle(articles, articleId, patch) {
  return articles.map((a) => {
    if (a.id !== articleId) return a;
    const next = { ...a };
    if (patch.isRead !== undefined) next.isRead = patch.isRead;
    if (patch.starred !== undefined) next.starred = patch.starred;
    if (patch.starState !== undefined) next.starState = patch.starState;
    return next;
  });
}

// 記事が再生ボタン表示 (＝キュー入り) の対象かどうか。
// 音声URLがあることが前提で、YouTube フィードの記事はスターが
// 付いているものだけに絞る。それ以外のフィード (ポッドキャスト等)
// は従来どおり音声URLの有無だけで決まる。youtubeFeedIds は
// YouTube フィードの ID 集合 (Set)。
export function isPlayableArticle(article, youtubeFeedIds) {
  if (!article || !article.audioUrl) return false;
  if (youtubeFeedIds && youtubeFeedIds.has(article.feedId)) return !!article.starred;
  return true;
}

// 読み直した記事一覧 (views) へ、まだ DB のスナップショットに
// 反映されていると確認できていない既読変更 (marks: Map<記事ID, isRead>)
// を重ねる。背景更新の読み直しは「読み取り開始時点」の中身で状態を
// 作り直すため、読み取りの最中に付けた既読は、DB へ書けていても
// そのままでは未読へ巻き戻る。ここで重ね直し、スナップショット側と
// 一致した変更 (書き込みが読み取りより先に済んでいたもの) と、
// 一覧から消えた記事への変更は marks から落とす (keep には残らない)。
// 一致しなかった変更だけが keep に残り、次の読み直しでも重ね直される。
// views は全記事の一覧であること (部分一覧では使わない)。
export function mergePendingReadMarks(views, marks) {
  const pending = marks instanceof Map ? marks : new Map();
  if (!pending.size) return { articles: views || [], keep: new Map() };
  const keep = new Map();
  const articles = (views || []).map((a) => {
    if (!pending.has(a.id)) return a;
    const want = pending.get(a.id);
    if (a.isRead === want) return a;
    keep.set(a.id, want);
    return { ...a, isRead: want };
  });
  return { articles, keep };
}

// 読み直した記事一覧 (views) へ、まだ DB のスナップショットに
// 反映されていると確認できていないスター変更 (marks:
// Map<記事ID, {starred, starState}>) を重ねる。mergePendingReadMarks
// のスター版で、考え方はそちらと同じ。一覧から消えた記事への変更と、
// スナップショット側と一致した変更は marks から落とす。
export function mergePendingStarMarks(views, marks) {
  const pending = marks instanceof Map ? marks : new Map();
  if (!pending.size) return { articles: views || [], keep: new Map() };
  const keep = new Map();
  const articles = (views || []).map((a) => {
    if (!pending.has(a.id)) return a;
    const want = pending.get(a.id);
    if (a.starred === want.starred && (a.starState || '') === (want.starState || '')) return a;
    keep.set(a.id, want);
    return { ...a, starred: want.starred, starState: want.starState || '' };
  });
  return { articles, keep };
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

// すべて既読の対象になる記事 (スコープ内の未読) を返す。範囲の決め方は
// markAllReadInList と一致させる。確認文言の件数表示と、実行時に
// DB へ書く対象 ID を決めるために使う。
export function markAllReadTargets(state, feedId = '', category = '') {
  const scopedFeedIds = markAllReadScope(state, feedId, category);
  const all = !feedId && !category;
  return (state.articles || []).filter(
    (a) => !a.isRead && (all || scopedFeedIds[a.feedId])
  );
}

// フィードチップの表示対象。未読フィルタのときは未読があるフィードだけに
// 絞る (未読ゼロならチップは出ない)。ただし選択中のフィードは、
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
