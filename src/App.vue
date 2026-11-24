<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { API_URL, GOOGLE_CLIENT_ID } from './config.js';
import {
  deleteFeed,
  exchangeSession,
  exchangeShare,
  getFeedStats,
  getShareLinkStatus,
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
import { formatFeedUsage } from './lib/feedStats.js';
import { buildXShareUrl, buildFacebookShareUrl, buildThreadsShareUrl } from './lib/shareArticle.js';
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
  youtubePlaylistIdFromUrl,
  effectiveStarMode,
  STAR_DEFAULT_COUNT,
  STAR_DEFAULT_MIN_SEC,
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
  patchFeedAttrs,
  planArticleJump,
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
  createRouteReloadGuard,
  createStallTracker,
  createStartWatchdog,
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
  REPEAT_LABELS,
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
// フィード別の利用状況 (削除候補の判断材料)。サーバーの feed_stats
// 集計をフィード ID キーで持つ。null=未取得 (行は出さない)。
const feedStats = ref(null);
const shareStatus = ref(null); // null=未取得 / { active, expiresAt }
const shareUrl = ref('');
const shareLoading = ref(false);
const shareSaving = ref(false);
const shareError = ref('');
const shareConfirm = ref(''); // '' | 'issue' | 'revoke'
const shareCopied = ref(false);
// 記事カードの「リンクをコピー」のフィードバック先 (記事ID)。
// 一定時間で自動的に戻す。
const copiedArticleId = ref('');
let copiedArticleTimer = null;
onUnmounted(() => {
  if (copiedArticleTimer) clearTimeout(copiedArticleTimer);
});
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

// フォームのスター選定の実効モード (選択値が無ければ種別既定)。
// 本数・下限の入力欄は、実効モードが「新しい順」のときだけ出す。
const formStarMode = computed(() => effectiveStarMode({ starMode: form.value.starMode, url: form.value.url }));

const isReadonly = computed(() => session.value?.role === 'readonly');
const isOwner = computed(() => session.value?.role === 'owner');
// YouTube フィードの ID 集合。記事が YouTube 由来かどうかは、
// フィードの保存 URL からチャンネル ID かプレイリスト ID が取れるか
// で判定する (サーバー側の RSS 出し分けと同じ判定)。
const youtubeFeedIds = computed(() =>
  new Set(
    state.value.feeds
      .filter((f) => youtubeChannelIdFromUrl(f.url) || youtubePlaylistIdFromUrl(f.url))
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
// フィードが全文 (content) を持つ記事は、展開時に要約ではなく全文を
// 出す。要約が3行に収まっていても全文が長ければ展開で増える分が
// あるため、その場合は測定結果によらずボタンを出す。
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

// 測定の予約の共通形。状態変更の直後 (nextTick) に測るだけでは、
// ブラウザがレイアウトを確定させる前の値を読んで誤判定することが
// ある (起動直後や既読化の直後に、要約の「省略なし」と誤判定して
// ボタンが消えたままになる等)。次ティックで測ったうえで、
// レイアウトが落ち着く次のアニメーションフレームでもう一度
// 測り直して誤判定を正す。予約が重なっても、フレーム側の測定は
// 1回にまとめる。
function createDeferredMeasure(measure) {
  let framePending = false;
  return function scheduleMeasure() {
    nextTick(measure);
    if (framePending) return;
    framePending = true;
    const run = () => {
      framePending = false;
      measure();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else nextTick(run);
  };
}

const scheduleMeasureSummaries = createDeferredMeasure(measureSummaries);

// 要約欄に出すテキスト。折りたたみ中は要約、展開中は全文 (あれば)。
function summaryDisplayText(a) {
  if (expandedSummaryIds.value.has(a.id) && a.content) return a.content;
  return a.summary || '';
}

// 全文が要約より長い (＝展開すると表示が増える) 記事かどうか。
function hasLongContent(a) {
  return !!(a.content && a.content.length > (a.summary || '').length);
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
      queueEventAndFlush({
        type: 'expand',
        feed_id: article.feedId,
        feed_title: article.feedTitle || feedTitleOf(article.feedId),
        article_id: article.id,
        article_title: article.title || '',
      });
      // 展開したら、その記事は読んだ扱いにする (「既読にする」と同じ
      // applyRead の経路。閉じる操作では既読を取り消さない)。
      if (!article.isRead) applyRead(article, true);
    }
  }
}

watch(displayArticles, () => scheduleMeasureSummaries());
window.addEventListener('resize', scheduleMeasureSummaries);
onUnmounted(() => window.removeEventListener('resize', scheduleMeasureSummaries));

// フィードチップ行の開閉 (PC幅のみ)。PC幅ではチップを折り返して
// 全件見せるが、「すべて」では全フィードが縦に並んでファーストビューを
// 占有するため、既定は CSS で2行までに抑え、はみ出すときだけ
// 「すべて表示」で広げる。はみ出しの判定は要約と同じく、描画後の
// scrollHeight / clientHeight の比較で行う (抑えたときにだけ差が出る。
// スマホ幅では抑えないので差は出ず、トグルも出ない)。
// 開閉状態は保存しない (画面を開いている間だけの状態)。
const feedChipsExpanded = ref(false);
const feedChipsOverflow = ref(false);
let feedChipsEl = null;

function registerFeedChipsEl(el) {
  feedChipsEl = el || null;
  if (el) scheduleMeasureFeedChips();
}

function measureFeedChips() {
  const el = feedChipsEl;
  if (!el) {
    feedChipsOverflow.value = false;
    return;
  }
  // 展開中は測れない (切れていない)。閉じたときに測り直すため、
  // それまでの省略判定は引き継ぐ。
  if (feedChipsExpanded.value) return;
  // まだレイアウトされていない (描画前・非表示) 要素は測れない。
  // 空振りの測定で判定を落とさないよう、前回を引き継ぐ。
  if (el.scrollHeight === 0 && el.clientHeight === 0) return;
  feedChipsOverflow.value = el.scrollHeight > el.clientHeight + 1;
}

// 測定の予約 (要約と同じ createDeferredMeasure の二段構え)。
const scheduleMeasureFeedChips = createDeferredMeasure(measureFeedChips);

function toggleFeedChips() {
  feedChipsExpanded.value = !feedChipsExpanded.value;
  // 閉じ直したら測り直す (対象が減って収まるようになった場合は
  // トグル自体を消す)。
  if (!feedChipsExpanded.value) scheduleMeasureFeedChips();
}

// チップの顔ぶれ (ID集合) が変わったら、閉じた状態に戻して測り直す。
// 未読バッジの有無や並び順だけの変化では閉じず、測定だけ行う
// (背景更新で一覧が差し替わっても、開いた状態は維持する)。
let lastChipFeedIds = '';
watch(chipFeeds, (feeds) => {
  const ids = feeds.map((f) => f.id).sort().join('\n');
  if (ids !== lastChipFeedIds) {
    lastChipFeedIds = ids;
    feedChipsExpanded.value = false;
  }
  scheduleMeasureFeedChips();
});
window.addEventListener('resize', scheduleMeasureFeedChips);
onUnmounted(() => window.removeEventListener('resize', scheduleMeasureFeedChips));

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

// 固定表示のナビと絞り込みバーの下端 (ビューポート座標) ＋余白。
// バーの高さは画面幅やチップの折り返しで変わるため実測する。
// バーが無ければナビの高さ＋余白で見積もる。
function stickyBarOffset() {
  const bar = document.querySelector('.filter-bar');
  return bar ? bar.getBoundingClientRect().bottom + 8 : 76;
}

// カードの上端が固定バーの下にちょうど出る位置へスクロールする。
function scrollCardIntoView(el, smooth) {
  const top = el.getBoundingClientRect().top + window.scrollY - stickyBarOffset();
  window.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

// プレイヤーのタイトル押下: 再生中の記事のカードへ移動する。表示を
// その記事のフィード単体 (全件) へ切り替え、必要なら表示上限を
// 広げてから、カードが見える位置までスクロールして短くハイライト
// する。再生は止めない。対象が一覧に無ければ何もしない。
async function jumpToCurrentArticle() {
  const ep = currentEpisode.value;
  if (!ep) return;
  const plan = planArticleJump(state.value, ep, DISPLAY_LIMIT);
  if (!plan) return;
  applyRoute({ view: 'timeline', category: plan.category, feedId: plan.feedId, unread: false, staging: routeStaging });
  if (plan.displayLimit > displayLimit.value) displayLimit.value = plan.displayLimit;
  await nextTick();
  const el = document.querySelector(`[data-article-id="${ep.id}"]`);
  if (!el) return;
  scrollCardIntoView(el, true);
  // スクロールが落ち着く頃、要約の再計測などで生じた位置のずれを
  // 1回だけ直し、収まった位置でハイライトする。大きくずれていたら
  // (本人が自分でスクロールした等) 直さない。
  setTimeout(() => {
    if (!el.isConnected) return;
    const drift = el.getBoundingClientRect().top - stickyBarOffset();
    if (Math.abs(drift) > 4 && Math.abs(drift) <= 120) {
      window.scrollTo({ top: Math.max(0, window.scrollY + drift), behavior: 'auto' });
    }
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 2400);
  }, 600);
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
      // (サーバー側で上限は調整される)。初回取り込みが済んでいれば
      // 全項目は要らないため、スター同期専用の軽量形 (scope=stars)
      // で取り、応答を小さくする。
      const payload = await listArticles(session.value.token, { limit: IMPORT_LIMIT, scope: needImport ? '' : 'stars' });
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
        result.feed, result.entries, fetchedAt, hasTransfer ? transfer : null,
        { feedComplete: result.complete === true }
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

// 絞り込み (フィード・カテゴリ・既読フィルタ) の変更で共通する
// 後始末: 未読表示中に残していた既読カードを畳み、表示件数を
// 初期値へ戻し、別の一覧へ移るので先頭から見せる。scroll の
// 視聴ログの帰属 (scrollLoggedFeedId) はフィード・カテゴリの
// 変更ではリセットするが、既読フィルタの変更では変えない。
function changeSelection(patch, { resetScrollLog = true } = {}) {
  clearStickyReadIds();
  if (resetScrollLog) scrollLoggedFeedId = '';
  state.value = { ...state.value, ...patch };
  displayLimit.value = DISPLAY_LIMIT;
  scrollToTop();
}

function setFeed(feedId) {
  // 選択中のフィードを再タップしたら解除し、全件表示に戻す
  // (「すべて」チップは廃止し、トグル選択にした)。
  const next = state.value.feedId === feedId ? '' : feedId;
  if (next === state.value.feedId) return;
  changeSelection({ feedId: next });
  // 視聴ログ: フィードを開いた操作だけを記録する (選択の解除や
  // ジャンルだけの変更、初期表示・背景更新では送らない)。
  if (next) {
    queueEventAndFlush({
      type: 'feed_view',
      feed_id: next,
      feed_title: feedTitleOf(next),
      article_id: '',
      article_title: '',
    });
  }
}

function setCategory(category) {
  // 選択中のカテゴリを再タップしたら解除し、全件表示に戻す
  // (「すべて」チップは廃止し、トグル選択にした)。
  const next = state.value.category === category ? '' : category;
  if (next === state.value.category) return;
  // カテゴリを変えたらフィード選択は解除する (対象外フィードが残らないように)。
  changeSelection({ category: next, feedId: '' });
}

function setFilter(filter) {
  if (state.value.filter === filter) return;
  changeSelection({ filter }, { resetScrollLog: false });
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
  queueEventAndFlush({
    type: 'article_open',
    feed_id: article.feedId,
    feed_title: article.feedTitle || feedTitleOf(article.feedId),
    article_id: article.id,
    article_title: article.title || '',
  });
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

// キューへ入れて、その場で送る (操作の区切りで送る箇所の共通形)。
function queueEventAndFlush(event) {
  queueEvent(event);
  flushEventLog();
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
  queueEventAndFlush({
    type: 'scroll',
    feed_id: feedId,
    feed_title: feedTitleOf(feedId),
    article_id: '',
    article_title: '',
  });
}

window.addEventListener('scroll', onTimelineScroll, { passive: true });
onUnmounted(() => window.removeEventListener('scroll', onTimelineScroll));

// 再生時間の積算 (play/pause の区間で実再生時間を測る)。
const listenTracker = createListenTracker();

// 再生時間の確定だけを行う (送信はしない)。切り替えの前に積算を
// 区切る必要がある箇所 (loadEpisode・単曲リピート) では、こちらで
// 確定だけ済ませ、送信は再生開始の後に回す。
function finalizePlayListen() {
  return listenTracker.finalize();
}

// 確定した play イベントをキューへ入れて送る。
function sendPlayListen(event) {
  if (event) queueEvent(event);
  flushEventLog();
}

// 再生が止まった区切りで、積算した再生時間を play イベントとして
// キューへ入れ、まとめて送る。
function flushPlayListen() {
  sendPlayListen(finalizePlayListen());
}

// 再生診断ログ: バックグラウンド再生の失敗を後から追えるよう、
// 再生まわりの出来事を視聴ログと同じ経路 (キュー → log_events)
// で送る。種別は preload_error (次曲の先読みでエラーが起きた。
// 対象は先読み先の曲) / advance_swap (曲の終了で、待機側への役割
// 交代で次へ進んだ。対象は次の曲) / advance_load (曲の終了で、
// 従来経路の新規読み込みで次へ進んだ。対象は次の曲) / stall
// (ストール検知が発動した。seconds は止まった位置) / recover
// (フォアグラウンド復帰時の回復が、止まっていた再生を再開・
// 前進させた。対象は止まっていた曲) / deck_overlap (待機側の
// 要素が再生状態になっているのを検出して止めた。対象は待機側に
// 載っていた曲、seconds は待機側の止めた位置) /
// play_rejected_not_allowed / play_rejected_not_supported /
// play_rejected_other (play() が拒否された。種別で理由
// (エラーの name) を区別する) / start_retry (遷移直後の開始
// チェックが play() を再発行した) / start_fallback (開始
// チェックが、直前まで鳴っていた要素へ読み直して再生する
// フォールバックを行った) / start_failed (再発行・フォール
// バックでも始まらなかった) / route_offline・route_online
// (回線イベントを受けた。対象はその時点で再生中の曲) /
// route_reload (回線切り替わりで、再生中の曲を現在位置から
// 読み直した。seconds は読み直し位置) の15。いずれもキューへの
// push のみで、送信の開始は既存の区切りに相乗りする (再生開始を
// 遅らせないため、この関数から flush はしない)。
function queueDiagEvent(type, ep, seconds) {
  if (!ep) return;
  const event = {
    type,
    feed_id: ep.feedId,
    feed_title: ep.feedTitle || feedTitleOf(ep.feedId),
    article_id: ep.id,
    article_title: ep.title || '',
  };
  if (seconds !== undefined) event.seconds = seconds;
  queueEvent(event);
}

/* ---- ポッドキャスト再生 (端末ローカルのみ) ---- */

// 音声要素は2つ持ち、再生用と先読み用で役割を交代させる二重
// バッファにする (次曲への切り替えを、読み込みを挟まず同期的に
// 行うため。詳しくは「次の曲の先読み」の節)。`audio` は常に
// アクティブな (再生用) 要素を指し、もう一方が待機 (先読み用)
// になる。待機側は先読みが必要になるまで作らない (遅延生成)。
// 見た目は blog のプレイヤー (.music-player) の部品に揃える
// (style.css の player-* )。
const deckA = new Audio();
deckA.preload = 'metadata';
let deckB = null;
let audio = deckA;

// 待機側 (先読み用) の要素。まだ無ければ作る (リスナーも付ける)。
function standbyDeck() {
  if (audio !== deckA) return deckA;
  if (!deckB) {
    deckB = new Audio();
    deckB.preload = 'metadata';
    attachDeckListeners(deckB);
  }
  return deckB;
}

// 待機側の要素 (作らない。先読みの破棄やエラーの判定など、
// 無いなら何もしない場面用)。
function existingStandby() {
  return audio !== deckA ? deckA : deckB;
}

// 要素の読み込みを空に戻す (src を外して読み直させる)。先読みの
// 破棄・役割交代後の旧要素の片付け・プレイヤー停止で共通に使う。
function unloadDeck(el) {
  el.removeAttribute('src');
  el.load();
}
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
// 再生キューの記事ID列 (自動送り・失敗時の送り・前へ／次へ・
// 先読み対象の決定で共通に使う)。
function queueIds() {
  return playQueue.value.map((a) => a.id);
}
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

/* ---- 遷移直後の再生開始チェック (開始ウォッチドッグ) ----
   曲の終了遷移で play() を出しても、バックグラウンドでは
   再生が始まらないことがある (実機で3回観測: 交代直後に
   0:00 で停止、次曲の音声取得まで済んでいても始まらない等)。
   従来は play() の拒否 (NotAllowedError) を「ブロックされた
   だけ」として静かに捨て、開始したかの確認も無かったため、
   フォアグラウンド復帰時の回復まで止まり続けた。そこで
   loadEpisode のたびに player.js の createStartWatchdog を
   武装し、始まっていなければ play() の再発行 → 直前まで
   鳴っていた要素へのフォールバック → 打ち止め、の順に
   手当てする (実行は checkStartWatchdog)。判定は時刻の差と
   要素のイベント・play() の Promise に連鎖させ、タイマーが
   回らないバックグラウンドでも拒否の連鎖で進むようにする。 */
const startWatchdog = createStartWatchdog();
// ウォッチドッグを武装したときの読み込み世代 (episodeLoadSeq)。
// 別の読み込みへ移った後、古い武装のチェックが動かないように。
let startWatchdogSeq = -1;

/* ---- 回線切り替わり時の読み直し ----
   再生中に回線が切り替わると、要素は「再生中」のまま位置だけ
   進んで音が出なくなることがある (2026-11-22 朝: 曲の交代の
   2秒後に Wi-Fi → モバイル回線へ切り替わり、その曲は全長を
   無音のまま進みきった。開始チェック・ストール検知・
   フォアグラウンド回復のいずれも、要素が正常に再生している
   ように見えるため発火しなかった)。要素の出力レベルはページ
   から測れないので無音自体は検知できず、引き金の回線
   イベント ('offline' / 'online') を受けて、再生中の曲を
   現在位置から読み直す (実行は attemptRouteReload /
   reloadCurrentEpisode)。読み直してよいかの判定 (連続
   イベントの集約とクールダウン) は player.js の
   createRouteReloadGuard が持つ。 */
const routeReloadGuard = createRouteReloadGuard();
// 直近に実際に再生が始まった ('playing' が来た) 要素。開始に
// 失敗したとき、同じ曲を読み直して再生するフォールバック先。
let lastPlayedDeck = null;

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

// 現在の再生位置が既知の長さ (durationSec) へ到達したか。
// 位置は要素の現在値から変換して求める (終端で timeupdate が
// 止まると、currentTime ref は最後のイベントの値のままになり、
// 要素側だけが終端まで進んでいることがあるため)。到達判定
// (checkKnownDurationEnd) とフォアグラウンド復帰時の回復
// (recoverPlaybackOnForeground) で共通に使う。
function reachedEndNow() {
  return reachedKnownDurationEnd({
    displayPos: toDisplayPosition(audio.currentTime || 0, mappingCtx.value),
    trueSec: trueDuration.value,
    elementDuration: duration.value,
    hasMeasuredModel: !!measuredModel,
  });
}

// 既知の長さへの到達判定。timeupdate とタイマーの tick と
// 'pause' イベントの3経路から呼ばれる。到達していれば即座に
// 終了フローへ進むので、tick (0.5秒間隔) 経由でも到達から
// 1秒以内に遷移する。
// 入口の条件は「再生の意思 (playWanted) があること」で見る。
// 要素の 'pause' で駆動される isPlaying を条件にしていた頃は、
// 要素が終端で 'ended' を出さず 'pause' だけ出すと、その
// 'pause' で isPlaying が下りて判定自体が無効化され、意図
// (要素が無言で止まっても到達を判定する) と実装が食い違って
// いた。本人が一時停止した場合は playWanted が下りている
// ので、そちらでは発火しない。
function checkKnownDurationEnd() {
  if (!currentEpisode.value || !playWanted || endFlowDone) return false;
  if (!reachedEndNow()) return false;
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
  // 診断: 検知が発動したことを、止まった位置 (表示位置の秒) つき
  // で残す。送信は失敗処理側の区切り (次へ進めば loadEpisode の
  // flush) に相乗りする。
  queueDiagEvent('stall', currentEpisode.value, Math.floor(pos));
  handlePlaybackFailure();
  return true;
}

// タイマーの tick では、終端の到達判定とストール検知の両方を
// 見に行く (どちらも timeupdate が止まった状況でこそ要る)。
// あわせて、待機側が鳴っていないかも見る (二重再生の監視。
// silenceStandbyDeck) と、遷移直後の開始チェック
// (checkStartWatchdog) も行う。
function playerTimerTick() {
  silenceStandbyDeck();
  checkKnownDurationEnd();
  checkPlaybackStall();
  checkStartWatchdog();
  // 回線切り替わりの印が立っていて回線が戻っていれば、再生中
  // の曲を読み直す ('online' を取りこぼした場合の拾い直し)。
  attemptRouteReload();
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

/* ---- 遷移直後の開始チェックの実行 ----
   ウォッチドッグの判定 (player.js) を受けて、再発行・
   フォールバック・打ち止めを実行する。呼び出しは tick
   (playerTimerTick) と要素の 'canplay' と play() の拒否
   (blocked = true で猶予を待たない) から。ガード: 再生中の
   エピソードがあり、再生の意思があり、まだ開始しておらず、
   武装が現在の読み込みのものであること。本人が止めた場合は
   playWanted が下りているので何もしない。 */
function checkStartWatchdog(blocked = false) {
  if (!currentEpisode.value || !playWanted || episodePlayStarted) return;
  if (startWatchdogSeq !== episodeLoadSeq) return;
  const now = performance.now();
  if (!blocked && Number.isFinite(audio.readyState) && audio.readyState < 2) {
    // まだデータが届いていない (読み込み中) なら、開始でき
    // ないのは当然なので、段階を進めず猶予を延ばす。拒否が
    // 分かっている場合 (blocked) は読み込み状態によらず進む。
    startWatchdog.postpone(now);
    return;
  }
  const action = blocked ? startWatchdog.blocked(now) : startWatchdog.observe(now);
  if (action === 'retry') {
    // 診断: 開始チェックが play() を再発行したことを残す。
    queueDiagEvent('start_retry', currentEpisode.value);
    tryPlayAudio();
  } else if (action === 'fallback') {
    if (startFallbackToPreviousDeck()) {
      // 診断: フォールバックを行ったことを残す (成否は、その
      // 後に 'playing' が来るか、続けて start_failed が出るか
      // で読み分ける)。
      queueDiagEvent('start_fallback', currentEpisode.value);
    } else {
      // フォールバック先が無い (直前まで鳴っていた要素が
      // 今の要素自身しかない等) 場合は、そのまま打ち止める。
      queueDiagEvent('start_failed', currentEpisode.value);
      startWatchdog.disarm();
    }
  } else if (action === 'giveup') {
    // 診断: 再発行・フォールバックでも始まらなかったことを
    // 残す。以後の回復は従来どおりフォアグラウンド復帰時に
    // 委ねる (recover が出れば、そこで復旧したことが分かる)。
    queueDiagEvent('start_failed', currentEpisode.value);
  }
}

// 開始しなかった要素に見切りをつけ、直前まで鳴っていた側の
// 要素へ同じ曲を読み直して再生する。鳴っていた要素は WebKit
// に再生を許可されやすいという想定のフォールバック。役割を
// 入れ替えたら true (その要素が現在のアクティブになる)。
function startFallbackToPreviousDeck() {
  const ep = currentEpisode.value;
  const prev = lastPlayedDeck;
  if (!ep || !ep.audioUrl || !prev || prev === audio) return false;
  const failed = audio;
  // 先にアクティブを差し替えてから失敗側を止める (loadEpisode
  // の役割交代と同じ順序。失敗側から遅れて来るイベントは、
  // アクティブでない要素としてリスナー側で無視される)。
  audio = prev;
  failed.pause();
  unloadDeck(failed);
  // 失敗側は待機側になるが、先読みの文脈は役割交代で壊れて
  // いるため破棄する (次の 'playing' で張り直される)。
  resetPreloadState();
  isLoading.value = true;
  audio.src = ep.audioUrl;
  audio.playbackRate = speed.value;
  // 役割交代 (loadEpisode) と同じく、メタデータが既にあれば
  // その場で初期化し、無ければ 'loadedmetadata' が拾う。
  if (Number.isFinite(audio.duration)) applyDeckMetadata(audio);
  tryPlayAudio();
  return true;
}

/* ---- 回線切り替わり時の読み直しの実行 ----
   回線イベントの印が立ち、再生中 (本人の一時停止・停止では
   なく、開始済みで、要素が再生中を保っている) で、回線が
   戻っているときだけ読み直す。'online' イベントとタイマーの
   tick の両方から呼ばれる ('offline' の時点で印だけ立て、
   戻ったことを確認してから実行する。'online' を取りこぼして
   も tick が拾う)。 */
function attemptRouteReload() {
  const ep = currentEpisode.value;
  if (!ep || !ep.audioUrl || !playWanted) return;
  if (!episodePlayStarted || audio.paused || audio.ended || seeking.value) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  // 終端間際 (残り5秒以内) は、まもなく自然な曲の遷移が起きる
  // ため読み直さない (再開位置の保存ガードと同じ基準。ここで
  // 読み直すと、復元位置が 0 に倒れて曲が頭に戻る)。
  const pos = Math.floor(toDisplayPosition(audio.currentTime || 0, mappingCtx.value));
  if (isWithinEndGuard(pos, displayDuration.value)) return;
  if (!routeReloadGuard.take(performance.now())) return;
  reloadCurrentEpisode(ep, pos);
}

// 再生中の曲を、もう一方の要素へ現在位置から読み直す。音の
// 経路が固まった要素に見切りをつけるため、開始チェックの
// フォールバック (startFallbackToPreviousDeck) と同じ作法で
// 要素ごと取り替える (先読みは破棄し、次の 'playing' で
// 張り直す)。位置は pendingSeek 経由で、メタデータ読み込み時
// に復元する (loadEpisode の再開位置と同じ経路)。読み直しも
// 開始の一種なので、開始ウォッチドッグを武装し直し、始まら
// なければ再発行・フォールバックの手当てを受ける。
function reloadCurrentEpisode(ep, pos) {
  const target = standbyDeck();
  const failed = audio;
  // 先にアクティブを差し替えてから失敗側を止める (loadEpisode
  // の役割交代と同じ順序)。
  audio = target;
  failed.pause();
  unloadDeck(failed);
  resetPreloadState();
  pendingSeek = pos;
  isLoading.value = true;
  episodePlayStarted = false;
  stallTracker.reset(performance.now());
  audio.src = ep.audioUrl;
  audio.playbackRate = speed.value;
  if (Number.isFinite(audio.duration)) applyDeckMetadata(audio);
  tryPlayAudio();
  startWatchdog.arm(performance.now());
  startWatchdogSeq = episodeLoadSeq;
  // 診断: 回線切り替わりで読み直したことを、読み直し位置
  // (表示位置の秒) つきで残す。
  queueDiagEvent('route_reload', ep, pos);
}

/* ---- 次の曲の先読み (二重バッファ) ----
   切り替え時点で初めて読み込みが始まると、その読み込みの間は
   無音になり、バックグラウンドではその隙間にページが凍結されて
   遷移ごと止まることがある。PR #109 で終了時の処理順序を
   「次曲の play() を後処理より先に」へ直しても、読み込みの隙間
   自体が残り、実機では遷移の成否が実行ごとのレースになった
   (2曲続けて成功した回も、1曲目で詰まった回もある)。そこで
   待機側の要素へ次曲を先読みしておき、終了時は要素の役割を
   交代させて同期的に play() する (loadEpisode の役割交代)。
   先読みは、再生中の曲が始まった時点 ('playing') から始める。
   再生中はページが生きているので、その間に次曲を読み終える
   のが狙い。かつての残り60秒方式では、読み終える前に曲が
   終わることがあった。再生中トラックの初期読み込みと競合
   しないよう、起点は 'playing' (実際に再生が始まった時点)
   に置き、timeupdate でも対象の変化に追随する。
   待機側のエラーは本体へ波及させない。エラーの印 (preloadFailed)
   は「現在の読み込みの試行」に対するもので、初回のエラーでは
   その場で同じ URL を読み直して試行を作り直す
   (handlePreloadError)。あわせてその曲の URL を1回だけ再解決し
   (refreshPreloadUrl)、新しい URL が来たら張り替える。作り直
   した試行もエラーになり、再解決でも回復しなければ先読み失敗
   として印を付け、遷移時は従来どおりアクティブ側へ読み込む
   経路に倒す。 */
let preloadId = null;
// 待機側の読み込みがエラーになったか (再解決で張り直せたら下ろす)。
let preloadFailed = false;
// URL の再解決を既に試した先読み対象 (対象ごとに1回だけ試す)。
let preloadRetriedId = null;
// ランダム再生で、先読みの武装時に抽選して確定させた次曲
// ({ id, forId, resetPlayed }。forId は抽選時点で再生中の曲、
// resetPlayed はその抽選がラウンドのやり直しを伴うか)。終了
// 遷移と「次へ」はこの確定を優先し、先読みの対象と遷移先を
// 一致させる (役割交代で進めるようにするため)。状況が変わって
// 無効になったら破棄する (committedPlan)。先読みの破棄
// (resetPreloadState) と一緒に消える。
let committedNext = null;

// 先読みの追跡状態を初期状態へ戻す (先読みの破棄と、役割交代で
// 待機側が先読みでなくなるときに使う)。
function resetPreloadState() {
  preloadId = null;
  preloadFailed = false;
  preloadRetriedId = null;
  committedNext = null;
}

// 遷移計画 (nextEpisodePlan の結果) から、先読み対象の記事を
// 引く。計画が「次へ」でない・キューに無い・現在の曲そのもの・
// 音声URLが無い場合は対象なし (null)。リスト順とランダムの
// どちらの先読み対象の決定でも、検証はここに揃える。
function plannedPreloadArticle(plan) {
  if (!plan || plan.type !== 'advance') return null;
  const next = playQueue.value.find((a) => a.id === plan.id);
  if (!next || next.id === currentEpisode.value.id || !next.audioUrl) return null;
  return next;
}

// 次に再生することが事前に確定している記事 (無ければ null)。
// 次曲の決定は本体の自動送り (nextEpisodePlan) と同じにする。
// 単曲リピートは次も同じ曲なので対象外とする。ランダムでは、
// 武装の時点で1件抽選して確定させ (shufflePreloadTarget)、
// 終了遷移はその確定曲へ進む。確定が状況の変化で無効になった
// ら破棄し、遷移時の抽選 (従来動作) へ戻る。
function preloadTarget() {
  if (!currentEpisode.value || repeatMode.value === 'one') return null;
  if (shuffleOn.value) return shufflePreloadTarget();
  const plan = nextEpisodePlan({
    queue: queueIds(),
    currentId: currentEpisode.value.id,
    repeat: repeatMode.value,
    shuffle: false,
    playedIds: playedInRound,
  });
  return plannedPreloadArticle(plan);
}

// ランダム時の先読み対象。確定済みの抽選が生きていればそれを
// 使い、無ければこの時点で1件抽選して確定させる。抽選の規則
// (ラウンド内の未再生から選ぶ・一巡したら全体繰り返しのとき
// だけラウンドをやり直す) は遷移時の nextEpisodePlan と同じで、
// 確定には resetPlayed (ラウンドのやり直しを伴うか) も一緒に
// 持つ (遷移側の loadPlannedNext がそのまま解釈できる形)。
function shufflePreloadTarget() {
  const committed = committedPlan();
  if (committed) return playQueue.value.find((a) => a.id === committed.id) || null;
  const plan = nextEpisodePlan({
    queue: queueIds(),
    currentId: currentEpisode.value.id,
    repeat: repeatMode.value,
    shuffle: true,
    playedIds: playedInRound,
  });
  const next = plannedPreloadArticle(plan);
  if (!next) return null;
  committedNext = {
    id: next.id,
    forId: currentEpisode.value.id,
    resetPlayed: plan.resetPlayed === true,
  };
  return next;
}

// 確定させた次曲 (committedNext) が現在の状況でもそのまま
// 使えるかを確かめ、使えるなら遷移計画として返す。使えない
// 確定は破棄して null を返す (呼び出し側は従来動作へ戻る)。
// 無効になるのは、対象が現在の曲に対するものでなくなった・
// キューから外れた・ラウンドの記録と矛盾する (やり直しを
// 伴わない抽選なのに既に再生済みになった) 場合。
function committedPlan() {
  const c = committedNext;
  if (!c) return null;
  const cur = currentEpisode.value;
  const next = cur && c.forId === cur.id
    ? playQueue.value.find((a) => a.id === c.id)
    : null;
  if (!next || next.id === cur.id || (!c.resetPlayed && playedInRound.has(c.id))) {
    committedNext = null;
    return null;
  }
  return { type: 'advance', id: c.id, resetPlayed: c.resetPlayed };
}

// 待機側の先読みを破棄する (待機要素を空に戻す)。
function discardPreload() {
  resetPreloadState();
  const standby = existingStandby();
  if (!standby) return;
  unloadDeck(standby);
}

/* ---- 待機側の無音保証 (二重再生の監視) ----
   待機側は先読み専用で、再生されることは設計上ない。play() の
   呼び出しはアクティブ側 (audio) へしか行かず、役割交代では
   旧要素を必ず止める作りだが、実機で待機側が鳴って二重再生に
   なる例が確認された (2026-11-18、Nin-Nin-Ninja の再生中に
   先読みされていた次曲が重なった。アクティブ側の再生・遷移は
   ログ上すべて正常で、診断イベントも無かった)。アプリの経路
   では説明が付かず、ブラウザ側で保留されていた再生要求が、
   役割交代後の待機側への読み込みで効いた等の競合が疑われる。
   原因の如何によらず「同時に鳴るのは常に1要素だけ」を保証
   するため、待機側が再生状態にあるのを見つけたら、その場で
   止めて deck_overlap として残す。呼び出しは、再生中の
   タイマー tick・フォアグラウンド復帰・本人の停止操作・
   先読みの張り替えの各地点から (止めたことは、本人の停止が
   両要素に届く保証にもなる)。報告は、同じ武装 (対象と URL)
   につき1回までに抑える。戻り値は「鳴っていたので止めた」か。 */
let standbyGhostReportedKey = '';

function silenceStandbyDeck() {
  const standby = existingStandby();
  if (!standby) return false;
  if (standby.paused || standby.ended) {
    standbyGhostReportedKey = '';
    return false;
  }
  standby.pause();
  const key = `${preloadId || ''}:${standby.src || ''}`;
  if (standbyGhostReportedKey !== key) {
    standbyGhostReportedKey = key;
    const ghost = preloadId !== null
      ? state.value.articles.find((a) => a.id === preloadId)
      : currentEpisode.value;
    queueDiagEvent('deck_overlap', ghost, Math.floor(standby.currentTime || 0));
  }
  return true;
}

// 'playing' と timeupdate から呼ばれる。対象が変わっていたら
// 待機側へ張り替え、対象が無くなったら破棄する。先読みの開始
// タイミングは呼び出し側 (再生が始まった時点) が決める。
function updatePreload() {
  const target = preloadTarget();
  if (!target) {
    if (preloadId !== null) discardPreload();
    return;
  }
  if (preloadId === target.id) return;
  const standby = standbyDeck();
  // 張り替える前に、待機側が鳴っていたら止める (二重再生の
  // 監視。診断の文脈は張り替え前の対象のままにする)。
  silenceStandbyDeck();
  preloadId = target.id;
  preloadFailed = false;
  preloadRetriedId = null;
  standby.preload = 'auto';
  standby.src = target.audioUrl;
}

// 待機側 (先読み) の読み込みエラー。本体には波及させない。エラー
// になったのは現在の読み込みの試行で、URL 自体が死んでいるとは
// 限らない (中継や回線の一時的な失敗、ブラウザが先読みの取得を
// 途中で止めるなど)。初回のエラーでは、まずその場で同じ URL を
// 読み直して試行を作り直し、作り直した試行については印を下ろす。
// 非同期の URL 再解決 (refreshPreloadUrl) の完了を待たないと
// 役割交代できない形だと、前の曲が短いときに再解決が終わり切ら
// ず、遷移が従来経路へ倒れて無音の隙間で止まる (実機で前曲
// 121秒・61秒のときに遷移失敗、前曲が長いときは成功を確認)。
// 作り直した試行もエラーになった場合は印を立てたままにし、
// 再解決でも回復しなければ遷移時はアクティブ側へ読み込む
// 従来経路に倒れる (loadEpisode)。
function handlePreloadError(el) {
  if (el !== existingStandby() || preloadId === null || preloadFailed) return;
  // 診断: 先読みでエラーが起きたことを、先読み先の曲の文脈で残す。
  queueDiagEvent('preload_error', state.value.articles.find((a) => a.id === preloadId));
  preloadFailed = true;
  const id = preloadId;
  if (preloadRetriedId === id) return;
  preloadRetriedId = id;
  // その場で同じ URL を読み直して試行を作り直す。作り直した
  // 試行はまだエラーではないので、印はここで下ろす (遷移時の
  // 役割交代は、この印ではなく現在の試行の状態で決まる)。
  el.load();
  preloadFailed = false;
  refreshPreloadUrl(id);
}

// 先読み対象のフィードを取り直して新鮮な URL を引き、待機側へ
// 張り直す。stale なエピソードの開始時 (startStaleEpisode) と
// 同じ経路。失効した YouTube の URL が、先読みを始めた時点で
// 既に死んでいるケースの手当て。
async function refreshPreloadUrl(id) {
  try {
    const article = state.value.articles.find((a) => a.id === id);
    const feed = article && state.value.feeds.find((f) => f.id === article.feedId);
    if (!feed) return;
    const result = await fetchOneFeed(feed);
    if (!result.ok) return;
    await ingestFeedArticles(result.feed, result.entries, new Date().toISOString(), null);
    await reloadLocal();
    // 取り直している間に遷移・対象変更が起きていたら触らない。
    if (preloadId !== id) return;
    const fresh = state.value.articles.find((a) => a.id === id);
    if (!fresh || !fresh.audioUrl) return;
    const standby = standbyDeck();
    // その場で読み直した試行が生きていて URL も同じなら、張り
    // 替えると読み込みが最初からやり直しになるので触らない。
    // 試行がエラーになっているか URL が変わったときだけ張り替える。
    if (!preloadFailed && standby.src === fresh.audioUrl) return;
    preloadFailed = false;
    standby.src = fresh.audioUrl;
  } catch {
    // 再解決できなくても、その場で読み直した試行が生きていれば
    // 遷移は役割交代で進む。試行もエラーになっていれば
    // preloadFailed のまま (遷移時に通常経路)。
  }
}

const speedLabel = computed(() => `${speed.value}×`);

function isCurrentEpisode(article) {
  return !!currentEpisode.value && currentEpisode.value.id === article.id;
}

// play() の拒否理由 (エラーの name) を診断イベントの種別へ
// 対応づける。events 側に自由文の欄が無いため、理由は種別で
// 区別する (reader-gas の EVENT_TYPES と対)。
function playRejectionEventType(err) {
  if (err && err.name === 'NotAllowedError') return 'play_rejected_not_allowed';
  if (err && err.name === 'NotSupportedError') return 'play_rejected_not_supported';
  return 'play_rejected_other';
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
        // 既に別のエピソードへ切り替わっていたら、今の曲の
        // 失敗として扱わない。
        if (!currentEpisode.value || currentEpisode.value.id !== epId) return;
        // 診断: play() がなぜ拒否されたかを理由つきで残す
        // (次に同じ止まり方が起きたとき、原因を確定するため)。
        queueDiagEvent(playRejectionEventType(err), currentEpisode.value);
        // 再生がブロックされただけの拒否 (バックグラウンドでの
        // 自動送り等) は、そのエピソードが壊れているわけでは
        // ない。失敗として送らず、その場で開始チェックを1段
        // 進める (再発行→フォールバックの連鎖は
        // checkStartWatchdog 側)。ウォッチドッグが武装して
        // いない文脈 (本人の再開操作等) では何も起きず、従来
        // どおり再生の意思だけが残る (フォアグラウンド復帰時
        // の回復で再生し直す)。
        if (err && err.name === 'NotAllowedError') {
          checkStartWatchdog(true);
          return;
        }
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
      // ロック画面等からの明示的な一時停止も、本人の意思による
      // 一時停止として扱う。
      pausePlayback();
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
// diagAdvance は「曲の終了で次へ進む」遷移のときだけ立て、遷移の
// 内訳 (役割交代か従来経路か) を診断ログへ残すために使う。それ
// 以外の開始 (本人の選択・失敗時の送り・前へ／次へ) では残さない。
function loadEpisode(article, { resume = true, diagAdvance = false } = {}) {
  // 渡された記事は描画時点 (またはキュー固定時点) の控えで、その後の
  // 更新で durationSec / audioUrl が埋まっても古いままのことがある。
  // 開始時に状態側の最新を id で引き直し、見つからなければ渡された
  // ものをそのまま使う。
  const ep = state.value.articles.find((a) => a.id === article.id) || article;
  // 二重バッファの役割交代ができるか: 待機側がこのエピソードを
  // 先読み対象にしていて、現在の読み込みの試行がエラーになって
  // おらず、URL が開始時点の最新と一致するときに、待機側をその
  // ままアクティブへ昇格させる。読み込みの完了は条件にしない
  // (途中の要素でも、昇格後の play() で取得が続き、再生しながら
  // 残りを読み込めるため)。それ以外は先読みを破棄し、従来どおり
  // アクティブ側へ URL を載せ直す。
  const standby = existingStandby();
  const swap = !!standby && preloadId === ep.id && !preloadFailed && !!ep.audioUrl
    && standby.src === ep.audioUrl;
  if (!swap) discardPreload();
  savePlayPos();
  // 視聴ログ: 前のエピソードの再生時間は、切り替えの前に確定だけ
  // しておく (新しい曲の再生区間を確定に巻き込まないため)。確定
  // したイベントの送信と、計測対象の差し替えは再生開始の後に行う。
  const pendingListen = finalizePlayListen();
  let oldDeck = null;
  if (swap) {
    oldDeck = audio;
    audio = standby;
    resetPreloadState();
  }
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
  if (swap) {
    audio.playbackRate = speed.value;
    // 先読み側は 'loadedmetadata' を既に (待機側として) 受けて
    // いて、昇格後には再び来ないため、メタデータ由来の初期化
    // (長さの反映と再開位置の復元) はここで済ませる。メタデータ
    // がまだなら、昇格後の 'loadedmetadata' が拾う。
    if (Number.isFinite(audio.duration)) applyDeckMetadata(audio);
    // 切り替わりでは保存位置を使わず頭から (メタデータ未着で
    // 復元が走らなかった場合も含め、要素側の位置を 0 に揃える)。
    if (!resume) audio.currentTime = 0;
  } else {
    audio.src = ep.audioUrl;
    audio.playbackRate = speed.value;
  }
  updateMediaSession(ep);
  if (oldDeck) {
    // 旧要素は待機側になる。再生開始 (play()) を出す前に一度
    // 止めておく (play() と pause() はどちらも非同期に効くため、
    // 先に止めておかないと旧要素が鳴り続ける窓ができる)。
    // 同期的な pause() は、再生開始の前に非同期処理を挟まない
    // 原則 (PR #109) には当たらない。再生開始の後でもう一度
    // 止めて空に戻す (従来どおり)。
    oldDeck.pause();
  }
  tryPlayAudio();
  // 開始ウォッチドッグをこの読み込みで武装する (開始が確認
  // できたら 'playing' で解除される)。play() の拒否は
  // マイクロタスクで届くため、この同期的な武装が先に済む。
  startWatchdog.arm(performance.now());
  startWatchdogSeq = episodeLoadSeq;
  // 回線切り替わりの印は前の曲へのものなので持ち越さない。
  routeReloadGuard.clear();
  if (oldDeck) {
    // 旧要素から遅れて来るイベントは、リスナー側のガード
    // (アクティブでない要素は無視) で状態へ響かない。
    oldDeck.pause();
    unloadDeck(oldDeck);
  }
  // 診断: 曲の終了で次へ進んだ場合だけ、遷移の内訳を次の曲の
  // 文脈で残す。キューヘの push のみで、送信 (fetch) は直後の
  // sendPlayListen の flush から始まる (play() より前に送信は
  // 始まらない)。
  if (diagAdvance) queueDiagEvent(swap ? 'advance_swap' : 'advance_load', ep);
  // 視聴ログ: 確定済みイベントの送信と、計測対象の新しいエピソード
  // への差し替えは、再生開始を出した後に行う。終了経路では、曲間
  // の無音の隙間にページが凍結されうるため、イベント送信 (fetch)
  // の開始を play() の前に挟まない。
  sendPlayListen(pendingListen);
  listenTracker.setContext({
    id: ep.id,
    feedId: ep.feedId,
    feedTitle: ep.feedTitle || feedTitleOf(ep.feedId),
    title: ep.title || '',
  });
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
// (自動送り・失敗時の送りに共通の規則)。diagAdvance は終了経由の
// 送り (handleEpisodeEnded) だけが立て、loadEpisode へそのまま
// 渡す (失敗時の送りでは立てない)。
function loadPlannedNext(plan, { diagAdvance = false } = {}) {
  if (!plan || plan.type !== 'advance') return false;
  const next = playQueue.value.find((a) => a.id === plan.id);
  if (!next) return false;
  if (plan.resetPlayed) playedInRound = new Set();
  playedInRound.add(next.id);
  loadEpisode(next, { resume: false, diagAdvance });
  return true;
}

function toggleShuffle() {
  shuffleOn.value = !shuffleOn.value;
  savePlayMode({ shuffle: shuffleOn.value, repeat: repeatMode.value });
  // ランダムの先読みの確定は、モードが変わったら破棄する
  // (オフにしたらリスト順の次曲が正になり、オンにしたら
  // 数え直したラウンドで抽選し直す)。
  committedNext = null;
  // blog と同じく、切り替えたら再生中の曲からラウンドを数え直す。
  playedInRound = new Set(currentEpisode.value ? [currentEpisode.value.id] : []);
}

function cycleRepeat() {
  repeatMode.value = nextRepeat(repeatMode.value);
  savePlayMode({ shuffle: shuffleOn.value, repeat: repeatMode.value });
}

// 本人の意思による一時停止 (プレイヤーのボタンと Media Session
// の pause で共通)。再生の意思を下ろし (フォアグラウンド復帰時に
// 勝手に再開しないため)、アクティブ側を止め、待機側が鳴って
// いたら一緒に止める (本人の停止が両要素に届く保証。二重再生
// の監視)。
function pausePlayback() {
  playWanted = false;
  // 本人の意思で止めたので、開始チェックはここで畳む
  // (checkStartWatchdog の playWanted ガードと二重の備え)。
  startWatchdog.disarm();
  // 回線切り替わりの印も畳む (再開直後に遅れて読み直さない)。
  routeReloadGuard.clear();
  audio.pause();
  silenceStandbyDeck();
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
    pausePlayback();
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
  // ランダムで先読みの確定が生きていれば、「次へ」はその確定曲
  // へ進む (先読み済みの待機側をそのまま使える)。「前へ」は
  // 従来どおり履歴をたどる。
  if (delta > 0 && shuffleOn.value) {
    const committed = committedPlan();
    if (committed && loadPlannedNext(committed)) {
      consecutivePlayFailures = 0;
      return;
    }
  }
  const plan = skipPlan({
    queue: queueIds(),
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

// 表示スケールの位置へシークする (補正が効いている曲では要素の
// スケールへ変換してから渡す)。スキップとシークバーで共通に使う。
// 変換を挟んだ窓は実測モデルのサンプルとして使えないため捨てる。
function seekToDisplayPosition(displayPos) {
  audio.currentTime = toElementPosition(displayPos, mappingCtx.value);
  currentTime.value = audio.currentTime;
  rateSample = null;
}

function skipBy(delta) {
  if (!currentEpisode.value) return;
  if (mappingOn.value) {
    // スキップ量は表示 (正しい長さ) 基準で解釈し、要素へ戻して渡す。
    seekToDisplayPosition(clampSeek(displayTime.value + delta, displayDuration.value));
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
    seekToDisplayPosition(value);
    return;
  }
  currentTime.value = value;
  audio.currentTime = clampSeek(value, Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : displayDuration.value);
}

function stopPlayer() {
  playWanted = false;
  startWatchdog.disarm();
  routeReloadGuard.clear();
  // 待機側が鳴っていたら一緒に止める (本人の停止が両要素に
  // 届く保証。二重再生の監視)。先読みの文脈 (preloadId) が
  // 残っているうちに行い、診断は下の flush で一緒に送る。
  silenceStandbyDeck();
  savePlayPos();
  // 視聴ログ: プレイヤーを閉じるのが再生の終わりなので、積算した
  // 再生時間をここで確定して送る。
  flushPlayListen();
  flushEventLog();
  listenTracker.clear();
  stopEndCheckTimer();
  discardPreload();
  audio.pause();
  unloadDeck(audio);
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

// 要素のメタデータが読めたときの初期化 (長さの反映・速度・
// 再開位置の復元)。'loadedmetadata' イベントから呼ばれるほか、
// 先読み済み要素の役割交代 (loadEpisode) ではイベントが再び
// 来ないため、そちらからも直接呼ばれる。
function applyDeckMetadata(el) {
  duration.value = el.duration;
  el.playbackRate = speed.value;
  if (pendingSeek > 0) {
    // 保存値は正しい長さ基準。旧バージョンが要素スケールで保存した
    // 値は interpretStoredPlayPos で割り戻してから要素へ渡す。
    const ctx = mappingCtx.value;
    const restored = interpretStoredPlayPos(pendingSeek, ctx);
    el.currentTime = clampSeek(toElementPosition(restored, ctx), el.duration);
    currentTime.value = el.currentTime;
  }
  pendingSeek = 0;
}

// 要素に紐づく処理は、すべて「現在アクティブな要素」に対して
// だけ働く。2つの要素の両方へ同じリスナーを付け、各ハンドラの
// 冒頭でアクティブ側かどうかを確認する。待機側のイベントは、
// 先読みのエラー処理を除いて無視する (役割交代の前後で、旧要素
// から遅れて来る 'pause' や 'error' で状態を壊さないため)。
function attachDeckListeners(el) {
  el.addEventListener('loadedmetadata', () => {
    if (el !== audio) return;
    applyDeckMetadata(el);
  });
  el.addEventListener('timeupdate', () => {
    if (el !== audio) return;
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
  el.addEventListener('play', () => {
    if (el !== audio) return;
    isPlaying.value = true;
    // 視聴ログ: 再生区間を開く。
    listenTracker.start();
    // 再開のたびにストール計測をやり直す (一時停止を挟んだ窓で
    // 誤判定しないため)。
    stallTracker.reset(performance.now());
  });
  el.addEventListener('pause', () => {
    if (el !== audio) return;
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
  el.addEventListener('waiting', () => {
    if (el !== audio) return;
    isLoading.value = true;
  });
  el.addEventListener('seeking', () => {
    if (el !== audio) return;
    rateSample = null;
    if (audio.readyState < 3) isLoading.value = true;
  });
  el.addEventListener('seeked', () => {
    if (el !== audio) return;
    if (audio.readyState >= 3) isLoading.value = false;
    // シーク直後はストール計測をやり直す (猶予を持たせる)。
    stallTracker.reset(performance.now());
  });
  el.addEventListener('playing', () => {
    if (el !== audio) return;
    isLoading.value = false;
    // 実際に再生が始まったので、ここからストール検知の対象になる。
    episodePlayStarted = true;
    // 開始が確認できたので開始ウォッチドッグを解除し、この
    // 要素を「直前まで鳴っていた要素」として控える (開始に
    // 失敗したときのフォールバック先)。
    startWatchdog.disarm();
    lastPlayedDeck = el;
    // 再生が始まったら、待機側で次曲の先読みを開始する
    // (二重バッファ。再生中はページが生きている間に読み終える)。
    updatePreload();
  });
  el.addEventListener('canplay', () => {
    if (el !== audio) return;
    isLoading.value = false;
    // データが来たのにまだ開始していない場合の、開始チェックの
    // 実行機会 (タイマーが回らない状況でもイベントに連鎖させる)。
    checkStartWatchdog();
  });
  el.addEventListener('error', () => {
    if (el !== audio) {
      // 待機側のエラーは先読み側で処理し、本体へは波及させない。
      handlePreloadError(el);
      return;
    }
    isLoading.value = false;
    // 対象は要素に載っている当のURLへのエラーだけに限る
    // (src の差し替え・破棄に伴う遅れて来る error は失敗として
    // 扱わない)。実際の処理は共通の失敗処理へ集約する。
    if (!currentEpisode.value || !currentSrcUrl || audio.src !== currentSrcUrl) return;
    handlePlaybackFailure();
  });
  el.addEventListener('ended', () => {
    if (el === audio) handleEpisodeEnded();
  });
}
attachDeckListeners(deckA);
// 待機側 (deckB) のリスナーは、生成時 (standbyDeck) に付ける。

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
    queue: queueIds(),
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

// 聴き終えたエピソードの既読化だけを行う (単曲リピートでも、
// 既読化は冪等なので毎回通してよい)。視聴ログの article_open は
// 「記事を開いた操作」だけを数えるため、onOpenArticle は経由
// しない (play イベントは別に数える)。
function markEpisodeRead(ep) {
  const view = state.value.articles.find((a) => a.id === ep.id) || ep;
  if (isOwner.value && !view.isRead) applyRead(view, true);
}

function handleEpisodeEnded() {
  if (endFlowDone) return;
  endFlowDone = true;
  stopEndCheckTimer();
  isPlaying.value = false;
  isLoading.value = false;
  const ep = currentEpisode.value;
  if (!ep) return;
  currentTime.value = 0;
  // 次曲の再生開始を何よりも先に出す。バックグラウンドでは曲間の
  // 無音の隙間にページが凍結されうるため、後処理 (既読化・再生
  // 位置のクリア・視聴ログ送信) を先に済ませようとすると、その
  // 途中で止まって次曲が始まらないことがある (実機で、終了フロー
  // 自体は実行され視聴ログも終端時刻で確定していたのに、次曲が
  // 始まらなかった例を確認)。後処理は再生開始の後に回す。
  if (repeatMode.value === 'one') {
    // 視聴ログ: 1周分の再生時間は再開の前に確定だけしておき
    // (計測対象は同じ曲のまま次の周を数え直す)、送信は再開の後に
    // 回す。
    const pendingListen = finalizePlayListen();
    // 単曲リピート: src は差し替えず先頭から再生し直す。再開位置
    // (pendingSeek は metadata 読み込み時だけ効く) とは競合しない。
    audio.currentTime = 0;
    endFlowDone = false;
    tryPlayAudio();
    sendPlayListen(pendingListen);
    markEpisodeRead(ep);
    clearPlayPos(ep.id);
    return;
  }
  // ランダムで先読みの確定 (committedNext) が生きていれば、
  // 抽選し直さずその確定曲へ進む (先読み済みの待機側と遷移先を
  // 一致させ、役割交代で進めるため)。確定が無ければ従来どおり
  // 遷移時に抽選する。
  const plan = (shuffleOn.value ? committedPlan() : null) || nextEpisodePlan({
    queue: queueIds(),
    currentId: ep.id,
    repeat: repeatMode.value,
    shuffle: shuffleOn.value,
    playedIds: playedInRound,
  });
  // 次へ進む場合は loadEpisode 側で再生時間を確定する。進まずに
  // 止まる場合は、ここが再生の終わりなので確定して送る (再生の
  // 意思もここで下ろす。フォアグラウンド復帰時の回復で、末尾で
  // 止まった状態を勝手に再生し直さないため)。
  if (!loadPlannedNext(plan, { diagAdvance: true })) {
    playWanted = false;
    flushPlayListen();
  }
  markEpisodeRead(ep);
  clearPlayPos(ep.id);
}
// フォアグラウンドへ戻ったときの再生回復。バックグラウンドで
// タイマーが止まりページが suspend / freeze されると、その間に
// 曲が終わっても次曲への進行が起きず、自動送りの play() が
// 保留・拒否されたまま固まることがある (実機で「開くと次の曲が
// 始まる」症状を確認)。復帰した時点で、再生の意思があるのに
// 止まっている状態なら、その場で進行・再開する。判定は
// player.js の foregroundRecoveryAction、本人が一時停止した
// 場合は playWanted が下りているので何もしない。
function recoverPlaybackOnForeground() {
  // 待機側が鳴っていたら、回復の判定より先に止める (二重再生の
  // 監視)。本人が止めた状態で復帰したときも、待機側だけは
  // ここで確実に黙らせる (回復の判定は playWanted で閉じて
  // いるが、待機側の再生はその対象外だった)。
  const ghostSilenced = silenceStandbyDeck();
  const stuck = currentEpisode.value;
  const action = foregroundRecoveryAction({
    hasEpisode: !!currentEpisode.value,
    playWanted,
    ended: audio.ended,
    endFlowDone,
    paused: audio.paused,
    reachedEnd: !!currentEpisode.value && reachedEndNow(),
  });
  if (action === 'advance') handleEpisodeEnded();
  else if (action === 'resume') tryPlayAudio();
  else {
    // 回復が何もしなくても、待機側を止めた診断だけは送る。
    if (ghostSilenced) flushEventLog();
    return;
  }
  // 診断: 回復が実際に再開・前進させたことを、止まっていた曲の
  // 文脈で残す。復帰時はフォアグラウンドなのでその場で送り、
  // バックグラウンドの間にキューへ残っていた診断分も一緒に届ける。
  queueDiagEvent('recover', stuck);
  flushEventLog();
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

// クリップボードへコピーし、成否を返す。コピーできない環境では
// false になり、呼び出し側はフィードバックを出さない。
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyShareUrl() {
  if (!shareUrl.value) return;
  // コピーできない環境では、入力欄の URL を手でコピーしてもらう
  // (入力欄はタップで全選択される)。
  shareCopied.value = await copyTextToClipboard(shareUrl.value);
}

// 記事カードのリンクコピー。元リンクをクリップボードへ入れ、
// 成功した記事のボタンだけ短時間チェック表示にする。コピーできない
// 環境ではフィードバックを出さない (copyShareUrl と同じ流儀)。
async function copyArticleLink(article) {
  if (!article.link) return;
  if (!(await copyTextToClipboard(article.link))) return;
  copiedArticleId.value = article.id;
  if (copiedArticleTimer) clearTimeout(copiedArticleTimer);
  copiedArticleTimer = setTimeout(() => {
    copiedArticleId.value = '';
  }, 1600);
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
  loadFeedStats();
}

// 利用状況の取得に失敗しても管理画面はそのまま使えるよう、失敗時は
// 行を出さない (未取得のままにする)。セッション切れだけは共通処理へ。
async function loadFeedStats() {
  if (!session.value || !isOwner.value) return;
  try {
    const payload = await getFeedStats(session.value.token);
    feedStats.value = payload && payload.stats ? payload.stats : {};
  } catch (e) {
    expireIfUnauthorized(e);
  }
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

// 管理で保存したフィードのジャンルと並び順と削除同期と
// スター選定と過去分ガードを、タイムライン側の共有状態
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
  const patch = (feeds) => patchFeedAttrs(feeds, id, {
    category: payload.category,
    sortDirection: payload.sortDirection,
    syncDeletes: payload.syncDeletes,
    starMode: payload.starMode,
    starCount: payload.starCount,
    starMinSec: payload.starMinSec,
    pastGuard: payload.pastGuard,
  });
  state.value = { ...state.value, feeds: patch(state.value.feeds) };
  const cached = await loadLocalFeeds();
  if (cached.some((f) => f.id === id)) {
    await saveLocalFeeds(patch(cached));
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

// 削除ボタンの入口。YouTube チャンネルフィードは購読同期が正で
// リーダー側では消せないため、チャンネルページを新しいタブで開き、
// 解除は YouTube 側で行ってもらう (解除されれば次の同期でリーダー
// からも消える)。それ以外は通常の削除確認へ進む。
function onDeleteButton(feed) {
  const channelId = youtubeChannelIdFromUrl(feed.url);
  if (channelId) {
    window.open(`https://www.youtube.com/channel/${channelId}`, '_blank', 'noopener');
    return;
  }
  askDeleteFeed(feed);
}

function cancelDeleteFeed() {
  confirmDeleteId.value = '';
}

// 削除が確定したフィードを管理一覧から落とす (削除の成功時と、
// 既に消えていた場合で共通)。保存と同じ目印 (adminFeedsDirty) も
// 立てる: 削除前に始まった背景更新が実行中にタイムラインへ戻ると、
// その更新が削除前の一覧で完了して削除したフィードと記事が
// ローカルに残るため、戻る際の追随更新で揃え直す。
function removeFeedFromAdminList(feed) {
  adminFeedsDirty = true;
  mgmtFeeds.value = mgmtFeeds.value.filter((f) => f.id !== feed.id);
  confirmDeleteId.value = '';
}

async function onDeleteFeed(feed) {
  if (mgmtSavingId.value) return;
  mgmtSavingId.value = feed.id;
  try {
    await deleteFeed(session.value.token, feed.id);
    removeFeedFromAdminList(feed);
    if (formMode.value === 'edit' && formBase.value?.id === feed.id) {
      closeForm();
      restoreFormScroll();
    }
    mgmtError.value = '';
  } catch (e) {
    if (expireIfUnauthorized(e)) {
      // セッション失効は共通処理へ倒した。
    } else if (e.message === 'not_found') {
      // 既に消えていた場合は一覧からも落として整合させる。
      removeFeedFromAdminList(feed);
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
  // 編集はジャンルと並び順だけ (ID・タイトル・URL は変更できない)。
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
  // YouTube (疑似フィード・チャンネルページ・@ハンドル・プレイリスト)
  // は直接読めないため取得を省き、タイトル '' で保存する (URL の
  // 正規形への解決とタイトル補完はサーバーが行う。プレイリスト URL の
  // 正規化は buildSaveFeedPayload が行う)。
  const addMode = planFeedAdd(form.value).mode;
  if (addMode === 'youtube' || addMode === 'playlist') {
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

// 回線の切り替わり (Wi-Fi ⇔ モバイル回線等) の検知。'offline'
// で印を立て、'online' で戻ったことを確認して読み直しを試す
// (attemptRouteReload)。回線イベント自体も診断に残し、無音化
// との相関を後から検証できるようにする (対象はその時点で
// 再生中の曲。曲が無ければ queueDiagEvent 側で捨てられる)。
function onRouteOffline() {
  routeReloadGuard.note(performance.now());
  queueDiagEvent('route_offline', currentEpisode.value);
}

function onRouteOnline() {
  routeReloadGuard.note(performance.now());
  queueDiagEvent('route_online', currentEpisode.value);
  attemptRouteReload();
}

window.addEventListener('offline', onRouteOffline);
window.addEventListener('online', onRouteOnline);
onUnmounted(() => {
  window.removeEventListener('offline', onRouteOffline);
  window.removeEventListener('online', onRouteOnline);
});

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
  // Web フォントの読み込みで要約の行数やチップの折り返しが変わるため、確定後に測り直す。
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      scheduleMeasureSummaries();
      scheduleMeasureFeedChips();
    });
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
        <div
          class="feed-chips"
          :class="{ 'is-collapsed': !feedChipsExpanded }"
          :ref="registerFeedChipsEl"
          role="tablist"
          aria-label="フィードで絞り込み"
        >
          <button
            v-for="f in chipFeeds"
            :key="f.id"
            type="button"
            class="chip"
            :class="{ active: state.feedId === f.id }"
            @click="setFeed(f.id)"
          >{{ feedDisplayName(f) }}<span v-if="f.unreadCount > 0" class="chip-count">{{ f.unreadCount }}</span></button>
        </div>
        <button
          v-if="feedChipsOverflow"
          type="button"
          class="chips-toggle"
          :aria-expanded="feedChipsExpanded ? 'true' : 'false'"
          @click="toggleFeedChips"
        >{{ feedChipsExpanded ? '閉じる' : 'すべて表示' }}</button>

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
            :data-article-id="a.id"
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
              v-if="a.summary || a.content"
              :ref="(el) => registerSummaryEl(a.id, el)"
              class="article-summary"
              :class="{ expanded: expandedSummaryIds.has(a.id) }"
            >{{ summaryDisplayText(a) }}</p>
            <button
              v-if="(a.summary || a.content) && (expandedSummaryIds.has(a.id) || clampedSummaryIds.has(a.id) || hasLongContent(a))"
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
              <a
                class="share-btn"
                :href="buildXShareUrl(a.title, a.link)"
                target="_blank"
                rel="noopener"
                aria-label="Xで共有"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" /></svg>
              </a>
              <a
                class="share-btn"
                :href="buildFacebookShareUrl(a.link)"
                target="_blank"
                rel="noopener"
                aria-label="Facebookで共有"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" /></svg>
              </a>
              <a
                class="share-btn"
                :href="buildThreadsShareUrl(a.title, a.link)"
                target="_blank"
                rel="noopener"
                aria-label="Threadsで共有"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z" /></svg>
              </a>
              <button
                type="button"
                class="share-btn"
                :class="{ 'is-copied': copiedArticleId === a.id }"
                :aria-label="copiedArticleId === a.id ? 'コピーしました' : 'リンクをコピー'"
                @click="copyArticleLink(a)"
              >
                <svg v-if="copiedArticleId === a.id" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" /></svg>
              </button>
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
              <p class="field-note">タイトルはフィードから自動で取得します。YouTube はチャンネルやプレイリストの URL でも登録できます。</p>
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
            <div class="field">
              <label for="feed-sort-direction">並び順</label>
              <select id="feed-sort-direction" v-model="form.sortDirection">
                <option value="desc">新しい順（上が最新）</option>
                <option value="asc">古い順（上が最古）</option>
              </select>
              <p class="field-note">フィード単体で開いたときの記事の並びです。予定のように日時順に読みたいフィードは「古い順」が向いています。</p>
            </div>
            <div v-if="!youtubeChannelIdFromUrl(form.url) && !youtubePlaylistIdFromUrl(form.url)" class="field">
              <label class="checkbox-field">
                <input id="feed-sync-deletes" v-model="form.syncDeletes" type="checkbox" />
                フィードから消えた記事を端末からも消す（削除同期）
              </label>
              <p class="field-note">更新のたびに、フィードに載っていない記事を削除します。予定のように、配信から外れたら消えてよいフィード向けです。</p>
            </div>
            <div v-if="youtubeChannelIdFromUrl(form.url) || youtubePlaylistIdFromUrl(form.url)" class="field">
              <label for="feed-star-mode">スター選定（再生対象）</label>
              <select id="feed-star-mode" v-model="form.starMode">
                <option value="">自動（種別ごとの既定）</option>
                <option value="none">なし</option>
                <option value="recent">新しい順</option>
                <option value="all">全件</option>
              </select>
              <p class="field-note">自動でスターが付く動画の選び方です。自動の既定は、チャンネルは新しい順{{ STAR_DEFAULT_COUNT }}本、プレイリストと本人のチャンネルは全件です。手動で付け外ししたスターは、この設定より優先されます。</p>
            </div>
            <div v-if="(youtubeChannelIdFromUrl(form.url) || youtubePlaylistIdFromUrl(form.url)) && formStarMode === 'recent'" class="field">
              <label for="feed-star-count">本数（新しい順）</label>
              <input
                id="feed-star-count"
                v-model="form.starCount"
                type="number"
                min="1"
                max="100"
                inputmode="numeric"
                :placeholder="String(STAR_DEFAULT_COUNT)"
              />
            </div>
            <div v-if="(youtubeChannelIdFromUrl(form.url) || youtubePlaylistIdFromUrl(form.url)) && formStarMode === 'recent'" class="field">
              <label for="feed-star-min-sec">短尺除外の下限（秒）</label>
              <input
                id="feed-star-min-sec"
                v-model="form.starMinSec"
                type="number"
                min="0"
                max="3600"
                inputmode="numeric"
                :placeholder="String(STAR_DEFAULT_MIN_SEC)"
              />
              <p class="field-note">これより短いと分かっている動画は本数に数えません。空欄は既定の{{ STAR_DEFAULT_MIN_SEC }}秒、0で除外なしになります。</p>
            </div>
            <div class="field">
              <label for="feed-past-guard">過去分の扱い</label>
              <select id="feed-past-guard" v-model="form.pastGuard">
                <option value="">自動（種別ごとの既定）</option>
                <option value="skip">取り込まない</option>
                <option value="read">既読として取り込む</option>
                <option value="off">未読として取り込む（ガードなし）</option>
              </select>
              <p class="field-note">公開から60日を過ぎた記事を、まだ端末に無いときにどう取り込むかです。自動の既定は、通常のフィードは「取り込まない」、YouTubeは「既読として取り込む」です。</p>
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
              <p v-if="feedStats" class="feed-usage">{{ formatFeedUsage(feedStats[f.id]) }}</p>
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
              <!-- 編集・削除はカード下段の専用行に置く (カード本体の
                   フレックス行の最後の要素で、全幅に折り返す)。削除
                   確認が出ている間は隠す (確認のボタンは本体側に出る)。
                   YouTube チャンネルフィードも見た目は他のフィードと
                   揃えて削除ボタンを出すが、追加・解除は YouTube 側が
                   正 (購読同期) のため、押したときの動作だけが違い、
                   チャンネルページを開く (onDeleteButton)。ジャンル
                   だけはリーダー側が正 (購読同期は既存行のジャンルに
                   は触れない) なので、編集は通常どおり出す。判定は
                   チャンネル ID が取れるかで、プレイリストフィードは
                   購読同期の対象外のため通常の削除確認へ進む。 -->
              <div v-if="confirmDeleteId !== f.id" class="feed-actions feed-card-actions">
                <button class="ghost" type="button" @click="startEditFeed(f)">編集</button>
                <button class="ghost danger" type="button" @click="onDeleteButton(f)">削除</button>
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

        </template>
      </template>

      <div v-if="currentEpisode" class="player-bar">
        <div class="player-now">
          <button type="button" class="player-jump" title="再生中の記事を表示" aria-label="再生中の記事を表示" @click="jumpToCurrentArticle">
            <span class="player-title">{{ currentEpisode.title }}</span>
            <span v-if="currentEpisode.feedTitle" class="player-feed">{{ currentEpisode.feedTitle }}</span>
          </button>
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
