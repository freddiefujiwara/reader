<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { API_URL, GOOGLE_CLIENT_ID } from './config.js';
import {
  deleteFeed,
  exchangeSession,
  exchangeShare,
  getShareLinkStatus,
  getStats,
  issueShareLink,
  listArticles,
  listFeeds,
  logEvents,
  reorderFeeds,
  revokeShareLink,
  saveFeed,
  setStar,
} from './lib/api.js';
import { buildShareUrl, formatShareExpiry } from './lib/shareLink.js';
import {
  buildSaveFeedPayload,
  createFeedForm,
  feedFormFromFeed,
  filterAdminFeeds,
  formatFeedStatus,
  genreSuggestions,
  dragInsertIndex,
  dragRowPitch,
  isFeedFormDirty,
  moveItemToIndex,
  createOrderSender,
  planFeedAdd,
  resolveFeedAddForm,
  validateFeedUrl,
  youtubeChannelIdFromUrl,
} from './lib/feedAdmin.js';
import { clearSession, loadSession, saveSession } from './lib/session.js';
import {
  createListState,
  feedCategories,
  feedDisplayName,
  isPlayableArticle,
  markAllReadInList,
  markAllReadTargets,
  mergePendingReadMarks,
  mergePendingStarMarks,
  patchArticle,
  patchFeedCategory,
  shouldClearCategorySelection,
  sortArticlesDesc,
  visibleArticles,
  visibleFeedChips,
  withUnreadCounts,
} from './lib/listState.js';
import {
  FEED_HASH_TRANSFER_KEY,
  articleRecordToView,
  clearLocalArticleAudio,
  clearLocalArticlePlayPos,
  closeLocalDb,
  deleteLocalArticles,
  getLocalMeta,
  ingestFeedArticles,
  loadLocalArticles,
  loadLocalFeeds,
  markLocalArticlesRead,
  migrateFeedHashIds,
  migrateYouTubeChannelUrlIds,
  planLocalPrune,
  planOrphanArticles,
  pruneTransferredState,
  saveLocalFeeds,
  setLocalArticlePlayPos,
  setLocalArticleRead,
  setLocalArticleStar,
  setLocalMeta,
  syncLocalArticleStars,
} from './lib/localDb.js';
import { normalizeFeedIds } from './lib/feedHash.js';
import { buildRoutePath, parseRoute, routeSegmentsFromPathname } from './lib/route.js';
import { fetchAllFeeds, fetchFeedXml, fetchOneFeed } from './lib/feedFetch.js';
import { withTimeout } from './lib/retry.js';
import { createScrollRestorer } from './lib/scrollRestore.js';
import { formatPublishedAt } from './lib/format.js';
import {
  buildQueue,
  clampSeek,
  classifyRate,
  createStallTracker,
  durationMismatch,
  failedEpisodePlan,
  foregroundRecoveryAction,
  formatTime,
  interpretStoredPlayPos,
  isWithinEndGuard,
  isWithinStartGuard,
  loadPlayMode,
  loadTimeModel,
  nextEpisodePlan,
  nextRepeat,
  nextSpeed,
  progressRatio,
  reachedKnownDurationEnd,
  skipPlan,
  END_CHECK_INTERVAL_MS,
  KNOWN_DURATION_END_TOLERANCE_SEC,
  PRELOAD_REMAINING_SEC,
  REPEAT_LABELS,
  YOUTUBE_END_LEAD_SEC,
  savePlayMode,
  saveTimeModel,
  toDisplayPosition,
  toElementPosition,
} from './lib/player.js';
import { createEventQueue, createListenTracker } from './lib/eventLog.js';

// 画面に出す件数の初期値と「もっと見る」の増分 (v2 は全件ローカルにあるため、
// サーバー取得ではなく表示ウィンドウを広げるだけ)。
const DISPLAY_LIMIT = 50;
// 既読の初回取り込みでサーバーから受け取る上限 (保持上限と同じ)。
const IMPORT_LIMIT = 5000;
const year = new Date().getFullYear();
// ヘッダーのブランドのリンク先: アプリのトップ (ベース URL そのもの。
// 本番は /reader/、ステージングは /reader/staging/)。ジャンルや
// フィードの選択を表すパスを含まないため、常に素のトップへ飛ぶ。
const topUrl = import.meta.env.BASE_URL;

const session = ref(loadSession());
const bootError = ref('');
// 起動中 (セッション復元・共有リンク交換) とサインイン交換中は
// ログインボタンを出さず、スピナー＋「読み込んでいます…」にする
// (戻ってきた直後にボタンが見えて未ログインと誤解されるのを防ぐ)。
const booting = ref(true);
const signingIn = ref(false);
// GIS スクリプトが読み込めなかった (広告ブロック等) ときに、ボタンが
// 描画できない理由をサインインボックスへ出すためのフラグ。
const googleScriptError = ref(false);
const loading = ref(true);
const refreshing = ref(false);
const listError = ref('');
const displayLimit = ref(DISPLAY_LIMIT);
const state = ref(createListState());
const signinEl = ref(null);

// 未読のみ表示の間に既読へ遷移した記事の ID。既読になってもカードを
// その場で消さず、既読スタイル (薄い表示) のまま残すための保持集合。
// メモリ上だけに持ち、フィード・カテゴリ・既読フィルタの選択が
// 変わった時点 (＝絞り込みの再適用) で空にする。ページを開き直せば
// 自然に空になる。
const stickyReadIds = ref(new Set());

function clearStickyReadIds() {
  if (stickyReadIds.value.size) stickyReadIds.value = new Set();
}

function keepStickyReadIds(ids) {
  const next = new Set(stickyReadIds.value);
  (ids || []).forEach((id) => next.add(id));
  if (next.size !== stickyReadIds.value.size) stickyReadIds.value = next;
}

function dropStickyReadId(id) {
  if (!stickyReadIds.value.has(id)) return;
  const next = new Set(stickyReadIds.value);
  next.delete(id);
  stickyReadIds.value = next;
}

// 視聴ログの scroll を送ったフィードの ID。フィードの訪問ごとに
// 1回だけ送るため、最後に送ったフィードを持ち、フィード選択が
// 変わるたびにリセットする (setFeed / setCategory / goUnreadAll /
// applyRoute の選択変更時)。
let scrollLoggedFeedId = '';

// 画面切替 ('timeline' | 'feeds')。フィード管理はオーナーのみ。
const view = ref('timeline');
const mgmtFeeds = ref([]);
// 管理画面のジャンル絞り込み。タイムラインのカテゴリ選択 (state.category)
// とは独立に持つ (行き来しても互いに影響しない)。
const adminCategory = ref('');
const mgmtLoading = ref(false);
const mgmtError = ref('');
const mgmtSavingId = ref('');
const confirmDeleteId = ref('');
// 共有リンク (マジックリンク)。サーバーはトークンのハッシュしか
// 持たないため、平文の URL を表示できるのは発行したこの画面だけ
// (shareUrl は発行直後にだけ入る)。
const shareStatus = ref(null); // null=未取得 / { active, expiresAt }
const shareUrl = ref('');
const shareLoading = ref(false);
const shareSaving = ref(false);
const shareError = ref('');
const shareConfirm = ref(''); // '' | 'issue' | 'revoke'
const shareCopied = ref(false);
// 今週の視聴 (管理画面の共有リンクの下)。週単位の集計なので、
// 取得は管理画面を開いたときの1回だけにする。
const statsData = ref(null); // null=未取得 / { currentWeek, current }
const statsLoading = ref(false);
const statsError = ref('');
const formMode = ref(''); // '' | 'add' | 'edit'
const formEl = ref(null);
const form = ref(createFeedForm());
const formBase = ref(null);
const formError = ref('');
const formSaving = ref(false);
const formFetching = ref(false);
// フォームを開く前のスクロール位置。編集中は一覧が隠れてドキュメントが
// 短くなり、閉じるとブラウザの位置復元で一覧の最下部へ飛ぶため、開く前に
// 覚えておき、閉じて一覧が戻った後に復元する。
const formScroll = createScrollRestorer(window);
// 編集フォームの内容が、開いた時点のフィードから変わっているか。
// 保存ボタンは変更があるときだけ押せる (未変更の保存は何も生まない)。
// 追加フォームでは formBase が無いため常に「変更あり」になるが、
// 非活性の条件は編集フォームだけに効かせる。
const formDirty = computed(() => isFeedFormDirty(formBase.value, form.value));

const isReadonly = computed(() => session.value?.role === 'readonly');
const isOwner = computed(() => session.value?.role === 'owner');
// YouTube フィードの ID 集合。記事が YouTube 由来かどうかは、
// フィードの保存 URL からチャンネル ID が取れるかで判定する
// (サーバー側の RSS 出し分けと同じ判定)。
const youtubeFeedIds = computed(() =>
  new Set(
    state.value.feeds
      .filter((f) => youtubeChannelIdFromUrl(f.url))
      .map((f) => f.id)
  )
);
const isYouTubeArticle = (a) => youtubeFeedIds.value.has(a.feedId);
// 再生ボタンを出す (＝キューに入れる) 記事か。YouTube 記事は
// スター付きのものだけ、それ以外は音声URLの有無で決まる。
const canPlay = (a) => isPlayableArticle(a, youtubeFeedIds.value);
const visible = computed(() => visibleArticles(state.value, stickyReadIds.value));
const displayArticles = computed(() => visible.value.slice(0, displayLimit.value));
const unreadTotalCount = computed(() =>
  state.value.feeds.reduce((n, f) => n + (f.unreadCount || 0), 0)
);
// 「すべて既読」の対象件数 (現在のスコープ = 選択中のフィード／
// カテゴリ内の未読)。ボタンの非活性判定、確認を出すかの判定、
// 確認文言の件数に使う。
const scopedUnreadCount = computed(() =>
  markAllReadTargets(state.value, state.value.feedId, state.value.category).length
);
const chipFeeds = computed(() => visibleFeedChips(state.value));
const categoryList = computed(() => feedCategories(state.value.feeds));
// 管理フォームのジャンル候補: 現在のフィード一覧にあるものを出現順に。
const genreOptions = computed(() => feedCategories(mgmtFeeds.value));
// 入力中の文字列で絞った候補。フォーム内の通常フローにチップで
// 出し、タップで入力欄へ入れる (datalist は使わない)。
const genreSuggestionList = computed(() => genreSuggestions(genreOptions.value, form.value.category));
// 管理一覧の表示対象: 選択中のジャンルに合うフィードだけ。
const adminFeeds = computed(() => filterAdminFeeds(mgmtFeeds.value, adminCategory.value));
const hasMore = computed(() => visible.value.length > displayLimit.value);

// 要約の「もっと見る」展開。折りたたみは CSS の line-clamp (3行) で、
// 実際に省略されているカードにだけボタンを出すため、描画後に各要約
// 要素の scrollHeight / clientHeight を比べて省略の有無を測る。
// 展開状態は記事ごとのローカル状態で、保存はしない。
const expandedSummaryIds = ref(new Set());
const clampedSummaryIds = ref(new Set());
const summaryEls = new Map();

function registerSummaryEl(id, el) {
  if (el) summaryEls.set(id, el);
  else summaryEls.delete(id);
}

function measureSummaries() {
  const next = new Set();
  for (const [id, el] of summaryEls) {
    if (expandedSummaryIds.value.has(id)) {
      // 展開中は測れない (省略されていない)。閉じたときに測り直すため、
      // それまでの省略判定は引き継ぐ。
      if (clampedSummaryIds.value.has(id)) next.add(id);
      continue;
    }
    if (el.scrollHeight === 0 && el.clientHeight === 0) {
      // まだレイアウトされていない (描画前・非表示) 要素は測れない。
      // 空振りの測定で判定を落とさないよう、前回を引き継ぐ。
      if (clampedSummaryIds.value.has(id)) next.add(id);
      continue;
    }
    if (el.scrollHeight > el.clientHeight + 1) next.add(id);
  }
  clampedSummaryIds.value = next;
}

// 測定の予約。状態変更の直後 (nextTick) に測るだけでは、ブラウザが
// line-clamp のレイアウトを確定させる前の値を読んで「省略なし」と
// 誤判定し、ボタンが消えたままになることがある (起動直後や既読化の
// 直後に発生)。次ティックで測ったうえで、レイアウトが落ち着く次の
// アニメーションフレームでもう一度測り直して誤判定を正す。
let measureFramePending = false;
function scheduleMeasureSummaries() {
  nextTick(measureSummaries);
  if (measureFramePending) return;
  measureFramePending = true;
  const run = () => {
    measureFramePending = false;
    measureSummaries();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else nextTick(run);
}

function toggleSummary(id) {
  const next = new Set(expandedSummaryIds.value);
  if (next.has(id)) {
    next.delete(id);
    expandedSummaryIds.value = next;
    // 折りたたみ直後は再描画とレイアウトの確定を待って測り直す。
    scheduleMeasureSummaries();
  } else {
    next.add(id);
    expandedSummaryIds.value = next;
    const article = state.value.articles.find((a) => a.id === id);
    if (article) {
      // 視聴ログ: 要約を展開した操作を記録する (閉じる操作では送らない)。
      queueEvent({
        type: 'expand',
        feed_id: article.feedId,
        feed_title: article.feedTitle || feedTitleOf(article.feedId),
        article_id: article.id,
        article_title: article.title || '',
      });
      flushEventLog();
      // 展開したら、その記事は読んだ扱いにする (「既読にする」と同じ
      // applyRead の経路。閉じる操作では既読を取り消さない)。
      if (!article.isRead) applyRead(article, true);
    }
  }
}

watch(displayArticles, () => scheduleMeasureSummaries());
window.addEventListener('resize', scheduleMeasureSummaries);
onUnmounted(() => window.removeEventListener('resize', scheduleMeasureSummaries));

// 選択中のカテゴリ (ジャンル) を持つフィードが1つも無くなったら、
// 選択を自動で解除して全件表示に戻す。最後の1件を別ジャンルへ
// 編集・削除するとカテゴリのチップ自体が消え、手では解除できなく
// なるため。一覧が空の間 (読み込み中・未取得) は解除しない
// (判定は shouldClearCategorySelection に任せる)。
//
// 解除の判定は、一覧が変わった瞬間ではなく、関連する非同期処理が
// 落ち着いた後の最新の一覧で行う。背景更新は保存前に取り始めた
// 旧一覧で一時的に読み直すことがあり、その瞬間に解除すると、
// 追随更新で最新の一覧 (カテゴリあり) に揃い直しても絞り込み
// だけが外れたままになるため。
// 「関連する非同期処理が落ち着いたら1回だけ判定する」ための共通の
// 受け口。実行中にもう一度呼ばれたら同じ Promise を返し、終わったら
// 次の呼び出しで新しい判定が始まる。
function createQueuedCheck(run) {
  let current = null;
  return () => {
    if (current) return current;
    const p = (async () => { await run(); })();
    current = p;
    const done = () => { if (current === p) current = null; };
    p.then(done, done);
    return p;
  };
}

const queueTimelineCategoryClearCheck = createQueuedCheck(async () => {
  while (refreshInFlight) {
    const current = refreshInFlight;
    await current.catch(() => {});
    // 更新の完了処理 (後始末や、戻る際に予約される追随更新) が
    // 次の更新を差し込む余地を残してから、継続を確認する。
    await nextTick();
  }
  if (!shouldClearCategorySelection(state.value.feeds, state.value.category)) return;
  // setCategory と同じく、カテゴリが外れるときはフィード選択も外す。
  // 選択範囲が変わるので、未読表示中に残していた既読カードも畳む。
  clearStickyReadIds();
  scrollLoggedFeedId = '';
  state.value = { ...state.value, category: '', feedId: '' };
  displayLimit.value = DISPLAY_LIMIT;
});

const queueAdminCategoryClearCheck = createQueuedCheck(async () => {
  // 一覧の取り直し・保存・削除の完了後に、最新の一覧で判定する。
  while (mgmtLoading.value || formSaving.value || mgmtSavingId.value) {
    await nextTick();
  }
  if (shouldClearCategorySelection(mgmtFeeds.value, adminCategory.value)) {
    adminCategory.value = '';
  }
});

watch(
  () => state.value.feeds,
  (feeds) => {
    if (shouldClearCategorySelection(feeds, state.value.category)) {
      queueTimelineCategoryClearCheck();
    }
  }
);
watch(mgmtFeeds, (feeds) => {
  if (shouldClearCategorySelection(feeds, adminCategory.value)) {
    queueAdminCategoryClearCheck();
  }
});

// フィード選択が実在しないフィードを指していたら解除する (カテゴリの
// 自動解除と同じ考え方)。パーマリンクで開いた直後は一覧がまだ無く
// 検証できないため、一覧が揃った時点でここで落とす。削除された
// フィードへの選択が残ると、一覧が空のまま手で解除できなくなる。
watch(
  () => state.value.feeds,
  (feeds) => {
    const feedId = state.value.feedId;
    if (!feedId || !feeds.length) return;
    if (!feeds.some((f) => f.id === feedId)) {
      // 選択が外れて表示範囲が広がるので、残していた既読カードも畳む。
      clearStickyReadIds();
      state.value = { ...state.value, feedId: '' };
    }
  }
);

/* ---- URL パーマリンク (パス) と画面状態の同期 ---- */

// 起動時の URL が指す状態 (route.js 参照)。アプリのベース配下で
// 開かれていない場合 (テスト環境など) は bootSegments が null に
// なり、ルーティング自体を無効にする。
// ここではフィード一覧がまだ無いため、未知ジャンル・未知フィードの
// 検証はせずに初期状態として取り込む。検証は一覧が揃った後の
// watcher (カテゴリ自動解除・上のフィード選択解除) が担う。
// 保存済みの表示状態より URL を優先する (このアプリは絞り込みを
// 端末へ保存していないため、既定値より優先という意味になる)。
const bootSegments = routeSegmentsFromPathname(window.location.pathname);
const routingEnabled = bootSegments !== null;
const initialRoute = routingEnabled ? parseRoute(bootSegments) : null;
let routeStaging = initialRoute ? initialRoute.staging : false;

// URL が指す状態を画面へ反映する。管理画面はオーナーのみ
// (openFeedAdmin と同じ制限。読み取り専用ではタイムラインのまま)。
function applyRoute(route) {
  if (!route) return;
  routeStaging = route.staging;
  if (route.view === 'feeds') {
    if (!isOwner.value) return;
    openFeedAdmin();
    adminCategory.value = route.category;
    return;
  }
  if (view.value !== 'timeline') {
    backToTimeline();
  }
  // URL が指す選択へ移る (絞り込みの再適用) なら、未読表示中に
  // 残していた既読カードは畳む。同じ選択のままなら保持する。
  const nextFilter = route.unread ? 'unread' : 'all';
  if (
    state.value.category !== route.category
    || state.value.feedId !== route.feedId
    || state.value.filter !== nextFilter
  ) {
    clearStickyReadIds();
    scrollLoggedFeedId = '';
  }
  state.value = {
    ...state.value,
    category: route.category,
    feedId: route.feedId,
    filter: nextFilter,
  };
  displayLimit.value = DISPLAY_LIMIT;
}

if (initialRoute) applyRoute(initialRoute);

// ヘッダーのタイトル押下: リンク先 (アプリのトップ) へ、ページを
// 開き直さずにアプリ内で移動する。再生中の音声はそのまま続く。
// href 自体は残すので、中クリックや修飾キー付きクリックでは
// ブラウザ既定の開き方 (新しいタブ等) になる。
// 一覧の先頭へ戻す。タイトル押下 (goHome) と、フィード・ジャンル等の
// 選択変更で共用する。
function scrollToTop() {
  window.scrollTo({ top: 0 });
}

function goHome() {
  applyRoute({ view: 'timeline', category: '', feedId: '', unread: false, staging: routeStaging });
  scrollToTop();
}

function onBrandClick(event) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!session.value) return; // 未ログインでは通常のリンクとして開く
  event.preventDefault();
  goHome();
}

// 画面状態から現在の URL パスを組み立てる (管理画面では管理側の
// ジャンル、タイムラインではカテゴリ＋フィード選択を見る)。
function routePathForState() {
  return buildRoutePath({
    staging: routeStaging,
    view: view.value,
    category: view.value === 'feeds' ? adminCategory.value : state.value.category,
    feedId: view.value === 'feeds' ? '' : state.value.feedId,
    unread: view.value === 'feeds' ? false : state.value.filter === 'unread',
  });
}

// 状態が変わったら URL を書き換える。コピーした URL を開けば
// いまの表示が再現できる状態を保つ。URL から反映した変更は、
// 組み立てたパスが現在のパスと一致するため書き換えが起きない。
// ハッシュ (#share= 等) は引き継ぐ。
watch(
  [
    view,
    adminCategory,
    () => state.value.category,
    () => state.value.feedId,
    () => state.value.filter,
  ],
  () => {
    if (!routingEnabled) return;
    const path = routePathForState();
    if (path === window.location.pathname) return;
    history.pushState(null, '', path + window.location.search + window.location.hash);
  }
);

// ブラウザの戻る・進むでは、URL が指す状態を画面へ反映し直す。
// 一覧が揃っていれば parseRoute の実在チェックも効く。
function onPopState() {
  if (!routingEnabled) return;
  const segments = routeSegmentsFromPathname(window.location.pathname);
  if (!segments) return;
  applyRoute(parseRoute(segments, state.value.feeds));
}
window.addEventListener('popstate', onPopState);
onUnmounted(() => window.removeEventListener('popstate', onPopState));

const FILTERS = [
  { key: 'all', label: 'すべて' },
  { key: 'unread', label: '未読' },
];

/* ---- ローカル (IndexedDB) が表示の正本 ---- */

// 付けたばかりで、背景更新の読み直し (reloadLocal) が使う DB の
// スナップショットに含まれているか分からない既読変更 (記事ID -> isRead)。
// 読み直しは読み取り開始時点の中身で state を作り直すため、この間に
// 付けた既読は DB へ書けていても未読へ巻き戻ってしまう。そこで変更を
// ここに控えておき、reloadLocal が読み直した一覧へ重ね直す。
// スナップショット側と一致した変更はその読み直しで控えから落ちる。
const pendingReadMarks = new Map();

// 付け外したばかりで、背景更新の読み直し・スター同期が使う DB の
// スナップショットに反映されていると確認できていないスター変更
// (記事ID -> {starred, starState})。pendingReadMarks のスター版で、
// reloadLocal が読み直した一覧へ重ね直し、スナップショット側と
// 一致した変更はその読み直しで控えから落ちる。スター同期
// (refreshOnce) はこの控えがある記事を上書き対象から外す。
const pendingStarMarks = new Map();

// DB の中身を state へ読み直す。未読数はローカルの記事から数える。
async function reloadLocal() {
  const [feeds, records] = await Promise.all([loadLocalFeeds(), loadLocalArticles()]);
  const titles = {};
  feeds.forEach((f) => { titles[f.id] = feedDisplayName(f); });
  const loaded = sortArticlesDesc(records.map((r) => articleRecordToView(r, titles[r.feed_id])));
  const merged = mergePendingReadMarks(loaded, pendingReadMarks);
  pendingReadMarks.clear();
  merged.keep.forEach((isRead, id) => { pendingReadMarks.set(id, isRead); });
  const starMerged = mergePendingStarMarks(merged.articles, pendingStarMarks);
  pendingStarMarks.clear();
  starMerged.keep.forEach((mark, id) => { pendingStarMarks.set(id, mark); });
  const views = starMerged.articles;
  state.value = { ...state.value, feeds: withUnreadCounts(feeds, views), articles: views };
}

// 背景更新: (a) フィード一覧をサーバーから取り直し、(b) 全フィードを
// クライアントから取得して取り込む。失敗したフィードは前回の記事を残す。
// 実行中にもう一度呼ばれたら同じ Promise を返す (多重実行防止)。
let refreshInFlight = null;

// 管理でフィードを保存・削除したかどうか。タイムラインへ戻るとき、
// 実行中の背景更新があると変更前の一覧で上書きされる可能性があるため、
// 完了後にもう一度更新するための目印。
let adminFeedsDirty = false;

function refreshInBackground() {
  if (refreshInFlight) return refreshInFlight;
  const run = refreshOnce();
  refreshInFlight = run;
  const clear = () => { if (refreshInFlight === run) refreshInFlight = null; };
  run.then(clear, clear);
  return run;
}

async function refreshOnce() {
  if (!session.value) return;
  refreshing.value = true;
  try {
    // (a) フィード一覧。既読の初回取り込みがまだなら、その素材も兼ねて
    // 大きめに取る (取り込みは v1 のサーバー状態を1回だけ引き継ぐため)。
    let feeds = [];
    let importPayload = null;
    let starRows = [];
    let listOk = false;
    const needImport = !(await getLocalMeta('statesImportedV2'));
    try {
      // スター状態の同期にも使うため、記事も毎回まとめて取る
      // (サーバー側で上限は調整される)。
      const payload = await listArticles(session.value.token, { limit: IMPORT_LIMIT });
      if (Array.isArray(payload.feeds)) feeds = payload.feeds;
      if (needImport) importPayload = payload;
      if (Array.isArray(payload.articles)) starRows = payload.articles;
      listOk = true;
    } catch (e) {
      if (expireIfUnauthorized(e)) return;
      // サーバーに届かなくても、ローカルのフィード一覧で取得は続ける。
    }
    if (!listOk) feeds = await loadLocalFeeds();
    // ローカルでの同一性は URL ハッシュに統一する。サーバー側の移行が
    // 済むまでは旧IDが返ることがあるが、記事・絞り込み・未読数は
    // ハッシュ側で揃える (fetchUrl はサーバーのものをそのまま使う)。
    feeds = await normalizeFeedIds(feeds);
    // フィードID移行 (初回のみ)。キャッシュを新しい一覧で上書きする
    // 前に済ませる (移行の素材はキャッシュ済みの旧ID一覧のため)。
    await migrateFeedHashIds();
    // YouTube の保存 URL 形式変更 (videos.xml → /channel/) に伴う移行。
    // サーバー側のシート移行より先にこのコードが行き渡る必要があるため、
    // 移行はサーバーが新形式を返し始めてから効く。完了までは更新の
    // たびに試し直す (素材はキャッシュ済みの旧形式一覧のため、
    // キャッシュの上書き前に呼ぶ)。
    await migrateYouTubeChannelUrlIds(feeds);
    if (listOk) await saveLocalFeeds(feeds);

    // サーバー側で消えたフィードの記事はローカルからも落とす。
    const records = await loadLocalArticles();
    const orphanIds = planOrphanArticles(records, feeds.map((f) => f.id));
    if (orphanIds.length) {
      await deleteLocalArticles(orphanIds);
    }

    // (b) 全フィード取得 → 取り込み。
    // 取り込みはフィードごとに ingestFeedArticles が単一トランザクションで
    // 最新のローカル状態を読み直してから書き込む。更新開始時点の
    // スナップショットを書き込みの根拠にすると、取得の合間に付けた
    // 既読・再生位置が古いレコードごと上書きされ巻き戻るため使わない。
    const fetchedAt = new Date().toISOString();
    const results = await fetchAllFeeds(feeds);
    // ID 移行で退避した状態 (既読・再生位置) を、再取得した記事へ戻す。
    let transfer = await getLocalMeta(FEED_HASH_TRANSFER_KEY);
    const hasTransfer = !!transfer && Object.keys(transfer).length > 0;
    for (const result of results) {
      if (!result.ok) continue;
      const { consumedKeys } = await ingestFeedArticles(
        result.feed, result.entries, fetchedAt, hasTransfer ? transfer : null
      );
      consumedKeys.forEach((key) => { delete transfer[key]; });
    }
    if (hasTransfer) {
      // 取得できたフィード分は付け替え終了。一致しなかった記事は
      // フィードから外れているので落とす。取得に失敗した分は次回へ残す。
      const fetchedOkIds = new Set(results.filter((r) => r.ok).map((r) => r.feed.id));
      const keepIds = new Set(feeds.map((f) => f.id).filter((id) => !fetchedOkIds.has(id)));
      await setLocalMeta(FEED_HASH_TRANSFER_KEY, pruneTransferredState(transfer, keepIds));
    }

    // 既読の初回取り込み (この端末で初回だけ)。取り込めた記事だけ既読にする。
    // 存在確認は取り込み後の最新状態で行う (開始時点のスナップショットは使わない)。
    if (importPayload) {
      const present = new Set((await loadLocalArticles()).map((r) => r.id));
      const readIds = (importPayload.articles || [])
        .filter((a) => a.isRead)
        .map((a) => a.id)
        .filter((id) => present.has(id));
      await markLocalArticlesRead(readIds, fetchedAt);
      await setLocalMeta('statesImportedV2', true);
    }

    // スター状態の同期 (サーバーが正本)。list 応答の starred /
    // star_state でローカルレコードを上書きする。スター項目を
    // 持たない応答 (サーバー未対応) では何もしない。付け外した
    // 直後で未確定の記事 (pendingStarMarks) は、古い応答で
    // 巻き戻さないよう対象から外す。
    if (listOk) {
      const rows = starRows.filter(
        (a) => a && a.id && !pendingStarMarks.has(a.id)
          && (typeof a.starred === 'boolean' || typeof a.star_state === 'string')
      );
      if (rows.length) await syncLocalArticleStars(rows);
    }

    // 保持ルール (既読60日・上限) でローカルを掃除する。
    const pruneIds = planLocalPrune(await loadLocalArticles(), new Date().toISOString());
    if (pruneIds.length) await deleteLocalArticles(pruneIds);

    await reloadLocal();
    listError.value = '';
  } catch (e) {
    // ローカルに記事がある間は、背景更新の失敗を画面に出さない。
    if (!state.value.articles.length) {
      listError.value = `記事を読み込めませんでした（${e.message}）。時間をおいて開き直してください。`;
    }
  } finally {
    refreshing.value = false;
  }
}

// 起動時の読み込みが固まっても画面を出すための上限 (ミリ秒)。
const BOOT_LOCAL_TIMEOUT_MS = 8000;
const BOOT_REFRESH_TIMEOUT_MS = 60000;

// 起動時: まずローカルを即座に出し、その後で背景更新する。
// ローカルが空の初回だけ、背景更新の完了まで読み込み表示を続ける。
async function initTimeline() {
  loading.value = true;
  try {
    // ローカル読み直しが固まると (DB 接続の競合など) 読み込み表示の
    // まま止まるため、上限時間を設ける。読み直し自体は裏で続く。
    await withTimeout(reloadLocal(), BOOT_LOCAL_TIMEOUT_MS);
  } catch (e) {
    listError.value = `ローカルデータを読み込めませんでした（${e.message}）。`;
  }
  const firstRun = !state.value.articles.length && !state.value.feeds.length;
  if (!firstRun) loading.value = false;
  // 背景更新にも上限を設け、通信が固まっても読み込み表示を終わらせる。
  await withTimeout(refreshInBackground(), BOOT_REFRESH_TIMEOUT_MS).catch(() => {});
  loading.value = false;
  // 一覧が出揃った時点で要約の省略を測り直す (起動直後の測定は
  // レイアウト確定前で空振りすることがあるため)。
  scheduleMeasureSummaries();
}

async function onManualRefresh() {
  if (!session.value) return;
  await refreshInBackground();
}

function setFeed(feedId) {
  // 選択中のフィードを再タップしたら解除し、全件表示に戻す
  // (「すべて」チップは廃止し、トグル選択にした)。
  const next = state.value.feedId === feedId ? '' : feedId;
  if (next === state.value.feedId) return;
  clearStickyReadIds();
  scrollLoggedFeedId = '';
  state.value = { ...state.value, feedId: next };
  displayLimit.value = DISPLAY_LIMIT;
  // 別のフィードの一覧へ移るので、先頭から見せる。
  scrollToTop();
  // 視聴ログ: フィードを開いた操作だけを記録する (選択の解除や
  // ジャンルだけの変更、初期表示・背景更新では送らない)。
  if (next) {
    queueEvent({
      type: 'feed_view',
      feed_id: next,
      feed_title: feedTitleOf(next),
      article_id: '',
      article_title: '',
    });
    flushEventLog();
  }
}

function setCategory(category) {
  // 選択中のカテゴリを再タップしたら解除し、全件表示に戻す
  // (「すべて」チップは廃止し、トグル選択にした)。
  const next = state.value.category === category ? '' : category;
  if (next === state.value.category) return;
  clearStickyReadIds();
  scrollLoggedFeedId = '';
  // カテゴリを変えたらフィード選択は解除する (対象外フィードが残らないように)。
  state.value = { ...state.value, category: next, feedId: '' };
  displayLimit.value = DISPLAY_LIMIT;
  scrollToTop();
}

function setFilter(filter) {
  if (state.value.filter === filter) return;
  clearStickyReadIds();
  state.value = { ...state.value, filter };
  displayLimit.value = DISPLAY_LIMIT;
  scrollToTop();
}

// ヘッダーの未読ピル: 全フィードの未読一覧へ移動する。
async function goUnreadAll() {
  const fromAdmin = view.value !== 'timeline';
  if (fromAdmin) {
    view.value = 'timeline';
    await waitReorderSettled();
    refreshInBackground();
  }
  if (state.value.feedId === '' && state.value.category === '' && state.value.filter === 'unread' && !fromAdmin) return;
  // 未読一覧へ移る (選択の組み合わせが変わる) なら、残していた
  // 既読カードは畳む。管理画面から戻るだけで選択が同じなら保持する。
  if (state.value.feedId !== '' || state.value.category !== '' || state.value.filter !== 'unread') {
    clearStickyReadIds();
    scrollLoggedFeedId = '';
  }
  state.value = { ...state.value, feedId: '', category: '', filter: 'unread' };
  displayLimit.value = DISPLAY_LIMIT;
  scrollToTop();
}

// 既読の付け外しはローカルのみ (サーバーへは送らない)。
async function applyRead(article, isRead) {
  if (!isOwner.value) return;
  // 未読のみ表示の間に未読→既読へ遷移したら、そのカードは一覧に
  // 残す (薄い既読表示になるだけ)。未読へ戻したら保持から外す
  // (未読なのでどのみち表示される)。
  const current = state.value.articles.find((a) => a.id === article.id) || article;
  if (isRead) {
    if (state.value.filter === 'unread' && !current.isRead) keepStickyReadIds([article.id]);
  } else {
    dropStickyReadId(article.id);
  }
  // 実行中の背景更新の読み直しに巻き戻されないよう、先に控える
  // (reloadLocal が読み直した一覧へ重ね直す)。
  pendingReadMarks.set(article.id, isRead);
  const nextArticles = patchArticle(state.value.articles, article.id, { isRead });
  state.value = {
    ...state.value,
    articles: nextArticles,
    feeds: withUnreadCounts(state.value.feeds, nextArticles),
  };
  try {
    await setLocalArticleRead(article.id, isRead, new Date().toISOString());
  } catch (e) {
    // 書けなかった変更は控えからも落とす (次の読み直しで DB の
    // 中身どおりに戻る。従来の失敗時の振る舞いと同じ)。
    pendingReadMarks.delete(article.id);
    listError.value = `保存できませんでした（${e.message}）。`;
  }
}

function onOpenArticle(article) {
  // 視聴ログ: 記事を開いた操作を記録する (既読かどうかによらない。
  // 聴き終えたときの既読化はこの経路を通らないので数えない)。
  queueEvent({
    type: 'article_open',
    feed_id: article.feedId,
    feed_title: article.feedTitle || feedTitleOf(article.feedId),
    article_id: article.id,
    article_title: article.title || '',
  });
  flushEventLog();
  if (isOwner.value && !article.isRead) {
    // 元記事を開く操作は止めない。既読化はローカルに書くだけ。
    applyRead(article, true);
  }
}

// スターの付け外し。スターはサーバーが正本なので、画面とローカルを
// 楽観的に先に変えてから set_star を送る。サーバーへ届かなければ、
// 画面・ローカルとも元の状態へ戻す。付けた場合は手動の印 'on'、
// 外した場合は 'off' が star_state に残る (実効スター starred は
// 次回の list 同期でもサーバー側の値に揃う)。
async function applyStar(article, on) {
  if (!isOwner.value || !session.value) return;
  const prev = { starred: !!article.starred, starState: article.starState || '' };
  const next = { starred: !!on, starState: on ? 'on' : 'off' };
  if (prev.starred === next.starred && prev.starState === next.starState) return;
  // 実行中の背景更新の読み直し・スター同期に巻き戻されないよう、
  // 先に控える (reloadLocal が読み直した一覧へ重ね直す)。
  pendingStarMarks.set(article.id, next);
  state.value = {
    ...state.value,
    articles: patchArticle(state.value.articles, article.id, next),
  };
  try {
    await setLocalArticleStar(article.id, next.starred, next.starState);
  } catch (e) {
    pendingStarMarks.delete(article.id);
    listError.value = `保存できませんでした（${e.message}）。`;
    return;
  }
  try {
    await setStar(session.value.token, article.id, next.starred);
  } catch (e) {
    if (expireIfUnauthorized(e)) return;
    // サーバーへ届かなかったので、画面・ローカルとも元へ戻す。
    pendingStarMarks.delete(article.id);
    state.value = {
      ...state.value,
      articles: patchArticle(state.value.articles, article.id, prev),
    };
    try {
      await setLocalArticleStar(article.id, prev.starred, prev.starState);
    } catch {
      // ローカルへ戻せなくても、次回のスター同期でサーバーの
      // 状態 (＝元の状態) に揃い直す。
    }
    listError.value = `スターを保存できませんでした（${e.message}）。`;
  }
}

// 「すべて既読」の確認表示。誤タップで大量に既読化しないよう、
// 対象が多いときだけ実行前に下部バー内で確認を取る (フィード削除や
// 共有リンク発行と同じインライン確認の流儀)。件数が少ないときに
// 毎回確認が出ると煩わしいため、しきい値未満は即座に実行する。
// スコープが変わったら確認は畳む (別の範囲への確認を持ち越さない)。
const MARK_ALL_CONFIRM_THRESHOLD = 100;
const markAllConfirm = ref(false);

function askMarkAllRead() {
  if (!isOwner.value) return;
  if (scopedUnreadCount.value === 0) return;
  if (scopedUnreadCount.value < MARK_ALL_CONFIRM_THRESHOLD) {
    onMarkAllRead();
    return;
  }
  markAllConfirm.value = true;
}

function cancelMarkAllRead() {
  markAllConfirm.value = false;
}

watch(
  () => [state.value.feedId, state.value.category, state.value.filter],
  () => { markAllConfirm.value = false; }
);

async function onMarkAllRead() {
  if (!isOwner.value) return;
  markAllConfirm.value = false;
  // v1 と同じ範囲 (フィード指定が優先、次にカテゴリ、無ければ全体)。
  const targetIds = markAllReadTargets(state.value, state.value.feedId, state.value.category)
    .map((a) => a.id);
  // 未読のみ表示では、すべて既読でもカードはその場で消さずに残す
  // (applyRead と同じ保持集合へ対象をまとめて入れる)。
  if (state.value.filter === 'unread') keepStickyReadIds(targetIds);
  // 実行中の背景更新の読み直しに巻き戻されないよう、先に控える
  // (reloadLocal が読み直した一覧へ重ね直す)。
  targetIds.forEach((id) => { pendingReadMarks.set(id, true); });
  state.value = markAllReadInList(state.value, state.value.feedId, state.value.category);
  try {
    await markLocalArticlesRead(targetIds, new Date().toISOString());
  } catch (e) {
    // 書けなかった変更は控えからも落とす (applyRead と同じ)。
    targetIds.forEach((id) => { pendingReadMarks.delete(id); });
    listError.value = `保存できませんでした（${e.message}）。`;
  }
}

/* ---- 視聴ログ (サーバーへ送る計測) ---- */

// イベントはメモリ上のキューに貯め、操作の区切り (フィード切替・
// 記事オープン・スクロール・要約展開・再生停止・pagehide) で
// まとめて送る。再生中の通信は増やさない。読み取り専用 (共有リンク)
// では送らない (サーバー側でも forbidden)。
const eventQueue = createEventQueue({
  send: (events) => logEvents(session.value.token, events),
  enabled: () => !!session.value && isOwner.value,
});

function queueEvent(event) {
  if (!session.value || !isOwner.value) return;
  eventQueue.push(event);
}

function flushEventLog() {
  // 裏で送るだけなので結果は待たない (失敗しても操作は止めない)。
  eventQueue.flush();
}

function feedTitleOf(feedId) {
  const feed = state.value.feeds.find((f) => f.id === feedId);
  return feed ? feed.title || '' : '';
}

// 視聴ログ: フィードを開いてタイムラインをスクロールしたら、その
// 訪問につき1回だけ scroll を送る (クリックより弱い関心の記録)。
// 選択変更に伴う先頭へのスクロール (scrollToTop) は scrollY が 0 へ
// 戻る動きなので数えず、実際に下へ読み進めた (scrollY > 0) ときだけ
// 送る。帰属は feed_view と同じ (特定フィード選択中のみ)。
function onTimelineScroll() {
  if (view.value !== 'timeline') return;
  const feedId = state.value.feedId;
  if (!feedId || scrollLoggedFeedId === feedId) return;
  if (window.scrollY <= 0) return;
  scrollLoggedFeedId = feedId;
  queueEvent({
    type: 'scroll',
    feed_id: feedId,
    feed_title: feedTitleOf(feedId),
    article_id: '',
    article_title: '',
  });
  flushEventLog();
}

window.addEventListener('scroll', onTimelineScroll, { passive: true });
onUnmounted(() => window.removeEventListener('scroll', onTimelineScroll));

// 再生時間の積算 (play/pause の区間で実再生時間を測る)。
const listenTracker = createListenTracker();

// 再生が止まった区切りで、積算した再生時間を play イベントとして
// キューへ入れ、まとめて送る。
function flushPlayListen() {
  const event = listenTracker.finalize();
  if (event) queueEvent(event);
  flushEventLog();
}

/* ---- ポッドキャスト再生 (端末ローカルのみ) ---- */

// アプリ全体で1つの Audio 要素を共有する。見た目は blog の
// プレイヤー (.music-player) の部品に揃える (style.css の player-* )。
const audio = new Audio();
audio.preload = 'metadata';
const currentEpisode = ref(null);
const isPlaying = ref(false);
// 音声データ待ち (初回再生前・シーク中) の読み込み表示。
const isLoading = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const speed = ref(1);
const seeking = ref(false);
// 再生モード (blog のプレイヤーと同じ: ランダムのトグルと
// リピートの循環)。端末に保存して再訪時も引き継ぐ。
const initialPlayMode = loadPlayMode();
const shuffleOn = ref(initialPlayMode.shuffle);
const repeatMode = ref(initialPlayMode.repeat);
const repeatLabel = computed(() => REPEAT_LABELS[repeatMode.value]);
const shuffleLabel = computed(() => (shuffleOn.value ? 'ランダム：オン' : 'ランダム：オフ'));
// 再生開始時点のキューのスナップショット (記事オブジェクトの配列)。
// 再生中に既読化などで表示リストが変わっても並びは変えない。
const playQueue = ref([]);
// このラウンドで再生を始めた記事ID (ランダム再生の未再生判定用)。
let playedInRound = new Set();
// 再生した順の記事ID列 (ランダム時の「前へ」でさかのぼるため、
// blog の musicPlayer の history と同じく上限100件で保持する)。
let playHistory = [];
// 再生位置のメモリ上の控え (DB 読み直しを待たずに再開するため)。
const playPosMemory = new Map();
let pendingSeek = 0;
let lastPosSaveAt = 0;
// stale なエピソードのタップで、そのフィードだけを取り直している
// 間の目印 (記事IDの集合)。取り直し中のボタンは読み込み表示にする。
const audioRefreshingIds = ref(new Set());
// 再生中の要素に載っているURLが「保持していた古いURL (stale)」かと、
// そのURL自体。要素の error がこのURLに対して起きたときだけ、失効と
// みなして取り消すために控える (src 差し替え時の遅れて来る error や、
// 新鮮なURLの一時的なエラーでは取り消さない)。
let currentSrcStale = false;
let currentSrcUrl = '';

/* ---- 再生できないエピソードの自動スキップ ----
   error イベント・play() の拒否・再生中のストールを検知したら、
   止まったままにせずキューの次へ進む (player.js の
   failedEpisodePlan が送り先を決める)。連続失敗が続く場合は
   上限で止める。1曲でも正常に再生が進んだら数え直す。 */
let consecutivePlayFailures = 0;
// アプリ側に「再生する意思」があるか。本人が一時停止・停止した
// ときだけ下ろし、要素の 'pause' イベントでは下ろさない (曲の
// 終端でも要素は止まるため)。フォアグラウンド復帰時の回復
// (recoverPlaybackOnForeground) が、勝手に再開してよいかの
// 判定に使う。
let playWanted = false;
// エピソードを要素へ載せるたびに増える番号と、失敗処理済みの
// 番号。同じ読み込みへの二重の失敗通知 (error と play() 拒否の
// 両方が来る等) で二重に送らないために使う。
let episodeLoadSeq = 0;
let failureHandledForSeq = -1;
// このエピソードで実際に再生が始まったか ('playing' が来たか)。
// 初回読み込み中はストール検知の対象にしないために使う。
let episodePlayStarted = false;
const stallTracker = createStallTracker();

/* ---- YouTube 音声の長さ二重化の補正 (player.js の純粋関数を使う) ----
   currentTime / duration は Audio 要素のスケールのまま保持し、表示と
   保存 (play_pos) は正しい長さ (durationSec) 基準へ変換して扱う。
   要素の currentTime の進み方 (モデル) は再生中に実測し、端末に
   保存した前回分を既定にする。補正が効かない通常のポッドキャスト
   では変換は恒等になり、従来どおりの動きになる。 */
const learnedTimeModel = ref(loadTimeModel());
let measuredModel = null;
let rateSample = null;
let endFlowDone = false;

const trueDuration = computed(() => {
  const sec = currentEpisode.value?.durationSec;
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
});
const mappingCtx = computed(() => ({
  trueSec: trueDuration.value,
  elementDuration: duration.value,
  model: measuredModel || learnedTimeModel.value,
}));
const mappingOn = computed(() => durationMismatch(trueDuration.value, duration.value)
  && (mappingCtx.value.model === 'direct' || mappingCtx.value.model === 'scaled'));

const displayDuration = computed(() => {
  // 正しい長さが分かっていて要素の報告とずれているなら、モデルの
  // 実測を待たずに合計時間だけは最初から正しい長さを表示する。
  // 位置とシークの変換は従来どおり、モデルが決まるまでは要素
  // スケールのまま (mappingOn / mappingCtx が担う)。
  if (durationMismatch(trueDuration.value, duration.value)) return trueDuration.value;
  if (Number.isFinite(duration.value) && duration.value > 0) return duration.value;
  return currentEpisode.value?.durationSec || 0;
});
const displayTime = computed(() => toDisplayPosition(currentTime.value, mappingCtx.value));
const seekStyle = computed(() => {
  const pct = Math.round(progressRatio(displayTime.value, displayDuration.value) * 1000) / 10;
  return { background: `linear-gradient(to right, var(--primary) ${pct}%, var(--border) ${pct}%)` };
});

// 再生中の要素の進みを実時間と比べてモデルを実測する。シークや
// 一時停止を挟んだ窓は捨てる。既定 (保存済み) と違う結果が出たら
// そちらへ乗り換えて保存し直す。
function samplePlaybackRate() {
  if (!currentEpisode.value || audio.paused || seeking.value) { rateSample = null; return; }
  if (!durationMismatch(trueDuration.value, audio.duration)) { rateSample = null; return; }
  const now = performance.now();
  if (!rateSample) {
    rateSample = { ct: audio.currentTime || 0, wall: now };
    return;
  }
  const dWall = (now - rateSample.wall) / 1000;
  if (dWall < 3) return;
  const dCt = (audio.currentTime || 0) - rateSample.ct;
  rateSample = null;
  if (dCt < 0) return;
  const model = classifyRate(dCt / (dWall * (audio.playbackRate || 1)));
  if (model) {
    // 分類が完了したら、結果が現在のモデルと同じでも実測済みと
    // して記録する。learned が既に正しい曲では乗り換えが起きず、
    // 乗り換えの条件の中でだけ記録すると measuredModel が null
    // のままになり、到達判定のゲート (この曲で実測したモデルが
    // あること) が永久に開かなかった。learned の保存・乗り換え
    // は従来どおり、モデルが変わったときだけ行う。
    const changed = model !== mappingCtx.value.model;
    measuredModel = model;
    if (changed) {
      learnedTimeModel.value = model;
      saveTimeModel(model);
    }
  }
}
/* ---- 終端の検出 ----
   終端の検出は2経路だけ:
     1. 要素の 'ended' イベント (通常ファイルの正規の経路)。
     2. 既知の長さ (durationSec) への到達判定 (player.js の
        reachedKnownDurationEnd)。iOS 上の googlevideo 由来
        fMP4 では終端で 'ended' が来ないことがあるため、
        durationSec が判明している曲ではこちらで進める。
        durationSec が無い曲は 1 だけに頼る (通常の MP3
        ポッドキャストでは 'ended' が正しく来ることを実機で
        確認済み)。
   到達判定は timeupdate からも呼ぶが、終端では timeupdate
   自体が止まることがあるため、再生中はタイマーでも定期的に
   呼ぶ。さらに、要素が終端で 'ended' を出さずに無言で止まった
   場合は、その 'pause' イベントからも呼ぶ (その場面では
   timeupdate もタイマーも来ないことがあるため)。再生開始は
   すべて tryPlayAudio に集約されているので、そこでタイマーを
   始め、stopPlayer と終了フローで確実に止める。 */
let endCheckTimer = null;

// 到達判定の許容 (真の長さの手前をどこまで到達とみなすか)。
// YouTube 曲は中継経由の fMP4 で終端検出の窓が狭いため専用の
// リード (YOUTUBE_END_LEAD_SEC = 約2.5秒) を使い、それ以外は
// 従来の許容 (KNOWN_DURATION_END_TOLERANCE_SEC = 0.6秒)。
function currentEndToleranceSec() {
  const ep = currentEpisode.value;
  return ep && isYouTubeArticle(ep) ? YOUTUBE_END_LEAD_SEC : KNOWN_DURATION_END_TOLERANCE_SEC;
}

// 既知の長さへの到達判定。timeupdate とタイマーの tick と
// 'pause' イベントの3経路から呼ばれる。位置は要素の現在値
// から変換して求める (終端で timeupdate が止まると、
// currentTime ref は最後のイベントの値のままになり、要素側
// だけが終端まで進んでいることがあるため)。到達していれば
// 即座に終了フローへ進むので、tick (0.5秒間隔) 経由でも
// 到達から1秒以内に遷移する。
// 入口の条件は「再生の意思 (playWanted) があること」で見る。
// 要素の 'pause' で駆動される isPlaying を条件にしていた頃は、
// 要素が終端で 'ended' を出さず 'pause' だけ出すと、その
// 'pause' で isPlaying が下りて判定自体が無効化され、意図
// (要素が無言で止まっても到達を判定する) と実装が食い違って
// いた。本人が一時停止した場合は playWanted が下りている
// ので、そちらでは発火しない。
function checkKnownDurationEnd() {
  if (!currentEpisode.value || !playWanted || endFlowDone) return false;
  const pos = toDisplayPosition(audio.currentTime || 0, mappingCtx.value);
  if (!reachedKnownDurationEnd({
    displayPos: pos,
    trueSec: trueDuration.value,
    elementDuration: duration.value,
    hasMeasuredModel: !!measuredModel,
    toleranceSec: currentEndToleranceSec(),
  })) return false;
  handleEpisodeEnded();
  return true;
}

// ストール検知: 再生意思がある (再生中で、一時停止・シーク中・
// 初回読み込み中ではない) のに、表示位置が一定時間進まない
// 状態を、終端チェックと同じタイマーの tick から見る。判定は
// 表示位置の差で行うため、バックグラウンドでタイマーが間引か
// れても、再生できていれば位置が進んでいて誤判定しない。
function checkPlaybackStall() {
  if (!currentEpisode.value || !isPlaying.value || seeking.value || !episodePlayStarted) return false;
  const pos = toDisplayPosition(audio.currentTime || 0, mappingCtx.value);
  const { progressed, stalled } = stallTracker.observe(pos, performance.now());
  if (progressed) {
    // 1曲でも正常に再生が進んだら、連続失敗は数え直す。
    consecutivePlayFailures = 0;
    return false;
  }
  if (!stalled) return false;
  stallTracker.reset(performance.now());
  handlePlaybackFailure();
  return true;
}

// タイマーの tick では、終端の到達判定とストール検知の両方を
// 見に行く (どちらも timeupdate が止まった状況でこそ要る)。
function playerTimerTick() {
  checkKnownDurationEnd();
  checkPlaybackStall();
}

function startEndCheckTimer() {
  stopEndCheckTimer();
  endCheckTimer = setInterval(playerTimerTick, END_CHECK_INTERVAL_MS);
}

function stopEndCheckTimer() {
  if (endCheckTimer !== null) {
    clearInterval(endCheckTimer);
    endCheckTimer = null;
  }
}

/* ---- 次の曲の先読み ----
   切り替え時点で初めて読み込みが始まると、回線が遅いときに遷移で
   長く待たされる。再生中の曲の残りが PRELOAD_REMAINING_SEC
   (60秒) 以下になったら、2つ目の要素で
   次の曲の読み込みを温めておく (本体は切り替え時に同じ URL を
   引くので、キャッシュが効いて開始が速くなる)。先読み要素の
   エラーは無視し、本体には波及させない。遷移・停止・エピソード
   変更では loadEpisode / stopPlayer が必ず破棄する。 */
let preloadAudio = null;
let preloadId = null;

// 次に再生することが事前に確定している記事 (無ければ null)。
// 次曲の決定は本体の自動送り (nextEpisodePlan) と同じにするが、
// ランダムは次が遷移時の抽選で決まるため対象外とし、単曲
// リピートは次も同じ曲なので対象外とする。
function preloadTarget() {
  if (!currentEpisode.value || shuffleOn.value || repeatMode.value === 'one') return null;
  const plan = nextEpisodePlan({
    queue: playQueue.value.map((a) => a.id),
    currentId: currentEpisode.value.id,
    repeat: repeatMode.value,
    shuffle: false,
    playedIds: playedInRound,
  });
  if (plan.type !== 'advance') return null;
  const next = playQueue.value.find((a) => a.id === plan.id);
  if (!next || next.id === currentEpisode.value.id || !next.audioUrl) return null;
  return next;
}

function discardPreload() {
  if (!preloadAudio) return;
  preloadAudio.removeAttribute('src');
  preloadAudio.load();
  preloadAudio = null;
  preloadId = null;
}

// timeupdate から呼ばれる。対象が変わっていたら張り替え、対象が
// 無くなったら破棄する。残りが多い間は読み込みを始めない。
function updatePreload() {
  const target = preloadTarget();
  if (!target) {
    discardPreload();
    return;
  }
  if (preloadAudio && preloadId !== target.id) discardPreload();
  if (preloadAudio) return;
  const remaining = displayDuration.value - displayTime.value;
  if (!Number.isFinite(remaining) || remaining > PRELOAD_REMAINING_SEC) return;
  preloadAudio = new Audio();
  preloadAudio.preload = 'auto';
  preloadId = target.id;
  preloadAudio.src = target.audioUrl;
}

const speedLabel = computed(() => `${speed.value}×`);

function isCurrentEpisode(article) {
  return !!currentEpisode.value && currentEpisode.value.id === article.id;
}

function tryPlayAudio() {
  // 再生の意思を立てる (フォアグラウンド復帰時の回復判定用)。
  playWanted = true;
  // 再生開始のたびに終端チェックのタイマーを張り直す
  // (loadEpisode・再開・単曲リピート・Media Session のいずれの
  // 経路でもここを通る)。
  startEndCheckTimer();
  // 新しい再生の試行では、失敗処理済みの印を解く (同じ読み込み
  // への二重通知の抑止は handlePlaybackFailure 側が担う)。
  failureHandledForSeq = -1;
  const epId = currentEpisode.value ? currentEpisode.value.id : null;
  try {
    const attempt = audio.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch((err) => {
        // pause() や src の差し替えで中断されただけの拒否は、
        // そのエピソードの失敗ではない。
        if (err && err.name === 'AbortError') return;
        // 再生がブロックされただけの拒否 (バックグラウンドでの
        // 自動送り等) も、そのエピソードが壊れているわけでは
        // ない。失敗として送らず、再生の意思だけ残しておく
        // (フォアグラウンド復帰時の回復で再生し直す)。
        if (err && err.name === 'NotAllowedError') return;
        // 既に別のエピソードへ切り替わっていたら、今の曲の
        // 失敗として扱わない。
        if (!currentEpisode.value || currentEpisode.value.id !== epId) return;
        handlePlaybackFailure();
      });
    }
  } catch {
    // 再生できなかった場合はボタンから押し直してもらう。
  }
}

function savePlayPos() {
  const ep = currentEpisode.value;
  if (!ep) return;
  // 再生し終えた要素の現在位置は「終わり」そのもので再開位置ではない。
  // 終了直後の自動送り (loadEpisode 内の保存) で、クリア済みの位置を
  // 末尾で上書きしてしまわないよう、ここで 0 に倒す。'ended' イベント
  // 経由でない終了 (表示位置ベースの判定経由) では audio.ended が
  // 立たないため、終了フロー済みかどうかでも判定する。
  if (audio.ended || endFlowDone) {
    playPosMemory.set(ep.id, 0);
    return;
  }
  // 再開位置は正しい長さ基準 (表示スケール) で保存する。
  const pos = Math.floor(toDisplayPosition(audio.currentTime || 0, mappingCtx.value));
  // 終端間際 (残り5秒以内) の位置は再開位置として保存しない。開始
  // 直後に終了判定へ入る毒になるため、DB 側も 0 に倒しておく。
  // 冒頭 (5秒以下) の位置も同じ扱いにする: 数秒だけ再生して止めた
  // 位置が残ると、次に始めたとき冒頭が飛んだように見えるため。
  if (isWithinEndGuard(pos, displayDuration.value) || isWithinStartGuard(pos)) {
    playPosMemory.set(ep.id, 0);
    clearLocalArticlePlayPos(ep.id).catch(() => {});
    return;
  }
  playPosMemory.set(ep.id, pos);
  if (pos > 0) setLocalArticlePlayPos(ep.id, pos).catch(() => {});
}

function clearPlayPos(id) {
  playPosMemory.set(id, 0);
  clearLocalArticlePlayPos(id).catch(() => {});
}

function updateMediaSession(article) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: article.title,
      artist: article.feedTitle || article.feedId || '',
    });
    navigator.mediaSession.setActionHandler('play', () => tryPlayAudio());
    navigator.mediaSession.setActionHandler('pause', () => {
      // ロック画面等からの明示的な一時停止は、本人の意思として
      // 扱う (フォアグラウンド復帰時に勝手に再開しない)。
      playWanted = false;
      audio.pause();
    });
    navigator.mediaSession.setActionHandler('seekbackward', () => skipBy(-15));
    navigator.mediaSession.setActionHandler('seekforward', () => skipBy(30));
    navigator.mediaSession.setActionHandler('previoustrack', () => skipByTrack(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => skipByTrack(1));
  } catch {
    // Media Session が使えない環境では何もしない。
  }
}

// エピソードを Audio 要素へ載せて再生する共通処理。キューは触らない。
// resume は「本人がそのエピソードを選んだ開始か」の区別: カードから
// 直接選んだときだけ保存済みの再開位置 (play_pos) を復元し、自動
// 送り・前へ／次への切り替わりでは保存位置を使わず 0 から始める。
// 切り替わりでも復元していた頃は、数秒だけ再生して止めたエピソード
// に残った位置が次の曲の冒頭を飛ばして見えた (実機で 0:03 から
// 始まる例を確認)。
function loadEpisode(article, { resume = true } = {}) {
  discardPreload();
  savePlayPos();
  // 渡された記事は描画時点 (またはキュー固定時点) の控えで、その後の
  // 更新で durationSec / audioUrl が埋まっても古いままのことがある。
  // 開始時に状態側の最新を id で引き直し、見つからなければ渡された
  // ものをそのまま使う。
  const ep = state.value.articles.find((a) => a.id === article.id) || article;
  // 視聴ログ: 前のエピソードの再生時間を確定してから、計測対象を
  // 新しいエピソードへ差し替える。
  flushPlayListen();
  listenTracker.setContext({
    id: ep.id,
    feedId: ep.feedId,
    feedTitle: ep.feedTitle || feedTitleOf(ep.feedId),
    title: ep.title || '',
  });
  currentEpisode.value = ep;
  currentSrcStale = !!ep.audioStale;
  currentSrcUrl = ep.audioUrl || '';
  // 読み込みの世代を進め、ストール計測と「再生が始まったか」を
  // このエピソード用にやり直す (切り替わり直後の猶予になる)。
  episodeLoadSeq += 1;
  episodePlayStarted = false;
  stallTracker.reset(performance.now());
  // 再生した順を覚える (ランダム時の「前へ」用。blog の startTrack
  // の履歴記録と同じ位置づけで、自動送りもここを通る)。
  playHistory.push(ep.id);
  if (playHistory.length > 100) playHistory.shift();
  duration.value = 0;
  currentTime.value = 0;
  measuredModel = null;
  rateSample = null;
  endFlowDone = false;
  isLoading.value = true;
  pendingSeek = resume
    ? (playPosMemory.has(ep.id) ? playPosMemory.get(ep.id) : (ep.playPos || 0))
    : 0;
  audio.src = ep.audioUrl;
  audio.playbackRate = speed.value;
  updateMediaSession(ep);
  tryPlayAudio();
}

// ユーザーがカードから選んだとき: その時点の表示リスト (ジャンル・
// チャンネル・既読状態の絞り込み適用後) の再生可能な記事をキュー
// として固定し、ラウンドを数え直してから再生する。再生ボタンと
// 同じ条件 (canPlay) で選ぶため、スターを外した YouTube 記事は
// 音声URLが残っていてもキューに入らない。以後の自動送りは
// このキューに対して行う。
function startEpisode(article) {
  playQueue.value = buildQueue(visible.value.filter((a) => canPlay(a)), article);
  playedInRound = new Set([article.id]);
  playHistory = [];
  // 本人が選び直した開始では、連続失敗を数え直す。
  consecutivePlayFailures = 0;
  loadEpisode(article);
}

// 自動送りの計画 (nextEpisodePlan / failedEpisodePlan) どおりに
// 次のエピソードへ移る。計画が「次へ」でない・遷移先がキューに
// 無ければ false を返す。遷移先の保存位置は使わず頭から始める
// (自動送り・失敗時の送りに共通の規則)。
function loadPlannedNext(plan) {
  if (!plan || plan.type !== 'advance') return false;
  const next = playQueue.value.find((a) => a.id === plan.id);
  if (!next) return false;
  if (plan.resetPlayed) playedInRound = new Set();
  playedInRound.add(next.id);
  loadEpisode(next, { resume: false });
  return true;
}

function toggleShuffle() {
  shuffleOn.value = !shuffleOn.value;
  savePlayMode({ shuffle: shuffleOn.value, repeat: repeatMode.value });
  // blog と同じく、切り替えたら再生中の曲からラウンドを数え直す。
  playedInRound = new Set(currentEpisode.value ? [currentEpisode.value.id] : []);
}

function cycleRepeat() {
  repeatMode.value = nextRepeat(repeatMode.value);
  savePlayMode({ shuffle: shuffleOn.value, repeat: repeatMode.value });
}

function togglePlay() {
  if (!currentEpisode.value) return;
  if (audio.paused) {
    if (audio.ended) {
      audio.currentTime = 0;
    }
    // 終わった曲を手で再生し直したら、終了フロー済みの扱いを解く
    // (savePlayPos の抑制と終了判定が再び効くようにするため)。
    endFlowDone = false;
    tryPlayAudio();
  } else {
    playWanted = false;
    audio.pause();
  }
}

async function toggleEpisode(article) {
  if (isCurrentEpisode(article)) {
    togglePlay();
    return;
  }
  if (article.audioStale) {
    await startStaleEpisode(article);
    return;
  }
  startEpisode(article);
}

// stale なエピソード (印つき) を選んだとき: まずそのフィードだけを
// 取り直してレコードを更新する。新鮮な enclosure が来ていればその
// URLで再生し、来ていなければ保持しているURL (6時間以内) で再生を
// 試みる。取り直し自体に失敗しても、保持URLでの試行は行う。
// 取り直しの結果URLが消えた (6時間を過ぎた) 場合は再生しない
// (読み直しでボタンも消える)。
async function startStaleEpisode(article) {
  if (audioRefreshingIds.value.has(article.id)) return;
  audioRefreshingIds.value = new Set(audioRefreshingIds.value).add(article.id);
  try {
    const feed = state.value.feeds.find((f) => f.id === article.feedId);
    if (feed) {
      const result = await fetchOneFeed(feed);
      if (result.ok) {
        await ingestFeedArticles(result.feed, result.entries, new Date().toISOString(), null);
        await reloadLocal();
      }
    }
  } catch {
    // 取り直せなくても保持URLで試すため、ここでは何もしない。
  } finally {
    const next = new Set(audioRefreshingIds.value);
    next.delete(article.id);
    audioRefreshingIds.value = next;
  }
  const fresh = state.value.articles.find((a) => a.id === article.id) || article;
  if (fresh.audioUrl) startEpisode(fresh);
}

// カードの再生ボタンの aria-label。取り直し中・読み込み中・再生中
// の状態に、stale (古いURLを保持中) の断りを優先度順に付け分ける。
function playButtonLabel(a) {
  if (audioRefreshingIds.value.has(a.id)) return '音声URLを取り直しています';
  if (isCurrentEpisode(a) && isLoading.value) return '読み込み中';
  if (isCurrentEpisode(a) && isPlaying.value) return '一時停止';
  if (a.audioStale) return '再生（音声URLが古くなっています。押すと取り直します）';
  return '再生';
}

// 前へ／次へ: 現在の再生キュー内での移動。遷移先の決定は blog の
// musicPlayer と同じ規則 (player.js の skipPlan)。reader は
// loadEpisode が常に再生を始める設計 (自動送りと同じ) なので、
// 遷移後はそのまま再生する。
function skipByTrack(delta) {
  if (!currentEpisode.value) return;
  const plan = skipPlan({
    queue: playQueue.value.map((a) => a.id),
    currentId: currentEpisode.value.id,
    delta,
    shuffle: shuffleOn.value,
    history: playHistory,
  });
  if (!plan) return;
  const target = playQueue.value.find((a) => a.id === plan.id);
  if (!target) return;
  if (plan.historyCut != null) playHistory = playHistory.slice(0, plan.historyCut);
  playedInRound.add(target.id);
  // 本人の操作で移ったときは、連続失敗を数え直す。
  consecutivePlayFailures = 0;
  // 前へ／次へは切り替わりなので、遷移先の保存位置は使わず頭から。
  loadEpisode(target, { resume: false });
}

function skipBy(delta) {
  if (!currentEpisode.value) return;
  if (mappingOn.value) {
    // スキップ量は表示 (正しい長さ) 基準で解釈し、要素へ戻して渡す。
    const target = clampSeek(displayTime.value + delta, displayDuration.value);
    audio.currentTime = toElementPosition(target, mappingCtx.value);
    currentTime.value = audio.currentTime;
    rateSample = null;
    return;
  }
  audio.currentTime = clampSeek((audio.currentTime || 0) + delta, audio.duration);
  currentTime.value = audio.currentTime;
}

function cycleSpeed() {
  speed.value = nextSpeed(speed.value);
  audio.playbackRate = speed.value;
}

function onSeekInput(event) {
  const value = Number(event.target.value);
  if (mappingOn.value) {
    // バーの値は表示スケール。要素のスケールへ変換してから渡す。
    audio.currentTime = toElementPosition(value, mappingCtx.value);
    currentTime.value = audio.currentTime;
    rateSample = null;
    return;
  }
  currentTime.value = value;
  audio.currentTime = clampSeek(value, Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : displayDuration.value);
}

function stopPlayer() {
  playWanted = false;
  savePlayPos();
  // 視聴ログ: プレイヤーを閉じるのが再生の終わりなので、積算した
  // 再生時間をここで確定して送る。
  flushPlayListen();
  listenTracker.clear();
  stopEndCheckTimer();
  discardPreload();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  currentEpisode.value = null;
  currentSrcStale = false;
  currentSrcUrl = '';
  episodePlayStarted = false;
  playHistory = [];
  isPlaying.value = false;
  isLoading.value = false;
  endFlowDone = false;
  rateSample = null;
  currentTime.value = 0;
  duration.value = 0;
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = null;
    } catch {
      // 何もしない。
    }
  }
}

audio.addEventListener('loadedmetadata', () => {
  duration.value = audio.duration;
  audio.playbackRate = speed.value;
  if (pendingSeek > 0) {
    // 保存値は正しい長さ基準。旧バージョンが要素スケールで保存した
    // 値は interpretStoredPlayPos で割り戻してから要素へ渡す。
    const ctx = mappingCtx.value;
    const restored = interpretStoredPlayPos(pendingSeek, ctx);
    audio.currentTime = clampSeek(toElementPosition(restored, ctx), audio.duration);
    currentTime.value = audio.currentTime;
  }
  pendingSeek = 0;
});
audio.addEventListener('timeupdate', () => {
  if (!seeking.value) currentTime.value = audio.currentTime || 0;
  samplePlaybackRate();
  updatePreload();
  if (Date.now() - lastPosSaveAt > 10_000) {
    lastPosSaveAt = Date.now();
    savePlayPos();
  }
  // 既知の長さ (durationSec) が判明している曲では、表示位置が
  // その長さに達した時点で終了フローへ進める ('ended' と二重に
  // は走らない)。iOS では fMP4 の終端で要素が止まって 'ended'
  // が来ないことがあり、要素 duration と一致する通常の曲でも
  // これが唯一の到達判定になる。要素 duration とずれている曲
  // では、モデル変換の誤りで早期終了しないよう、この曲で実測
  // したモデルがある場合に限る (端末保存の learned の流用だけ
  // では有効にしない。reachedKnownDurationEnd 側で判定)。
  checkKnownDurationEnd();
});
audio.addEventListener('play', () => {
  isPlaying.value = true;
  // 視聴ログ: 再生区間を開く。
  listenTracker.start();
  // 再開のたびにストール計測をやり直す (一時停止を挟んだ窓で
  // 誤判定しないため)。
  stallTracker.reset(performance.now());
});
audio.addEventListener('pause', () => {
  isPlaying.value = false;
  // 視聴ログ: 再生区間を閉じる (積算の確定は停止の区切りで行う)。
  listenTracker.pause();
  savePlayPos();
  // 要素が終端で 'ended' を出さずに止まった場合は、この
  // 'pause' が最後の検出機会になる。位置が既知の終端近傍に
  // あり、再生の意思が残っているときだけ終了フローへ進む
  // (条件の判定は checkKnownDurationEnd 側)。本人の一時停止
  // (プレイヤーのボタン・Media Session) は、先に playWanted
  // を下ろしてから要素を止めるため、ここでは発火しない。
  checkKnownDurationEnd();
});
// 読み込み表示: データ待ちの間だけ出し、再生可能になったら消す。
audio.addEventListener('waiting', () => { isLoading.value = true; });
audio.addEventListener('seeking', () => {
  rateSample = null;
  if (audio.readyState < 3) isLoading.value = true;
});
audio.addEventListener('seeked', () => {
  if (audio.readyState >= 3) isLoading.value = false;
  // シーク直後はストール計測をやり直す (猶予を持たせる)。
  stallTracker.reset(performance.now());
});
audio.addEventListener('playing', () => {
  isLoading.value = false;
  // 実際に再生が始まったので、ここからストール検知の対象になる。
  episodePlayStarted = true;
});
audio.addEventListener('canplay', () => { isLoading.value = false; });
audio.addEventListener('error', () => {
  isLoading.value = false;
  // 対象は要素に載っている当のURLへのエラーだけに限る
  // (src の差し替え・破棄に伴う遅れて来る error は失敗として
  // 扱わない)。実際の処理は共通の失敗処理へ集約する。
  if (!currentEpisode.value || !currentSrcUrl || audio.src !== currentSrcUrl) return;
  handlePlaybackFailure();
});

// 再生に失敗したときの共通処理 (error イベント・play() の拒否・
// ストール検知から呼ばれる)。送り先は player.js の
// failedEpisodePlan が決める (手動の「次へ」と同じ進み方で、
// 単曲リピート中でも壊れたエピソード自体は繰り返さない)。
// 失敗したエピソードは聴き終えたわけではないので、既読には
// しない。次が無い・連続失敗が上限に達した場合は、終端の
// 動作に合わせてその場で停止する。
function handlePlaybackFailure() {
  const ep = currentEpisode.value;
  if (!ep || endFlowDone) return;
  // 同じ読み込みへの二重の失敗通知では、二重に送らない。
  if (failureHandledForSeq === episodeLoadSeq) return;
  failureHandledForSeq = episodeLoadSeq;
  isLoading.value = false;
  // 保持していた古いURL (stale) での失敗は、そのURLが失効して
  // いたとみなして記事の音声を取り消す (PR #63)。対象は要素に
  // 載っている当のURLへの失敗だけに限る。
  const staleDead = currentSrcStale && !!currentSrcUrl && audio.src === currentSrcUrl;
  if (staleDead) {
    currentSrcStale = false;
    currentSrcUrl = '';
    clearLocalArticleAudio(ep.id).catch(() => {});
  }
  consecutivePlayFailures += 1;
  const plan = failedEpisodePlan({
    queue: playQueue.value.map((a) => a.id),
    currentId: ep.id,
    repeat: repeatMode.value,
    shuffle: shuffleOn.value,
    playedIds: playedInRound,
    consecutiveFailures: consecutivePlayFailures,
  });
  if (loadPlannedNext(plan)) {
    if (staleDead) reloadLocal().catch(() => {});
    return;
  }
  if (staleDead) {
    // 次が無い場合の stale の従来動作 (PR #63): 音声を取り消した
    // うえでプレイヤーを閉じる。
    stopPlayer();
    reloadLocal().catch(() => {});
    return;
  }
  // 次が無い・連続失敗の上限: 終端の動作に合わせてその場で止める
  // (エピソードは表示したまま、再生だけ止める)。
  playWanted = false;
  stopEndCheckTimer();
  audio.pause();
  isPlaying.value = false;
}

function handleEpisodeEnded() {
  if (endFlowDone) return;
  endFlowDone = true;
  stopEndCheckTimer();
  isPlaying.value = false;
  isLoading.value = false;
  const ep = currentEpisode.value;
  if (!ep) return;
  // 聴き終えたら既読にする (単曲リピートでも、既読化は冪等なので
  // 毎回通してよい)。視聴ログの article_open は「記事を開いた操作」
  // だけを数えるため、ここでは onOpenArticle を経由せず既読化だけ
  // を行う (play イベントは別に数える)。
  const view = state.value.articles.find((a) => a.id === ep.id) || ep;
  if (isOwner.value && !view.isRead) applyRead(view, true);
  clearPlayPos(ep.id);
  currentTime.value = 0;
  if (repeatMode.value === 'one') {
    // 視聴ログ: 1周分の再生時間を確定する (計測対象は同じ曲のまま
    // 次の周を数え直す)。
    flushPlayListen();
    // 単曲リピート: src は差し替えず先頭から再生し直す。再開位置
    // (pendingSeek は metadata 読み込み時だけ効く) とは競合しない。
    audio.currentTime = 0;
    endFlowDone = false;
    tryPlayAudio();
    return;
  }
  const plan = nextEpisodePlan({
    queue: playQueue.value.map((a) => a.id),
    currentId: ep.id,
    repeat: repeatMode.value,
    shuffle: shuffleOn.value,
    playedIds: playedInRound,
  });
  // 次へ進む場合は loadEpisode 側で再生時間を確定する。進まずに
  // 止まる場合は、ここが再生の終わりなので確定して送る (再生の
  // 意思もここで下ろす。フォアグラウンド復帰時の回復で、末尾で
  // 止まった状態を勝手に再生し直さないため)。
  if (!loadPlannedNext(plan)) {
    playWanted = false;
    flushPlayListen();
  }
}
audio.addEventListener('ended', handleEpisodeEnded);

// フォアグラウンドへ戻ったときの再生回復。バックグラウンドで
// タイマーが止まりページが suspend / freeze されると、その間に
// 曲が終わっても次曲への進行が起きず、自動送りの play() が
// 保留・拒否されたまま固まることがある (実機で「開くと次の曲が
// 始まる」症状を確認)。復帰した時点で、再生の意思があるのに
// 止まっている状態なら、その場で進行・再開する。判定は
// player.js の foregroundRecoveryAction、本人が一時停止した
// 場合は playWanted が下りているので何もしない。
function recoverPlaybackOnForeground() {
  const action = foregroundRecoveryAction({
    hasEpisode: !!currentEpisode.value,
    playWanted,
    ended: audio.ended,
    endFlowDone,
    paused: audio.paused,
    reachedEnd: !!currentEpisode.value && reachedKnownDurationEnd({
      displayPos: toDisplayPosition(audio.currentTime || 0, mappingCtx.value),
      trueSec: trueDuration.value,
      elementDuration: duration.value,
      hasMeasuredModel: !!measuredModel,
      toleranceSec: currentEndToleranceSec(),
    }),
  });
  if (action === 'advance') handleEpisodeEnded();
  else if (action === 'resume') tryPlayAudio();
}

// セッションを破棄してサインイン画面へ戻る共通部分 (失効・ログアウト)。
function detachSession() {
  stopPlayer();
  clearSession();
  session.value = null;
  view.value = 'timeline';
}

// セッション失効時の共通処理。保存分を消してサインイン画面に戻す。
function expireSession() {
  detachSession();
  bootError.value = 'ログインの有効期限が切れました。再度ログインしてください。';
  renderSigninButton();
}

// API エラーがセッション失効なら共通処理へ倒し、倒したら true を返す
// (呼び出し側は false のときだけ自前のエラー表示を行う)。
function expireIfUnauthorized(e) {
  if (e.message !== 'unauthorized') return false;
  expireSession();
  return true;
}

/* ---- フィード管理 (オーナーのみ) ---- */

async function loadFeeds() {
  if (!session.value) return;
  mgmtLoading.value = true;
  try {
    const payload = await listFeeds(session.value.token);
    mgmtFeeds.value = Array.isArray(payload.feeds) ? payload.feeds : [];
    mgmtError.value = '';
  } catch (e) {
    if (!expireIfUnauthorized(e)) mgmtError.value = `フィードを読み込めませんでした（${e.message}）。時間をおいて開き直してください。`;
  } finally {
    mgmtLoading.value = false;
  }
}

/* ---- 共有リンク (マジックリンク、管理画面の最下部) ---- */

async function loadShareStatus() {
  if (!session.value) return;
  shareLoading.value = true;
  try {
    const payload = await getShareLinkStatus(session.value.token);
    shareStatus.value = {
      active: !!payload.active,
      expiresAt: payload.expiresAt || null,
    };
    shareError.value = '';
  } catch (e) {
    if (!expireIfUnauthorized(e)) shareError.value = `共有リンクの状態を取得できませんでした（${e.message}）。`;
  } finally {
    shareLoading.value = false;
  }
}

function askIssueShare() {
  shareConfirm.value = 'issue';
}

function askRevokeShare() {
  shareConfirm.value = 'revoke';
}

function cancelShareConfirm() {
  shareConfirm.value = '';
}

async function onIssueShare() {
  if (shareSaving.value || !session.value) return;
  shareSaving.value = true;
  try {
    const payload = await issueShareLink(session.value.token);
    shareStatus.value = { active: true, expiresAt: payload.expiresAt || null };
    // ベースはアプリの置き場所 (本番 /reader/、ステージングは
    // /reader/staging/)。開く側はハッシュしか見ない。
    shareUrl.value = buildShareUrl(payload.token, {
      origin: window.location.origin,
      base: import.meta.env.BASE_URL,
    });
    shareCopied.value = false;
    shareConfirm.value = '';
    shareError.value = '';
  } catch (e) {
    if (!expireIfUnauthorized(e)) shareError.value = `リンクを発行できませんでした（${e.message}）。`;
  } finally {
    shareSaving.value = false;
  }
}

async function onRevokeShare() {
  if (shareSaving.value || !session.value) return;
  shareSaving.value = true;
  try {
    await revokeShareLink(session.value.token);
    shareStatus.value = { active: false, expiresAt: null };
    shareUrl.value = '';
    shareCopied.value = false;
    shareConfirm.value = '';
    shareError.value = '';
  } catch (e) {
    if (!expireIfUnauthorized(e)) shareError.value = `リンクを無効化できませんでした（${e.message}）。`;
  } finally {
    shareSaving.value = false;
  }
}

/* ---- 今週の視聴 (管理画面の共有リンクの下) ---- */

async function loadStats() {
  if (!session.value) return;
  statsLoading.value = true;
  try {
    const payload = await getStats(session.value.token);
    statsData.value = {
      currentWeek: payload.currentWeek || '',
      current: Array.isArray(payload.current) ? payload.current : [],
    };
    statsError.value = '';
  } catch (e) {
    if (!expireIfUnauthorized(e)) statsError.value = `視聴集計を取得できませんでした（${e.message}）。`;
  } finally {
    statsLoading.value = false;
  }
}

// 今週分のうち再生があったフィードを、再生時間の長い順に最大5件。
const currentWeekListening = computed(() => {
  if (!statsData.value) return [];
  return statsData.value.current
    .filter((s) => (s.plays || 0) > 0)
    .slice()
    .sort((a, b) => (b.seconds || 0) - (a.seconds || 0) || (b.plays || 0) - (a.plays || 0))
    .slice(0, 5);
});

async function copyShareUrl() {
  if (!shareUrl.value) return;
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    shareCopied.value = true;
  } catch {
    // コピーできない環境では、入力欄の URL を手でコピーしてもらう
    // (入力欄はタップで全選択される)。
    shareCopied.value = false;
  }
}

// 管理画面のジャンル絞り込みの切り替え。タイムラインの setCategory と
// 同じトグル方式: 選択中のジャンルを再タップしたら解除し、全件表示に
// 戻す (「すべて」チップは置かない)。
function setAdminCategory(category) {
  adminCategory.value = adminCategory.value === category ? '' : category;
}

function openFeedAdmin() {
  if (!isOwner.value) return;
  view.value = 'feeds';
  formMode.value = '';
  formScroll.clear();
  confirmDeleteId.value = '';
  shareConfirm.value = '';
  loadFeeds();
  loadShareStatus();
  loadStats();
}

async function backToTimeline() {
  view.value = 'timeline';
  formMode.value = '';
  formScroll.clear();
  confirmDeleteId.value = '';
  // 管理で変わったフィード構成をタイムラインへ反映するため、並び替え保存の
  // 完了を待ってから背景更新 (フィード一覧の取り直し＋再取得) を行う。
  await waitReorderSettled();
  // 既に背景更新が実行中だと、新しい取得は始まらず、その更新は管理での
  // 保存より前に取り始めた一覧で共有状態を上書きし直す。保存があった
  // 場合は、その更新の完了後にもう一度更新して最新の一覧で揃え直す。
  const wasInFlight = refreshInFlight !== null;
  const run = refreshInBackground();
  if (adminFeedsDirty) {
    adminFeedsDirty = false;
    if (wasInFlight) run.then(() => refreshInBackground(), () => refreshInBackground());
  }
}

// 管理で保存したフィードのジャンルを、タイムライン側の共有状態
// (メモリ内の state と IndexedDB のフィードキャッシュ) へ即座に
// 反映する。タイムラインのジャンルチップ・絞り込みはこの共有状態
// から作られるが、背景更新が状態を読み直すのは全フィード再取得の
// 完了後で、実行中の更新があると新しい取得自体も始まらないため、
// 保存だけではタイムラインに戻っても古いジャンルのままになる。
// サーバーの一覧が正本なので、次回の背景更新で置き換わる
// (これはそれまでの繋ぎ)。対象は編集 (ID 付きの保存) のみで、
// 追加したフィードは従来どおり次回の背景更新で現れる。
async function reflectSavedFeedToTimeline(payload) {
  const id = payload?.id;
  if (!id) return;
  const category = String(payload.category || '');
  state.value = { ...state.value, feeds: patchFeedCategory(state.value.feeds, id, category) };
  const cached = await loadLocalFeeds();
  if (cached.some((f) => f.id === id)) {
    await saveLocalFeeds(patchFeedCategory(cached, id, category));
  }
}

const orderSender = createOrderSender((ids) => reorderFeeds(session.value.token, ids));
// 進行中の並び替え保存 (最新の submit)。タイムラインへ戻る際はこれの完了を
// 待ってからフィード一覧を取り直す。待たないと、保存前の並びで書かれたシートを
// 読んだ応答が返り、戻った直後のチップ順が古いままになる (競合)。
let lastReorder = null;

async function waitReorderSettled() {
  if (!lastReorder) return;
  try {
    await lastReorder;
  } catch {
    // エラー表示と読み直しは applyFeedOrder 側で行う。
  }
}

// 並び順の確定: 画面へ即座に反映し、保存は orderSender が直列化＋合体
// して送る。失敗したらエラー表示＋一覧を取り直す。
async function applyFeedOrder(next) {
  mgmtFeeds.value = next;
  try {
    lastReorder = orderSender.submit(next.map((f) => f.id));
    await lastReorder;
    mgmtError.value = '';
  } catch (e) {
    if (!expireIfUnauthorized(e)) {
      mgmtError.value = `並び替えを保存できませんでした（${e.message}）。`;
      loadFeeds();
    }
  }
}

/* ---- ドラッグでの並び替え ---- */

// ドラッグ中だけ持つ状態。rects は開始時点の各行の { top, height }
// (文書座標)。from / target は mgmtFeeds のインデックス (ジャンル
// 絞り込み中はドラッグできないため adminFeeds と並びが一致する)。
// dy は指の移動量 (行の範囲内にクランプ済み)、pitch は行の詰め量。
const drag = ref(null);
// ドロップ直後の1フレームだけ transform のアニメーションを止める。
// 並び替えでレイアウト位置が変わるのと同時に transform が外れると、
// 行がずれて見えるため。
const dragSettling = ref(false);

function onDragPointerDown(event, index) {
  if (adminCategory.value) return;
  if (event.button != null && event.button > 0) return;
  const card = event.currentTarget?.closest('article.feed-card');
  if (!card || !card.parentElement) return;
  const cards = [...card.parentElement.querySelectorAll(':scope > article.feed-card')];
  if (cards.length !== mgmtFeeds.value.length) return;
  const rects = cards.map((c) => {
    const r = c.getBoundingClientRect();
    return { top: r.top + window.scrollY, height: r.height };
  });
  drag.value = {
    from: index,
    target: index,
    dy: 0,
    rects,
    pitch: dragRowPitch(rects, index),
    startY: event.clientY + window.scrollY,
  };
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // キャプチャできない環境ではハンドル上での操作として続ける。
  }
  event.preventDefault();
}

function onDragPointerMove(event) {
  const d = drag.value;
  if (!d) return;
  // ビューポートの端では少しスクロールさせ、長い一覧でも端まで
  // 運べるようにする。スクロールで文書座標が変わるため、移動量は
  // スクロール後の座標で計算する。
  if (event.clientY < 72) window.scrollBy(0, -14);
  else if (event.clientY > window.innerHeight - 72) window.scrollBy(0, 14);
  const rawDy = event.clientY + window.scrollY - d.startY;
  const first = d.rects[0];
  const last = d.rects[d.rects.length - 1];
  const minDy = first.top - d.rects[d.from].top;
  const maxDy = last.top + last.height - (d.rects[d.from].top + d.rects[d.from].height);
  d.dy = Math.min(Math.max(rawDy, minDy), maxDy);
  d.target = dragInsertIndex(d.rects, d.from, d.dy);
}

function onDragPointerUp() {
  const d = drag.value;
  if (!d) return;
  drag.value = null;
  if (d.target === d.from) return;
  const next = moveItemToIndex(mgmtFeeds.value, d.from, d.target);
  if (!next) return;
  dragSettling.value = true;
  applyFeedOrder(next);
  nextTick(() => {
    dragSettling.value = false;
  });
}

function onDragPointerCancel() {
  drag.value = null;
}

// ドラッグ中の各行の変位。掴んだ行は指に追随し、挿入先までの間の
// 行は掴んだ行のピッチ分だけ詰めて表示する。
function feedCardDragStyle(index) {
  const d = drag.value;
  if (!d) return undefined;
  if (index === d.from) return { transform: `translateY(${d.dy}px)` };
  if (d.from < index && index <= d.target) return { transform: `translateY(${-d.pitch}px)` };
  if (d.target <= index && index < d.from) return { transform: `translateY(${d.pitch}px)` };
  return undefined;
}

function askDeleteFeed(feed) {
  confirmDeleteId.value = feed.id;
}

function cancelDeleteFeed() {
  confirmDeleteId.value = '';
}

async function onDeleteFeed(feed) {
  if (mgmtSavingId.value) return;
  mgmtSavingId.value = feed.id;
  try {
    await deleteFeed(session.value.token, feed.id);
    // 保存と同じ目印を立てる。削除前に始まった背景更新が実行中に
    // タイムラインへ戻ると、その更新が削除前の一覧で完了して削除した
    // フィードと記事がローカルに残るため、戻る際の追随更新で揃え直す。
    adminFeedsDirty = true;
    mgmtFeeds.value = mgmtFeeds.value.filter((f) => f.id !== feed.id);
    if (formMode.value === 'edit' && formBase.value?.id === feed.id) {
      closeForm();
      restoreFormScroll();
    }
    confirmDeleteId.value = '';
    mgmtError.value = '';
  } catch (e) {
    if (expireIfUnauthorized(e)) {
      // セッション失効は共通処理へ倒した。
    } else if (e.message === 'not_found') {
      // 既に消えていた場合は一覧からも落として整合させる。
      adminFeedsDirty = true;
      mgmtFeeds.value = mgmtFeeds.value.filter((f) => f.id !== feed.id);
      confirmDeleteId.value = '';
      mgmtError.value = 'そのフィードは既に削除されています。';
    } else {
      mgmtError.value = `削除できませんでした（${e.message}）。`;
    }
  } finally {
    mgmtSavingId.value = '';
  }
}

// フォームは一覧より上に開くため、下の方のフィードから開くと画面の外に
// 出てしまい「ボタンを押しても何も起きない」ように見える。開いたら必ず
// フォームが見える位置までスクロールする。
async function revealForm() {
  await nextTick();
  const el = formEl.value;
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function startAddFeed() {
  formScroll.save();
  formMode.value = 'add';
  formBase.value = null;
  form.value = createFeedForm();
  formError.value = '';
  confirmDeleteId.value = '';
  revealForm();
}

function startEditFeed(feed) {
  formScroll.save();
  formMode.value = 'edit';
  formBase.value = feed;
  form.value = feedFormFromFeed(feed);
  formError.value = '';
  confirmDeleteId.value = '';
  revealForm();
}

function closeForm() {
  formMode.value = '';
  formBase.value = null;
  formError.value = '';
}

// 一覧の再描画が終わってから、フォームを開く前のスクロール位置へ戻す。
async function restoreFormScroll() {
  await nextTick();
  formScroll.restore();
}

// キャンセル: フォームを閉じて元の位置へ戻る。
function cancelForm() {
  closeForm();
  restoreFormScroll();
}

// フォームの保存本体 (追加・編集共通)。成功したらフォームを閉じて
// 一覧を取り直す。
async function saveFeedForm(payload) {
  formSaving.value = true;
  let saved = false;
  try {
    await saveFeed(session.value.token, payload);
    adminFeedsDirty = true;
    saved = true;
    closeForm();
    await loadFeeds();
    // 一覧を取り直し終わってから戻す (読み込み中は一覧が隠れて
    // ドキュメントが短いため、先に戻すと位置がずれる)。
    await restoreFormScroll();
  } catch (e) {
    if (e.message === 'invalid') formError.value = e.serverMessage || '入力内容を確認してください。';
    else if (!expireIfUnauthorized(e)) formError.value = `保存できませんでした（${e.message}）。`;
  } finally {
    formSaving.value = false;
  }
  // タイムラインへの反映は、フォームを閉じ一覧を取り直した後に行う
  // (閉じる動作を IndexedDB への書き込み待ちにしないため)。反映は
  // 繋ぎの処理で、失敗しても保存自体は成功している (次回の背景更新で
  // サーバーの一覧に揃う) ため、失敗は握りつぶす。
  if (saved) {
    try {
      await reflectSavedFeedToTimeline(payload);
    } catch {
      // 反映に失敗しても保存は成功しているため何もしない。
    }
  }
}

async function submitFeedForm() {
  if (formSaving.value || formFetching.value) return;
  // 編集はジャンルと有効/無効だけ (ID・タイトル・URL は変更できない)。
  if (formMode.value === 'edit') {
    // 未変更では保存しない (ボタンも非活性だが、入力欄からの
    // Enter 送信でも同じにそろえる)。
    if (!formDirty.value) return;
    await saveFeedForm(buildSaveFeedPayload(form.value, formBase.value));
    return;
  }
  // 追加は URL とジャンルだけ。ID はサーバーが URL から決める。
  const urlInvalid = validateFeedUrl(form.value.url);
  if (urlInvalid) {
    formError.value = urlInvalid;
    return;
  }
  // YouTube (疑似フィード・チャンネルページ・@ハンドル) は直接読めない
  // ため取得を省き、タイトル '' で保存する (URL の正規形への解決と
  // タイトル補完はサーバーが行う)。
  if (planFeedAdd(form.value).mode === 'youtube') {
    await saveFeedForm(buildSaveFeedPayload({ ...form.value, title: '' }));
    return;
  }
  // それ以外は保存前にフィードを取得し、タイトルを自動で決める。
  // 取得できない・タイトルが取れない場合は保存しない。
  formFetching.value = true;
  let resolved;
  try {
    const xml = await fetchFeedXml(String(form.value.url || '').trim());
    resolved = resolveFeedAddForm(form.value, { xml });
  } catch (e) {
    formError.value = `フィードを取得できなかったため登録できませんでした（${e.message}）。`;
    return;
  } finally {
    formFetching.value = false;
  }
  if (!resolved.ok) {
    formError.value = resolved.message;
    return;
  }
  await saveFeedForm(buildSaveFeedPayload(resolved.form));
}

function adoptSession(data) {
  const s = { token: data.sessionToken, role: data.role || 'owner', expiresAt: data.expiresAt || null };
  saveSession(s);
  session.value = s;
}

async function onCredential(response) {
  signingIn.value = true;
  try {
    const data = await exchangeSession(response.credential);
    adoptSession(data);
    state.value = createListState();
    // 状態のリセットで消えた分を、開いた URL の指定から戻す。
    applyRoute(initialRoute);
    await initTimeline();
  } catch (e) {
    // 権限のないアカウントはサーバーが forbidden を返す (他 API と同じ
    // 呼び名)。それ以外は内部の事情を見せず、汎用の文言にする。
    bootError.value = e.message === 'forbidden'
      ? 'このアカウントでは利用できません。'
      : 'ログインに失敗しました。もう一度お試しください。';
    loading.value = false;
  } finally {
    signingIn.value = false;
  }
}

function renderSigninButton() {
  // GIS スクリプトの読み込み完了を待ってから描画する (tweet と同じ load 待ち)。
  const render = () => {
    if (!window.google) {
      // 読み込みが終わっても GIS が無い (広告ブロック等で失敗した) 場合は、
      // ボタンが描画できない理由をサインインボックスに出す。
      googleScriptError.value = true;
      return;
    }
    googleScriptError.value = false;
    if (!signinEl.value) {
      nextTick(render);
      return;
    }
    window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential });
    window.google.accounts.id.renderButton(signinEl.value, {
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'pill',
    });
  };
  if (window.google) render();
  else if (document.readyState === 'complete') render();
  else window.addEventListener('load', render, { once: true });
}

function signOut() {
  detachSession();
  state.value = createListState();
  loading.value = false;
  if (window.google) window.google.accounts.id.disableAutoSelect();
  renderSigninButton();
}

// 一時アクセスリンク (#share=<token>) があれば読み取り専用で入る。
// トークンは交換後すぐに URL から消す (履歴・漏えい防止)。
async function tryShareFromHash() {
  const m = location.hash.match(/#share=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const data = await exchangeShare(m[1]);
    adoptSession(data);
    return true;
  } catch {
    bootError.value = 'この一時アクセスリンクは無効か、期限切れです。発行者に新しいリンクを依頼してください。';
    return false;
  }
}

// ページが破棄・凍結 (bfcache) される前に DB 接続を閉じる。
// 開いたまま凍結されると、次に開いたページの DB 読み込みが
// その接続と競合して固まることがある (再生中に管理画面から
// ヘッダーのタイトルで開き直すと再現した)。
window.addEventListener('pagehide', () => {
  // 視聴ログ: ページを離れる前に、貯まっている分を送る (best effort)。
  // 再生中のまま離れた場合は、ここまでの再生時間も確定する。
  flushPlayListen();
  closeLocalDb();
});

// しばらく離れて戻ってきたら、裏で背景更新する (復帰直後の
// ネットワーク失敗をユーザーの操作ではなく背景更新側で受けるため)。
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    savePlayPos();
    return;
  }
  // バックグラウンドで止まったままの再生があれば、復帰の
  // タイミングで進行・再開する (背景更新の条件とは独立に、
  // 復帰のたびに見る)。
  recoverPlaybackOnForeground();
  if (session.value && view.value === 'timeline' && hiddenAt && Date.now() - hiddenAt > 60_000) {
    hiddenAt = 0;
    refreshInBackground();
  }
});

onMounted(async () => {
  // Web フォントの読み込みで要約の行数が変わるため、確定後に測り直す。
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => scheduleMeasureSummaries());
  }
  if (!API_URL) {
    bootError.value = 'データAPIのURLが未設定です（ビルド時の設定待ち）。';
    loading.value = false;
    booting.value = false;
    return;
  }
  const shared = await tryShareFromHash();
  booting.value = false;
  if (shared || session.value) {
    await initTimeline();
  } else {
    loading.value = false;
    await nextTick();
    renderSigninButton();
  }
});
</script>

<template>
  <div>
    <nav class="site-nav">
      <a class="brand" :href="topUrl" aria-label="トップへ移動" @click="onBrandClick">
        <span class="brand-mark">読</span>
        <span class="brand-text">
          <span class="brand-name">リーダー</span>
          <span class="brand-sub">RSSリーダー</span>
        </span>
      </a>
      <span></span>
      <span class="session-note">
        <button
          v-if="session && unreadTotalCount > 0"
          class="unread-pill"
          type="button"
          @click="goUnreadAll"
        >未読 {{ unreadTotalCount }}</button>
        <span v-if="isReadonly" class="meta">閲覧のみ</span>
        <button
          v-if="session"
          class="ghost nav-refresh"
          type="button"
          :disabled="refreshing"
          @click="onManualRefresh"
        >{{ refreshing ? '更新中…' : '更新' }}</button>
        <button v-if="session && isOwner" class="ghost nav-mgmt" type="button" @click="openFeedAdmin">管理</button>
        <button v-if="session" class="nav-logout" type="button" @click="signOut">ログアウト</button>
      </span>
    </nav>
    <div class="layout" :class="{ 'has-player': !!currentEpisode }">
      <p v-if="bootError" class="panel center error">{{ bootError }}</p>

      <template v-if="!session">
        <section class="panel center signin-box">
          <p v-if="booting || signingIn" class="hint"><span class="spinner"></span>読み込んでいます…</p>
          <p v-else class="hint">Googleログインが必要です。許可されたアカウントでサインインしてください。</p>
          <p v-if="googleScriptError" class="error">Googleログインスクリプトの読み込みに失敗しました。広告ブロック等を解除して再読み込みしてください。</p>
          <div v-show="!booting && !signingIn" ref="signinEl"></div>
        </section>
      </template>

      <template v-else>
        <p v-if="isReadonly" class="readonly-note">共有リンクで閲覧中（読み取り専用）です。既読はこの端末の中だけに記録されます。</p>

        <template v-if="view === 'timeline'">
        <div class="filter-bar">
        <div v-if="categoryList.length" class="feed-chips category-chips" role="tablist" aria-label="カテゴリで絞り込み">
          <button
            v-for="c in categoryList"
            :key="c"
            type="button"
            class="chip"
            :class="{ active: state.category === c }"
            @click="setCategory(c)"
          >{{ c }}</button>
        </div>
        <div class="feed-chips" role="tablist" aria-label="フィードで絞り込み">
          <button
            v-for="f in chipFeeds"
            :key="f.id"
            type="button"
            class="chip"
            :class="{ active: state.feedId === f.id }"
            @click="setFeed(f.id)"
          >{{ feedDisplayName(f) }}<span v-if="f.unreadCount > 0" class="chip-count">{{ f.unreadCount }}</span></button>
        </div>

        </div>

        <p v-if="listError" class="panel center error">{{ listError }}
          <button class="ghost" type="button" @click="refreshInBackground()">再試行</button>
        </p>
        <p v-else-if="loading" class="panel center"><span class="spinner"></span>読み込み中…</p>
        <template v-else>
          <p v-if="displayArticles.length === 0" class="panel empty-note">記事がありません。</p>
          <article
            v-for="a in displayArticles"
            :key="a.id"
            class="card article-card"
            :class="{ 'is-read': a.isRead }"
          >
            <p class="article-meta">
              <span class="feed-name">{{ a.feedTitle || a.feedId }}</span>
              <span>{{ formatPublishedAt(a.publishedAt || a.fetchedAt) }}</span>
              <span v-if="a.author">{{ a.author }}</span>
            </p>
            <h2 class="article-title">
              <a :href="a.link" target="_blank" rel="noopener" @click="onOpenArticle(a)">{{ a.title }}</a>
            </h2>
            <p
              v-if="a.summary"
              :ref="(el) => registerSummaryEl(a.id, el)"
              class="article-summary"
              :class="{ expanded: expandedSummaryIds.has(a.id) }"
            >{{ a.summary }}</p>
            <button
              v-if="a.summary && (expandedSummaryIds.has(a.id) || clampedSummaryIds.has(a.id))"
              type="button"
              class="summary-toggle"
              :aria-expanded="expandedSummaryIds.has(a.id) ? 'true' : 'false'"
              @click="toggleSummary(a.id)"
            >{{ expandedSummaryIds.has(a.id) ? '閉じる' : 'もっと見る' }}</button>
            <div class="article-foot">
              <button
                v-if="isOwner && isYouTubeArticle(a)"
                type="button"
                class="star-btn"
                :class="{ 'is-starred': a.starred }"
                :aria-label="a.starred ? 'スターを外す' : 'スターを付ける'"
                :aria-pressed="a.starred ? 'true' : 'false'"
                @click="applyStar(a, !a.starred)"
              >{{ a.starred ? '⭐' : '☆' }}</button>
              <span v-if="!a.isRead" class="unread-dot" aria-label="未読"></span>
              <button
                v-if="canPlay(a)"
                type="button"
                class="play-btn"
                :class="{ 'is-current': isCurrentEpisode(a), 'is-stale': a.audioStale }"
                :aria-label="playButtonLabel(a)"
                @click="toggleEpisode(a)"
              >
                <span v-if="audioRefreshingIds.has(a.id) || (isCurrentEpisode(a) && isLoading)" class="play-loading" aria-hidden="true">…</span>
                <svg v-else-if="isCurrentEpisode(a) && isPlaying" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                <span v-if="a.audioStale" class="play-btn-badge" aria-hidden="true"></span>
              </button>
              <span v-if="canPlay(a) && a.durationSec" class="audio-duration">{{ formatTime(a.durationSec) }}</span>
              <button
                v-if="isOwner"
                type="button"
                class="read-toggle"
                @click="applyRead(a, !a.isRead)"
              >{{ a.isRead ? '未読に戻す' : '既読にする' }}</button>
            </div>
          </article>
          <p v-if="hasMore" class="more-row">
            <button class="ghost" type="button" @click="displayLimit += DISPLAY_LIMIT">もっと見る</button>
          </p>
        </template>

        <div class="bottom-bar">
          <div v-if="isOwner && markAllConfirm" class="mark-all-confirm">
            <span class="mark-all-confirm-text">未読{{ scopedUnreadCount }}件をすべて既読にしますか？</span>
            <button class="primary mark-all-confirm-btn" type="button" @click="onMarkAllRead">すべて既読にする</button>
            <button class="ghost mark-all-confirm-btn" type="button" @click="cancelMarkAllRead">キャンセル</button>
          </div>
          <template v-else>
            <button
              v-if="isOwner"
              class="primary mark-all-btn"
              type="button"
              :disabled="scopedUnreadCount === 0"
              @click="askMarkAllRead"
            >すべて既読</button>
            <div class="view-tabs" role="tablist" aria-label="表示切替">
              <button
                v-for="f in FILTERS"
                :key="f.key"
                type="button"
                :class="{ active: state.filter === f.key }"
                @click="setFilter(f.key)"
              >{{ f.label }}</button>
            </div>
          </template>
        </div>
        </template>

        <template v-else>
          <div class="feed-admin-head">
            <!-- タイムラインへはヘッダーのブランド (ホームボタン) で戻る。 -->
            <button v-if="!formMode" class="primary" type="button" @click="startAddFeed">フィードを追加</button>
          </div>

          <form v-if="formMode" ref="formEl" class="panel feed-form" @submit.prevent="submitFeedForm">
            <h2 class="feed-form-title">{{ formMode === 'edit' ? 'フィードを編集' : 'フィードを追加' }}</h2>
            <template v-if="formMode === 'edit'">
              <div class="field">
                <span class="field-label">タイトル</span>
                <p class="field-static">{{ form.title || '（未取得）' }}</p>
              </div>
              <div class="field">
                <span class="field-label">URL</span>
                <p class="field-static">{{ form.url }}</p>
                <p v-if="youtubeChannelIdFromUrl(form.url)" class="field-note">URLは変更できません。解除はYouTubeアプリで行ってください。</p>
                <p v-else class="field-note">URLは変更できません。変える場合は削除してから追加し直してください。</p>
              </div>
            </template>
            <div v-else class="field">
              <label for="feed-url">URL</label>
              <input
                id="feed-url"
                v-model="form.url"
                type="url"
                autocomplete="off"
                placeholder="https://example.com/feed.xml"
              />
              <p class="field-note">タイトルはフィードから自動で取得します。YouTube はチャンネルの URL でも登録できます。</p>
            </div>
            <div class="field">
              <label for="feed-category">ジャンル</label>
              <input
                id="feed-category"
                v-model="form.category"
                type="text"
                autocomplete="off"
                placeholder="例: ニュース"
              />
              <!-- 候補は通常フロー内のチップで出す。ネイティブの
                   datalist は、候補が1つに絞られたときに iOS Safari
                   のポップアップが保存ボタンに被って押せなくなる
                   ため使わない。 -->
              <div v-if="genreSuggestionList.length" class="genre-suggestions" aria-label="ジャンルの候補">
                <button
                  v-for="c in genreSuggestionList"
                  :key="c"
                  type="button"
                  class="chip"
                  @click="form.category = c"
                >{{ c }}</button>
              </div>
            </div>
            <p v-if="formError" class="error">{{ formError }}</p>
            <div class="form-actions">
              <button class="primary" type="submit" :disabled="formSaving || formFetching || (formMode === 'edit' && !formDirty)">
                {{ formFetching ? '取得中...' : formSaving ? '保存中...' : '保存' }}
              </button>
              <button class="ghost" type="button" :disabled="formSaving || formFetching" @click="cancelForm">キャンセル</button>
            </div>
          </form>

          <p v-if="mgmtError" class="panel center error">{{ mgmtError }}
            <button class="ghost" type="button" @click="loadFeeds">再試行</button>
          </p>
          <p v-else-if="mgmtLoading" class="panel center"><span class="spinner"></span>読み込み中…</p>
          <template v-else>
            <!-- フィード編集中はフォームに集中できるよう、ジャンル選択と
                 一覧は隠す。adminCategory 等の状態はそのまま保持し、
                 保存/キャンセルで閉じれば元の絞り込み表示に戻る。 -->
            <template v-if="formMode !== 'edit'">
            <div v-if="genreOptions.length" class="feed-chips category-chips" role="tablist" aria-label="ジャンルで絞り込み">
              <button
                v-for="c in genreOptions"
                :key="c"
                type="button"
                class="chip"
                :class="{ active: adminCategory === c }"
                @click="setAdminCategory(c)"
              >{{ c }}</button>
            </div>
            <p v-if="mgmtFeeds.length === 0" class="panel empty-note">フィードがありません。</p>
            <p v-else-if="adminFeeds.length === 0" class="panel empty-note">そのジャンルのフィードはありません。</p>
            <article
              v-for="(f, i) in adminFeeds"
              :key="f.id"
              class="card feed-card"
              :class="{ 'is-dragging': drag && drag.from === i, 'drag-settling': dragSettling }"
              :style="feedCardDragStyle(i)"
            >
              <!-- 並び替えは左端のハンドルからのドラッグで行う。シート
                   全体の順序に対する操作なので、ジャンルで絞っている
                   間はハンドル自体を出さない (部分集合の中での移動に
                   見えて誤解を招くため)。 -->
              <button
                v-if="!adminCategory"
                type="button"
                class="drag-handle"
                aria-label="ドラッグで並び替え"
                @pointerdown="onDragPointerDown($event, i)"
                @pointermove="onDragPointerMove"
                @pointerup="onDragPointerUp"
                @pointercancel="onDragPointerCancel"
              >≡</button>
              <div class="feed-card-main">
              <p class="article-meta">
                <span class="feed-name">{{ feedDisplayName(f) }}</span>
                <span v-if="f.category">{{ f.category }}</span>
                <span>未読 {{ f.unreadCount || 0 }}件</span>
              </p>
              <p class="feed-url">{{ f.url }}</p>
              <p class="feed-status">{{ formatFeedStatus(f) }}</p>
              <div v-if="confirmDeleteId === f.id" class="delete-confirm">
                <p class="error">このフィードを削除しますか？このフィードの記事もすべて削除されます。</p>
                <div class="feed-actions">
                  <button
                    class="ghost danger"
                    type="button"
                    :disabled="mgmtSavingId === f.id"
                    @click="onDeleteFeed(f)"
                  >{{ mgmtSavingId === f.id ? '削除中...' : '本当に削除' }}</button>
                  <button
                    class="ghost"
                    type="button"
                    :disabled="mgmtSavingId === f.id"
                    @click="cancelDeleteFeed"
                  >キャンセル</button>
                </div>
              </div>
              </div>
              <!-- 編集・削除はカード右側の空きに置く (カード本体の
                   フレックス行の3つ目の要素)。削除確認が出ている間は
                   隠す (確認のボタンは本体側に出る)。
                   YouTube フィードは追加・解除が YouTube 側の正のため
                   削除は出さない。ただしジャンルだけはリーダー側が正
                   (購読同期は既存行のジャンルには触れない) なので、
                   編集は通常どおり出し、解除は YouTube アプリ側での
                   操作を案内する小さな注記を添える (並び替えも従来
                   どおり可能)。 -->
              <div v-if="confirmDeleteId !== f.id" class="feed-actions feed-card-actions">
                <p v-if="youtubeChannelIdFromUrl(f.url)" class="feed-youtube-note">解除はYouTubeアプリで</p>
                <button class="ghost" type="button" @click="startEditFeed(f)">編集</button>
                <button v-if="!youtubeChannelIdFromUrl(f.url)" class="ghost danger" type="button" @click="askDeleteFeed(f)">削除</button>
              </div>
            </article>
            </template>
          </template>

          <!-- 共有リンク (マジックリンク) は管理画面の最下部に置く。
               サーバーはトークンのハッシュしか持たないため、平文の
               URL を表示できるのは発行直後のこの画面だけ。 -->
          <section class="panel share-link-panel">
            <h2 class="feed-form-title">共有リンク</h2>
            <p class="hint">このリンクを開くと、ログインなしで読み取り専用として閲覧できます。有効期限は発行から1か月です。</p>
            <p v-if="shareLoading && !shareStatus" class="hint"><span class="spinner"></span>読み込み中…</p>
            <template v-else>
              <p v-if="shareStatus && shareStatus.active" class="share-status">
                有効なリンクがあります<template v-if="formatShareExpiry(shareStatus.expiresAt)">（{{ formatShareExpiry(shareStatus.expiresAt) }} まで）</template>。
              </p>
              <p v-else class="share-status">有効なリンクはありません。</p>

              <div v-if="shareUrl" class="share-url-row">
                <input
                  class="share-url"
                  type="text"
                  readonly
                  :value="shareUrl"
                  aria-label="共有リンクのURL"
                  @focus="$event.target.select()"
                />
                <button class="ghost" type="button" @click="copyShareUrl">{{ shareCopied ? 'コピーしました' : 'コピー' }}</button>
              </div>
              <p v-if="shareUrl" class="field-note">この URL を表示できるのは発行直後だけです（サーバーには控えがありません）。必要な場合は今のうちにコピーして控えてください。</p>

              <div v-if="shareConfirm === 'issue'" class="delete-confirm">
                <p class="error">{{ shareStatus && shareStatus.active ? '新しいリンクを発行すると、いまのリンクは使えなくなります。発行しますか？' : '共有リンクを発行しますか？' }}</p>
                <div class="feed-actions">
                  <button
                    class="ghost danger"
                    type="button"
                    :disabled="shareSaving"
                    @click="onIssueShare"
                  >{{ shareSaving ? '発行中...' : '発行する' }}</button>
                  <button
                    class="ghost"
                    type="button"
                    :disabled="shareSaving"
                    @click="cancelShareConfirm"
                  >キャンセル</button>
                </div>
              </div>
              <div v-else-if="shareConfirm === 'revoke'" class="delete-confirm">
                <p class="error">共有リンクを無効化しますか？このリンクでは閲覧できなくなります。</p>
                <div class="feed-actions">
                  <button
                    class="ghost danger"
                    type="button"
                    :disabled="shareSaving"
                    @click="onRevokeShare"
                  >{{ shareSaving ? '無効化中...' : '無効化する' }}</button>
                  <button
                    class="ghost"
                    type="button"
                    :disabled="shareSaving"
                    @click="cancelShareConfirm"
                  >キャンセル</button>
                </div>
              </div>
              <div v-else class="feed-actions share-actions">
                <button class="primary" type="button" :disabled="shareSaving || shareLoading" @click="askIssueShare">リンクを発行する</button>
                <button
                  v-if="shareStatus && shareStatus.active"
                  class="ghost danger"
                  type="button"
                  :disabled="shareSaving || shareLoading"
                  @click="askRevokeShare"
                >リンクを無効化する</button>
              </div>
            </template>
            <p v-if="shareError" class="error">{{ shareError }}</p>
          </section>

          <!-- 今週の視聴 (視聴ログの週次集計のうち今週分)。
               週が変わるまで内容は変わらないため、取得は管理画面を
               開いたときの1回だけ。 -->
          <section class="panel usage-stats-panel">
            <h2 class="feed-form-title">今週の視聴</h2>
            <p v-if="statsLoading && !statsData" class="hint"><span class="spinner"></span>読み込み中…</p>
            <template v-else-if="statsData">
              <ul v-if="currentWeekListening.length" class="usage-stats-list">
                <li v-for="s in currentWeekListening" :key="s.feed_id">
                  <span class="usage-stats-feed">{{ s.feed_title || s.feed_id }}</span>
                  <span class="usage-stats-meta">{{ formatTime(s.seconds) }}・{{ s.plays }}回</span>
                </li>
              </ul>
              <p v-else class="hint">今週の再生はまだありません。</p>
            </template>
            <p v-if="statsError" class="error">{{ statsError }}</p>
          </section>
        </template>
      </template>

      <div v-if="currentEpisode" class="player-bar">
        <div class="player-now">
          <span class="player-title">{{ currentEpisode.title }}</span>
          <span v-if="currentEpisode.feedTitle" class="player-feed">{{ currentEpisode.feedTitle }}</span>
          <span v-if="currentEpisode.audioStale" class="player-stale">古い音声URL</span>
          <button type="button" class="player-close" aria-label="プレイヤーを閉じる" @click="stopPlayer">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
          </button>
        </div>
        <div class="player-progress">
          <span class="player-time">{{ formatTime(displayTime) }}</span>
          <input
            class="player-seek"
            type="range"
            min="0"
            :max="displayDuration || 0"
            step="0.1"
            :value="displayTime"
            :style="seekStyle"
            aria-label="再生位置"
            @input="onSeekInput"
            @pointerdown="seeking = true"
            @pointerup="seeking = false"
          />
          <span class="player-time player-total">{{ formatTime(displayDuration) }}</span>
        </div>
        <div class="player-controls">
          <button type="button" class="player-button player-skip" aria-label="15秒戻る" title="15秒戻る" @click="skipBy(-15)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" /><text x="12" y="16.1" text-anchor="middle" font-size="8.5" font-weight="700">15</text></svg>
          </button>
          <button type="button" class="player-button player-step player-prev" aria-label="前へ" title="前へ" @click="skipByTrack(-1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
          </button>
          <button
            type="button"
            class="player-play"
            :aria-label="isLoading ? '読み込み中' : (isPlaying ? '一時停止' : '再生')"
            @click="togglePlay"
          >
            <span v-if="isLoading" class="player-loading" aria-hidden="true">…</span>
            <svg v-else-if="isPlaying" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          </button>
          <button type="button" class="player-button player-step player-next" aria-label="次へ" title="次へ" @click="skipByTrack(1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
          </button>
          <button type="button" class="player-button player-skip" aria-label="30秒進む" title="30秒進む" @click="skipBy(30)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(24 0) scale(-1 1)"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" /></g><text x="12" y="16.1" text-anchor="middle" font-size="8.5" font-weight="700">30</text></svg>
          </button>
          <button type="button" class="player-button" aria-label="再生速度" @click="cycleSpeed">{{ speedLabel }}</button>
        </div>
        <div class="player-toggles">
          <button
            type="button"
            class="player-toggle"
            :class="{ 'is-on': repeatMode !== 'none' }"
            :aria-label="repeatLabel"
            :title="repeatLabel"
            @click="cycleRepeat"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" /></svg>
            <span v-if="repeatMode === 'one'" class="player-badge">1</span>
          </button>
          <button
            type="button"
            class="player-toggle"
            :class="{ 'is-on': shuffleOn }"
            :aria-label="shuffleLabel"
            :title="shuffleLabel"
            :aria-pressed="shuffleOn ? 'true' : 'false'"
            @click="toggleShuffle"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" /></svg>
          </button>
        </div>
      </div>

      <footer class="site-footer">
        <div class="foot-links">
          <a href="https://freddiefujiwara.com/" target="_blank" rel="noopener">トップ <span class="arr">↗</span></a>
        </div>
        <p class="copy">© {{ year }} freddiefujiwara.com</p>
      </footer>
    </div>
  </div>
</template>
