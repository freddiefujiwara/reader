<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { API_URL, GOOGLE_CLIENT_ID } from './config.js';
import {
  deleteFeed,
  exchangeSession,
  exchangeShare,
  listArticles,
  listFeeds,
  reorderFeeds,
  saveFeed,
} from './lib/api.js';
import {
  buildSaveFeedPayload,
  createFeedForm,
  feedFormFromFeed,
  filterAdminFeeds,
  formatFeedStatus,
  moveFeedOrder,
  createOrderSender,
  planFeedAdd,
  resolveFeedAddForm,
  validateFeedUrl,
} from './lib/feedAdmin.js';
import { clearSession, loadSession, saveSession } from './lib/session.js';
import {
  createListState,
  feedCategories,
  feedDisplayName,
  markAllReadInList,
  markAllReadScope,
  patchArticle,
  sortArticlesDesc,
  visibleArticles,
  visibleFeedChips,
  withUnreadCounts,
} from './lib/listState.js';
import {
  FEED_HASH_TRANSFER_KEY,
  articleRecordToView,
  clearLocalArticlePlayPos,
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
  setLocalMeta,
} from './lib/localDb.js';
import { normalizeFeedIds } from './lib/feedHash.js';
import { fetchAllFeeds, fetchFeedXml } from './lib/feedFetch.js';
import { formatPublishedAt } from './lib/format.js';
import {
  buildQueue,
  clampSeek,
  classifyRate,
  durationMismatch,
  formatTime,
  interpretStoredPlayPos,
  isWithinEndGuard,
  loadPlayMode,
  loadTimeModel,
  nextEpisodePlan,
  nextRepeat,
  nextSpeed,
  progressRatio,
  reachedKnownDurationEnd,
  skipPlan,
  END_CHECK_INTERVAL_MS,
  PRELOAD_REMAINING_SEC,
  REPEAT_LABELS,
  savePlayMode,
  saveTimeModel,
  toDisplayPosition,
  toElementPosition,
} from './lib/player.js';

// 画面に出す件数の初期値と「もっと見る」の増分 (v2 は全件ローカルにあるため、
// サーバー取得ではなく表示ウィンドウを広げるだけ)。
const DISPLAY_LIMIT = 50;
// 既読の初回取り込みでサーバーから受け取る上限 (保持上限と同じ)。
const IMPORT_LIMIT = 5000;
const year = new Date().getFullYear();

const session = ref(loadSession());
const bootError = ref('');
// 起動中 (セッション復元・共有リンク交換) とサインイン交換中は
// ログインボタンを出さず「サインインしています…」にする (戻ってきた直後に
// ボタンが見えて未ログインと誤解されるのを防ぐ)。
const booting = ref(true);
const signingIn = ref(false);
const loading = ref(true);
const refreshing = ref(false);
const listError = ref('');
const displayLimit = ref(DISPLAY_LIMIT);
const state = ref(createListState());
const signinEl = ref(null);

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
const formMode = ref(''); // '' | 'add' | 'edit'
const formEl = ref(null);
const form = ref(createFeedForm());
const formBase = ref(null);
const formError = ref('');
const formSaving = ref(false);
const formFetching = ref(false);

const isReadonly = computed(() => session.value?.role === 'readonly');
const isOwner = computed(() => session.value?.role === 'owner');
const visible = computed(() => visibleArticles(state.value));
const displayArticles = computed(() => visible.value.slice(0, displayLimit.value));
const unreadTotalCount = computed(() =>
  state.value.feeds.reduce((n, f) => n + (f.unreadCount || 0), 0)
);
const chipFeeds = computed(() => visibleFeedChips(state.value));
const categoryList = computed(() => feedCategories(state.value.feeds));
// 管理フォームのジャンル候補: 現在のフィード一覧にあるものを出現順に。
const genreOptions = computed(() => feedCategories(mgmtFeeds.value));
// 管理一覧の表示対象: 選択中のジャンルに合うフィードだけ。
const adminFeeds = computed(() => filterAdminFeeds(mgmtFeeds.value, adminCategory.value));
const hasMore = computed(() => visible.value.length > displayLimit.value);

const FILTERS = [
  { key: 'all', label: 'すべて' },
  { key: 'unread', label: '未読' },
];

/* ---- ローカル (IndexedDB) が表示の正本 ---- */

// DB の中身を state へ読み直す。未読数はローカルの記事から数える。
async function reloadLocal() {
  const [feeds, records] = await Promise.all([loadLocalFeeds(), loadLocalArticles()]);
  const titles = {};
  feeds.forEach((f) => { titles[f.id] = feedDisplayName(f); });
  const views = sortArticlesDesc(records.map((r) => articleRecordToView(r, titles[r.feed_id])));
  state.value = { ...state.value, feeds: withUnreadCounts(feeds, views), articles: views };
}

// 背景更新: (a) フィード一覧をサーバーから取り直し、(b) 全フィードを
// クライアントから取得して取り込む。失敗したフィードは前回の記事を残す。
// 実行中にもう一度呼ばれたら同じ Promise を返す (多重実行防止)。
let refreshInFlight = null;

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
    let listOk = false;
    const needImport = !(await getLocalMeta('statesImportedV2'));
    try {
      const payload = await listArticles(session.value.token, { limit: needImport ? IMPORT_LIMIT : 1 });
      if (Array.isArray(payload.feeds)) feeds = payload.feeds;
      if (needImport) importPayload = payload;
      listOk = true;
    } catch (e) {
      if (e.message === 'unauthorized') {
        expireSession();
        return;
      }
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

// 起動時: まずローカルを即座に出し、その後で背景更新する。
// ローカルが空の初回だけ、背景更新の完了まで読み込み表示を続ける。
async function initTimeline() {
  loading.value = true;
  try {
    await reloadLocal();
  } catch (e) {
    listError.value = `ローカルデータを読み込めませんでした（${e.message}）。`;
  }
  const firstRun = !state.value.articles.length && !state.value.feeds.length;
  if (!firstRun) loading.value = false;
  await refreshInBackground();
  loading.value = false;
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
  state.value = { ...state.value, feedId: next };
  displayLimit.value = DISPLAY_LIMIT;
}

function setCategory(category) {
  // 選択中のカテゴリを再タップしたら解除し、全件表示に戻す
  // (「すべて」チップは廃止し、トグル選択にした)。
  const next = state.value.category === category ? '' : category;
  if (next === state.value.category) return;
  // カテゴリを変えたらフィード選択は解除する (対象外フィードが残らないように)。
  state.value = { ...state.value, category: next, feedId: '' };
  displayLimit.value = DISPLAY_LIMIT;
}

function setFilter(filter) {
  if (state.value.filter === filter) return;
  state.value = { ...state.value, filter };
  displayLimit.value = DISPLAY_LIMIT;
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
  state.value = { ...state.value, feedId: '', category: '', filter: 'unread' };
  displayLimit.value = DISPLAY_LIMIT;
}

// ヘッダーのブランド: アプリ内のホームボタン。以前は href="./" の
// リンクだったため、タップするとフルリロードになり、読み込み済みの
// 記事・再生状態・スクロール位置がすべて失われていた。ここでは
// アプリ内でタイムラインへ戻し (管理画面からの場合は backToTimeline
// と同じ後処理も行う)、タイムライン表示中なら先頭へスクロールする。
async function goHome() {
  if (view.value !== 'timeline') {
    await backToTimeline();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 既読の付け外しはローカルのみ (サーバーへは送らない)。
async function applyRead(article, isRead) {
  if (!isOwner.value) return;
  const nextArticles = patchArticle(state.value.articles, article.id, { isRead });
  state.value = {
    ...state.value,
    articles: nextArticles,
    feeds: withUnreadCounts(state.value.feeds, nextArticles),
  };
  try {
    await setLocalArticleRead(article.id, isRead, new Date().toISOString());
  } catch (e) {
    listError.value = `保存できませんでした（${e.message}）。`;
  }
}

function onOpenArticle(article) {
  if (isOwner.value && !article.isRead) {
    // 元記事を開く操作は止めない。既読化はローカルに書くだけ。
    applyRead(article, true);
  }
}

async function onMarkAllRead() {
  if (!isOwner.value) return;
  // v1 と同じ範囲 (フィード指定が優先、次にカテゴリ、無ければ全体)。
  const scoped = markAllReadScope(state.value, state.value.feedId, state.value.category);
  const targetIds = state.value.articles
    .filter((a) => !a.isRead && scoped[a.feedId])
    .map((a) => a.id);
  state.value = markAllReadInList(state.value, state.value.feedId, state.value.category);
  try {
    await markLocalArticlesRead(targetIds, new Date().toISOString());
  } catch (e) {
    listError.value = `保存できませんでした（${e.message}）。`;
  }
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
   呼ぶ。再生開始はすべて tryPlayAudio に集約されているので、
   そこでタイマーを始め、stopPlayer と終了フローで確実に
   止める。 */
let endCheckTimer = null;

// 既知の長さへの到達判定。timeupdate とタイマーの tick の
// 両方から呼ばれる。位置は要素の現在値から変換して求める
// (終端で timeupdate が止まると、currentTime ref は最後の
// イベントの値のままになり、要素側だけが終端まで進んでいる
// ことがあるため)。到達していれば即座に終了フローへ進む
// ので、tick (0.5秒間隔) 経由でも到達から1秒以内に遷移する。
// 再生中かどうかの正はアプリ側の isPlaying で見る (要素が
// 終端で無言で paused になっても、アプリが再生中のつもり
// なら到達を判定する)。
function checkKnownDurationEnd() {
  if (!currentEpisode.value || !isPlaying.value || endFlowDone) return false;
  const pos = toDisplayPosition(audio.currentTime || 0, mappingCtx.value);
  if (!reachedKnownDurationEnd({
    displayPos: pos,
    trueSec: trueDuration.value,
    elementDuration: duration.value,
    hasMeasuredModel: !!measuredModel,
  })) return false;
  handleEpisodeEnded();
  return true;
}

function startEndCheckTimer() {
  stopEndCheckTimer();
  endCheckTimer = setInterval(checkKnownDurationEnd, END_CHECK_INTERVAL_MS);
}

function stopEndCheckTimer() {
  if (endCheckTimer !== null) {
    clearInterval(endCheckTimer);
    endCheckTimer = null;
  }
}

/* ---- 次の曲の先読み ----
   切り替え時点で初めて読み込みが始まると、回線が遅いときに遷移で
   長く待たされる。再生中の曲の残りが PRELOAD_REMAINING_SEC 以下に
   なったら、2つ目の要素で次の曲の読み込みを温めておく (本体は
   切り替え時に同じ URL を引くので、キャッシュが効いて開始が
   速くなる)。先読み要素のエラーは無視し、本体には波及させない。
   遷移・停止・エピソード変更では loadEpisode / stopPlayer が
   必ず破棄する。 */
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
  // 再生開始のたびに終端チェックのタイマーを張り直す
  // (loadEpisode・再開・単曲リピート・Media Session のいずれの
  // 経路でもここを通る)。
  startEndCheckTimer();
  try {
    const attempt = audio.play();
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
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
  if (isWithinEndGuard(pos, displayDuration.value)) {
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
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => skipBy(-15));
    navigator.mediaSession.setActionHandler('seekforward', () => skipBy(30));
    navigator.mediaSession.setActionHandler('previoustrack', () => skipByTrack(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => skipByTrack(1));
  } catch {
    // Media Session が使えない環境では何もしない。
  }
}

// エピソードを Audio 要素へ載せて再生する共通処理。キューは触らない。
function loadEpisode(article) {
  discardPreload();
  savePlayPos();
  // 渡された記事は描画時点 (またはキュー固定時点) の控えで、その後の
  // 更新で durationSec / audioUrl が埋まっても古いままのことがある。
  // 開始時に状態側の最新を id で引き直し、見つからなければ渡された
  // ものをそのまま使う。
  const ep = state.value.articles.find((a) => a.id === article.id) || article;
  currentEpisode.value = ep;
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
  pendingSeek = playPosMemory.has(ep.id) ? playPosMemory.get(ep.id) : (ep.playPos || 0);
  audio.src = ep.audioUrl;
  audio.playbackRate = speed.value;
  updateMediaSession(ep);
  tryPlayAudio();
}

// ユーザーがカードから選んだとき: その時点の表示リスト (ジャンル・
// チャンネル・既読状態の絞り込み適用後) の音声つき記事を、フィードを
// 問わずキューとして固定し、ラウンドを数え直してから再生する。
// 以後の自動送りはこのキューに対して行う。
function startEpisode(article) {
  playQueue.value = buildQueue(visible.value, article);
  playedInRound = new Set([article.id]);
  playHistory = [];
  loadEpisode(article);
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
    audio.pause();
  }
}

function toggleEpisode(article) {
  if (isCurrentEpisode(article)) togglePlay();
  else startEpisode(article);
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
  loadEpisode(target);
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
  savePlayPos();
  stopEndCheckTimer();
  discardPreload();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  currentEpisode.value = null;
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
audio.addEventListener('play', () => { isPlaying.value = true; });
audio.addEventListener('pause', () => {
  isPlaying.value = false;
  savePlayPos();
});
// 読み込み表示: データ待ちの間だけ出し、再生可能になったら消す。
audio.addEventListener('waiting', () => { isLoading.value = true; });
audio.addEventListener('seeking', () => {
  rateSample = null;
  if (audio.readyState < 3) isLoading.value = true;
});
audio.addEventListener('seeked', () => {
  if (audio.readyState >= 3) isLoading.value = false;
});
audio.addEventListener('playing', () => { isLoading.value = false; });
audio.addEventListener('canplay', () => { isLoading.value = false; });
audio.addEventListener('error', () => { isLoading.value = false; });

function handleEpisodeEnded() {
  if (endFlowDone) return;
  endFlowDone = true;
  stopEndCheckTimer();
  isPlaying.value = false;
  isLoading.value = false;
  const ep = currentEpisode.value;
  if (!ep) return;
  // 聴き終えたら、記事を開いたときと同じ経路で既読にする
  // (単曲リピートでも、既読化は冪等なので毎回通してよい)。
  const view = state.value.articles.find((a) => a.id === ep.id) || ep;
  onOpenArticle(view);
  clearPlayPos(ep.id);
  currentTime.value = 0;
  if (repeatMode.value === 'one') {
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
  if (plan.type !== 'advance') return;
  const next = playQueue.value.find((a) => a.id === plan.id);
  if (!next) return;
  if (plan.resetPlayed) playedInRound = new Set();
  playedInRound.add(next.id);
  loadEpisode(next);
}
audio.addEventListener('ended', handleEpisodeEnded);

// セッション失効時の共通処理。保存分を消してサインイン画面に戻す。
function expireSession() {
  stopPlayer();
  clearSession();
  session.value = null;
  view.value = 'timeline';
  bootError.value = 'セッションの期限が切れました。もう一度サインインしてください。';
  renderSigninButton();
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
    if (e.message === 'unauthorized') expireSession();
    else mgmtError.value = `フィードを読み込めませんでした（${e.message}）。時間をおいて開き直してください。`;
  } finally {
    mgmtLoading.value = false;
  }
}

// 管理画面のジャンル絞り込みの切り替え (タイムラインの setCategory と対)。
function setAdminCategory(category) {
  adminCategory.value = category;
}

function openFeedAdmin() {
  if (!isOwner.value) return;
  view.value = 'feeds';
  formMode.value = '';
  confirmDeleteId.value = '';
  loadFeeds();
}

async function backToTimeline() {
  view.value = 'timeline';
  formMode.value = '';
  confirmDeleteId.value = '';
  // 管理で変わったフィード構成をタイムラインへ反映するため、並び替え保存の
  // 完了を待ってから背景更新 (フィード一覧の取り直し＋再取得) を行う。
  await waitReorderSettled();
  refreshInBackground();
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
    // エラー表示と読み直しは onMoveFeed 側で行う。
  }
}

async function onMoveFeed(feed, direction) {
  const next = moveFeedOrder(mgmtFeeds.value, feed.id, direction);
  if (!next) return;
  // 画面は即座に動かし、保存は orderSender が直列化＋合体して送る。
  // 保存中でも次の移動を受け付ける (ボタンは端以外では無効化しない)。
  mgmtFeeds.value = next;
  try {
    lastReorder = orderSender.submit(next.map((f) => f.id));
    await lastReorder;
    mgmtError.value = '';
  } catch (e) {
    if (e.message === 'unauthorized') expireSession();
    else {
      mgmtError.value = `並び替えを保存できませんでした（${e.message}）。`;
      loadFeeds();
    }
  }
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
    mgmtFeeds.value = mgmtFeeds.value.filter((f) => f.id !== feed.id);
    if (formMode.value === 'edit' && formBase.value?.id === feed.id) closeForm();
    confirmDeleteId.value = '';
    mgmtError.value = '';
  } catch (e) {
    if (e.message === 'unauthorized') {
      expireSession();
    } else if (e.message === 'not_found') {
      // 既に消えていた場合は一覧からも落として整合させる。
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
  formMode.value = 'add';
  formBase.value = null;
  form.value = createFeedForm();
  formError.value = '';
  confirmDeleteId.value = '';
  revealForm();
}

function startEditFeed(feed) {
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

// フォームの保存本体 (追加・編集共通)。成功したらフォームを閉じて
// 一覧を取り直す。
async function saveFeedForm(payload) {
  formSaving.value = true;
  try {
    await saveFeed(session.value.token, payload);
    closeForm();
    await loadFeeds();
  } catch (e) {
    if (e.message === 'unauthorized') expireSession();
    else if (e.message === 'invalid') formError.value = e.serverMessage || '入力内容を確認してください。';
    else formError.value = `保存できませんでした（${e.message}）。`;
  } finally {
    formSaving.value = false;
  }
}

async function submitFeedForm() {
  if (formSaving.value || formFetching.value) return;
  // 編集はジャンルと有効/無効だけ (ID・タイトル・URL は変更できない)。
  if (formMode.value === 'edit') {
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
    await initTimeline();
  } catch (e) {
    bootError.value = `サインインできませんでした（${e.message}）。許可されたアカウントでお試しください。`;
    loading.value = false;
  } finally {
    signingIn.value = false;
  }
}

function renderSigninButton() {
  // GIS スクリプトの読み込み完了を待ってから描画する (tweet と同じ load 待ち)。
  const render = () => {
    if (!window.google) return;
    if (!signinEl.value) {
      nextTick(render);
      return;
    }
    window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential });
    window.google.accounts.id.renderButton(signinEl.value, {
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
    });
  };
  if (window.google) render();
  else window.addEventListener('load', render, { once: true });
}

function signOut() {
  stopPlayer();
  clearSession();
  session.value = null;
  view.value = 'timeline';
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
    bootError.value = '共有リンクが無効か、期限が切れています。';
    return false;
  }
}

// しばらく離れて戻ってきたら、裏で背景更新する (復帰直後の
// ネットワーク失敗をユーザーの操作ではなく背景更新側で受けるため)。
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    savePlayPos();
    return;
  }
  if (session.value && view.value === 'timeline' && hiddenAt && Date.now() - hiddenAt > 60_000) {
    hiddenAt = 0;
    refreshInBackground();
  }
});

onMounted(async () => {
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
      <button class="brand" type="button" aria-label="タイムラインに戻る" @click="goHome">
        <span class="brand-mark">読</span>
        <span class="brand-text">
          <span class="brand-name">リーダー</span>
          <span class="brand-sub">RSSリーダー</span>
        </span>
      </button>
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
          <p class="hint">{{ booting || signingIn ? 'サインインしています…' : 'Googleログインが必要です。許可されたアカウントでサインインしてください。' }}</p>
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
        <p v-else-if="loading" class="panel center"><span class="spinner"></span>読み込み中...</p>
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
            <p v-if="a.summary" class="article-summary">{{ a.summary }}</p>
            <div class="article-foot">
              <span v-if="!a.isRead" class="unread-dot" aria-label="未読"></span>
              <button
                v-if="a.audioUrl"
                type="button"
                class="play-btn"
                :class="{ 'is-current': isCurrentEpisode(a) }"
                :aria-label="isCurrentEpisode(a) && isLoading ? '読み込み中' : (isCurrentEpisode(a) && isPlaying ? '一時停止' : '再生')"
                @click="toggleEpisode(a)"
              >
                <span v-if="isCurrentEpisode(a) && isLoading" class="play-loading" aria-hidden="true">…</span>
                <svg v-else-if="isCurrentEpisode(a) && isPlaying" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
              </button>
              <span v-if="a.audioUrl && a.durationSec" class="audio-duration">{{ formatTime(a.durationSec) }}</span>
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
          <button
            v-if="isOwner"
            class="primary mark-all-btn"
            type="button"
            @click="onMarkAllRead"
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
        </div>
        </template>

        <template v-else>
          <div class="feed-admin-head">
            <button class="ghost" type="button" @click="backToTimeline">← タイムラインに戻る</button>
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
                <p class="field-note">URLは変更できません。変える場合は削除してから追加し直してください。</p>
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
                list="feed-genre-options"
                placeholder="例: ニュース"
              />
              <datalist id="feed-genre-options">
                <option v-for="c in genreOptions" :key="c" :value="c"></option>
              </datalist>
            </div>
            <p v-if="formError" class="error">{{ formError }}</p>
            <div class="form-actions">
              <button class="primary" type="submit" :disabled="formSaving || formFetching">
                {{ formFetching ? '取得中...' : formSaving ? '保存中...' : '保存' }}
              </button>
              <button class="ghost" type="button" :disabled="formSaving || formFetching" @click="closeForm">キャンセル</button>
            </div>
          </form>

          <p v-if="mgmtError" class="panel center error">{{ mgmtError }}
            <button class="ghost" type="button" @click="loadFeeds">再試行</button>
          </p>
          <p v-else-if="mgmtLoading" class="panel center"><span class="spinner"></span>読み込み中...</p>
          <template v-else>
            <div v-if="genreOptions.length" class="feed-chips category-chips" role="tablist" aria-label="ジャンルで絞り込み">
              <button
                type="button"
                class="chip"
                :class="{ active: adminCategory === '' }"
                @click="setAdminCategory('')"
              >すべて</button>
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
            >
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
              <div v-else class="feed-actions">
                <!-- 並び替えはシート全体の順序に対する操作なので、ジャンルで
                     絞っている間は移動ボタンを出さない (部分集合の中での
                     移動に見えて誤解を招くため)。 -->
                <button
                  v-if="!adminCategory"
                  class="ghost"
                  type="button"
                  aria-label="上へ移動"
                  :disabled="i === 0"
                  @click="onMoveFeed(f, -1)"
                >↑</button>
                <button
                  v-if="!adminCategory"
                  class="ghost"
                  type="button"
                  aria-label="下へ移動"
                  :disabled="i === mgmtFeeds.length - 1"
                  @click="onMoveFeed(f, 1)"
                >↓</button>
                <button class="ghost" type="button" @click="startEditFeed(f)">編集</button>
                <button class="ghost danger" type="button" @click="askDeleteFeed(f)">削除</button>
              </div>
            </article>
          </template>
        </template>
      </template>

      <div v-if="currentEpisode" class="player-bar">
        <div class="player-now">
          <span class="player-title">{{ currentEpisode.title }}</span>
          <span v-if="currentEpisode.feedTitle" class="player-feed">{{ currentEpisode.feedTitle }}</span>
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
