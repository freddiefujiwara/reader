// 記事リストの純粋な状態操作 (フィルタ・既読・未読数)。
// Vue に依存しない関数だけにし、単体テストで振る舞いを固定する。
// v2 では記事も未読数もローカルが正本なので、未読数は読み込んだ記事から数える。

export function createListState() {
  return { articles: [], feeds: [], feedId: '', category: '', filter: 'all' };
}

// 壊れた行のフィールドの読み方。文字列だけを値とし、それ以外
// (数値・真偽値・文字列化できないオブジェクト) は空として読む。
// String() の素通しは、toString が関数でないオブジェクトで投げるため。
function asText(v) {
  return typeof v === 'string' ? v : '';
}

// カテゴリの読み方。文字列 (と数値の文字列表現) だけを意味のある値とし、
// それ以外は空カテゴリとして読む (feedCategories など比較系の共通形)。
function categoryOf(feed) {
  const c = feed?.category;
  return (typeof c === 'string' ? c : typeof c === 'number' ? String(c) : '').trim();
}

// フィードの表示名。タイトル未取得 (YouTube の補完待ちなど) の間は
// URL のホスト名で代替し、それも無ければ ID を出す。
export function feedDisplayName(feed) {
  const title = asText(feed?.title).trim();
  if (title) return title;
  try {
    const host = new URL(asText(feed?.url)).hostname;
    if (host) return host;
  } catch {
    // URL として解釈できなければ ID で代替する。
  }
  return asText(feed?.id);
}

// フィード一覧からカテゴリ名を出現順に取り出す (カテゴリ行の表示用)。
// 空カテゴリは含めない。
export function feedCategories(feeds) {
  const seen = [];
  (Array.isArray(feeds) ? feeds : []).forEach((f) => {
    const c = categoryOf(f);
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
  return !list.some((f) => categoryOf(f) === c);
}

// 表示条件 (フィード＋カテゴリ＋ビュー) に合う記事だけを返す。
// 楽観的更新で状態が変わった記事をその場で出し分けるためにクライアントで行う。
// stickyReadIds は、未読のみ表示の間に既読へ遷移した記事の ID 集合
// (Set でも配列でもよい)。未読フィルタでもその記事だけは既読のまま
// 一覧に残す (絞り込みを再適用するまでのセッション内だけの扱い)。
// フィード・カテゴリの絞り込みは従来どおり先に効く。
export function visibleArticles(state, stickyReadIds) {
  let out = (Array.isArray(state.articles) ? state.articles : []).slice();
  if (state.category) {
    const inCategory = {};
    (state.feeds || []).forEach((f) => {
      if (f && categoryOf(f) === state.category) inCategory[f.id] = true;
    });
    out = out.filter((a) => inCategory[a.feedId]);
  }
  if (state.feedId) out = out.filter((a) => a.feedId === state.feedId);
  if (state.filter === 'unread') {
    const sticky = stickyReadIds instanceof Set ? stickyReadIds : new Set(stickyReadIds || []);
    out = out.filter((a) => !a.isRead || sticky.has(a.id));
  }
  // フィード単体表示で、そのフィードの並び順が古い順 (asc) のときだけ
  // 昇順に並べ替える (予定など日時順に読みたいフィード用)。全件・
  // カテゴリ表示は従来どおり新しい順のまま (state.articles の順)。
  if (state.feedId) {
    const feed = (state.feeds || []).find((f) => f && f.id === state.feedId);
    if (feed && feed.sortDirection === 'asc') out = sortArticlesAsc(out);
  }
  return out;
}

// 再生中の記事へ移動するための計画。その記事が属するフィードの
// 単体表示 (全件表示) を開くときのカテゴリとフィード ID、その表示で
// 記事が表示上限 (displayLimit) の内側に入るために必要な上限値を返す。
// 位置は visibleArticles と同じ条件 (フィードの並び順を含む) で数える
// ため、呼び出し側はこの計画どおりに選択と上限を差し替えるだけで
// 対象の記事が画面に出る。記事が壊れている・フィードが一覧に無い・
// 記事が表示対象に入らない場合は null (移動しない)。
export function planArticleJump(state, article, displayLimit) {
  if (!article || typeof article !== 'object') return null;
  const feeds = Array.isArray(state?.feeds) ? state.feeds : [];
  const feed = feeds.find((f) => f && f.id === article.feedId);
  if (!feed) return null;
  const nextState = { ...state, category: categoryOf(feed), feedId: feed.id, filter: 'all' };
  const index = visibleArticles(nextState).findIndex((a) => a && a.id === article.id);
  if (index < 0) return null;
  const base = Number.isFinite(displayLimit) && displayLimit > 0 ? displayLimit : 0;
  return { category: nextState.category, feedId: feed.id, displayLimit: Math.max(base, index + 1) };
}

// フィード1件の属性 (ジャンル・並び順・削除同期・スター選定・
// 過去分ガード) をまとめて差し替えた新しい配列を返す (元の配列は
// 壊さない)。管理画面で保存したフィード設定を、タイムライン側の
// 共有状態へ即座に反映するために使う。fields に含まれるキーだけを
// 差し替え、値は API の形に寄せて持つ (それまでの patchFeedCategory /
// patchFeedSortDirection / patchFeedSyncDeletes / patchFeedStarSettings /
// patchFeedPastGuard の寄せをここへ集約した)。
const FEED_ATTR_NORMALIZERS = {
  title: (v) => String(v || ''),
  category: (v) => String(v || ''),
  sortDirection: (v) => (v === 'asc' ? 'asc' : 'desc'),
  syncDeletes: (v) => v === true,
  starMode: (v) => (v === 'none' || v === 'recent' || v === 'all' ? v : null),
  starCount: (v) => (Number.isInteger(v) ? v : null),
  starMinSec: (v) => (Number.isInteger(v) ? v : null),
  pastGuard: (v) => (v === 'skip' || v === 'read' || v === 'off' ? v : null),
};

export function patchFeedAttrs(feeds, feedId, fields) {
  const src = fields || {};
  const patch = {};
  for (const key of Object.keys(FEED_ATTR_NORMALIZERS)) {
    if (key in src) patch[key] = FEED_ATTR_NORMALIZERS[key](src[key]);
  }
  return (Array.isArray(feeds) ? feeds : []).map((f) => (f && f.id === feedId ? { ...f, ...patch } : f));
}

// 1件の記事の一部フィールドを差し替えた新しい articles を返す
// (元の配列は壊さない)。差し替えるのは既読 (isRead) とスター
// (starred / starState) だけ。
export function patchArticle(articles, articleId, patch) {
  return (Array.isArray(articles) ? articles : []).map((a) => {
    if (!a || a.id !== articleId) return a;
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

// mergePendingReadMarks / mergePendingStarMarks の共通形。
// matches (view, want) が真ならスナップショット側と一致したとみなし、
// そうでなければ apply (view, want) で重ねた記事を返す。
function mergePendingMarks(views, marks, matches, apply) {
  const pending = marks instanceof Map ? marks : new Map();
  if (!pending.size) return { articles: views || [], keep: new Map() };
  const keep = new Map();
  const articles = (views || []).map((a) => {
    if (!a || !pending.has(a.id)) return a;
    const want = pending.get(a.id);
    if (matches(a, want)) return a;
    keep.set(a.id, want);
    return apply(a, want);
  });
  return { articles, keep };
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
  return mergePendingMarks(
    views,
    marks,
    (a, want) => a.isRead === want,
    (a, want) => ({ ...a, isRead: want })
  );
}

// 読み直した記事一覧 (views) へ、まだ DB のスナップショットに
// 反映されていると確認できていないスター変更 (marks:
// Map<記事ID, {starred, starState}>) を重ねる。mergePendingReadMarks
// のスター版で、考え方はそちらと同じ。一覧から消えた記事への変更と、
// スナップショット側と一致した変更は marks から落とす。
export function mergePendingStarMarks(views, marks) {
  return mergePendingMarks(
    views,
    marks,
    (a, want) => a.starred === want.starred && (a.starState || '') === (want.starState || ''),
    (a, want) => ({ ...a, starred: want.starred, starState: want.starState || '' })
  );
}

// ローカルの記事から数えた未読数をフィードへ付け直す。
// サーバー応答の unreadCount は使わず、端末に居る記事だけが数えられる。
export function withUnreadCounts(feeds, articles) {
  const counts = {};
  (Array.isArray(articles) ? articles : []).forEach((a) => {
    if (a && typeof a === 'object' && !a.isRead) counts[a.feedId] = (counts[a.feedId] || 0) + 1;
  });
  return (Array.isArray(feeds) ? feeds : [])
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({ ...f, unreadCount: counts[f.id] || 0 }));
}

// 日時の読み方。文字列だけを解釈し、それ以外は 0 (最も古い) として読む。
// Date.parse の素通しは、文字列化できない値で投げるため。
function timeMs(v) {
  return typeof v === 'string' ? Date.parse(v) || 0 : 0;
}

function idKey(a) {
  const id = a && typeof a === 'object' ? a.id : '';
  return typeof id === 'string' ? id : '';
}

// 新しい順 (publishedAt、無ければ fetchedAt) に並べ替えた配列を返す。
// 壊れたエントリ (null や型の違う日時) が1件混ざっても、比較関数が
// 投げて一覧全体が落ちないよう、境界で読み替える。
export function sortArticlesDesc(articles) {
  return (Array.isArray(articles) ? articles : []).slice().sort((a, b) => {
    const ta = timeMs(a?.publishedAt || a?.fetchedAt);
    const tb = timeMs(b?.publishedAt || b?.fetchedAt);
    if (tb !== ta) return tb - ta;
    const fa = timeMs(a?.fetchedAt);
    const fb = timeMs(b?.fetchedAt);
    if (fb !== fa) return fb - fa;
    const ia = idKey(a);
    const ib = idKey(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

// 古い順 (sortArticlesDesc の逆) に並べ替えた配列を返す。並び順が
// 古い順 (asc) のフィードの単体表示でだけ使う。
export function sortArticlesAsc(articles) {
  return (Array.isArray(articles) ? articles : []).slice().sort((a, b) => {
    const ta = timeMs(a?.publishedAt || a?.fetchedAt);
    const tb = timeMs(b?.publishedAt || b?.fetchedAt);
    if (ta !== tb) return ta - tb;
    const fa = timeMs(a?.fetchedAt);
    const fb = timeMs(b?.fetchedAt);
    if (fa !== fb) return fa - fb;
    const ia = idKey(a);
    const ib = idKey(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

// すべて既読の対象範囲 (フィード指定が優先、次にカテゴリ、無ければ全体) に
// 入るフィードIDの集合。
export function markAllReadScope(state, feedId = '', category = '') {
  const inScope = (f) => {
    if (!f || typeof f !== 'object') return false;
    if (feedId) return f.id === feedId;
    if (category) return categoryOf(f) === category;
    return true;
  };
  const scopedFeedIds = {};
  (Array.isArray(state.feeds) ? state.feeds : []).forEach((f) => { if (inScope(f)) scopedFeedIds[f.id] = true; });
  return scopedFeedIds;
}

export function markAllReadInList(state, feedId = '', category = '') {
  const scopedFeedIds = markAllReadScope(state, feedId, category);
  const all = !feedId && !category;
  const articles = (Array.isArray(state.articles) ? state.articles : []).map((a) =>
    !a || typeof a !== 'object' ? a : all || scopedFeedIds[a.feedId] ? { ...a, isRead: true } : a
  );
  const feeds = (Array.isArray(state.feeds) ? state.feeds : []).map((f) => {
    if (!f || typeof f !== 'object') return f;
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
  return (Array.isArray(state.articles) ? state.articles : []).filter(
    (a) => a && typeof a === 'object' && !a.isRead && (all || scopedFeedIds[a.feedId])
  );
}

// フィードチップの表示対象。未読フィルタのときは未読があるフィードだけに
// 絞る (未読ゼロならチップは出ない)。ただし選択中のフィードは、
// 未読がゼロでも行き場が無くならないよう残す。
export function visibleFeedChips(state) {
  let feeds = Array.isArray(state?.feeds) ? state.feeds : [];
  if (state?.category) {
    feeds = feeds.filter((f) => categoryOf(f) === state.category);
  }
  if (state?.filter === 'unread') {
    return feeds.filter((f) => f && typeof f === 'object' && ((f.unreadCount || 0) > 0 || f.id === state.feedId));
  }
  return feeds;
}
