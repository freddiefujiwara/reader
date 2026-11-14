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
  formatFeedStatus,
  moveFeedOrder,
  createOrderSender,
  toggleEnabledPayload,
  validateFeedForm,
} from './lib/feedAdmin.js';
import { clearSession, loadSession, saveSession } from './lib/session.js';
import {
  createListState,
  feedCategories,
  markAllReadInList,
  markAllReadScope,
  patchArticle,
  sortArticlesDesc,
  visibleArticles,
  visibleFeedChips,
  withUnreadCounts,
} from './lib/listState.js';
import {
  articleRecordToView,
  clearLocalArticlePlayPos,
  deleteLocalArticles,
  getLocalMeta,
  loadLocalArticles,
  loadLocalFeeds,
  markLocalArticlesRead,
  planLocalPrune,
  planOrphanArticles,
  planUpserts,
  putLocalArticles,
  saveLocalFeeds,
  setLocalArticlePlayPos,
  setLocalArticleRead,
  setLocalMeta,
} from './lib/localDb.js';
import { fetchAllFeeds } from './lib/feedFetch.js';
import { formatPublishedAt } from './lib/format.js';
import { clampSeek, formatTime, nextSpeed, progressRatio } from './lib/player.js';

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
const mgmtLoading = ref(false);
const mgmtError = ref('');
const mgmtSavingId = ref('');
const confirmDeleteId = ref('');
const formMode = ref(''); // '' | 'add' | 'edit'
const form = ref(createFeedForm());
const formBase = ref(null);
const formError = ref('');
const formSaving = ref(false);

const isReadonly = computed(() => session.value?.role === 'readonly');
const isOwner = computed(() => session.value?.role === 'owner');
const visible = computed(() => visibleArticles(state.value));
const displayArticles = computed(() => visible.value.slice(0, displayLimit.value));
const unreadTotalCount = computed(() =>
  state.value.feeds.reduce((n, f) => n + (f.unreadCount || 0), 0)
);
const chipFeeds = computed(() => visibleFeedChips(state.value));
const categoryList = computed(() => feedCategories(state.value.feeds));
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
  feeds.forEach((f) => { titles[f.id] = f.title; });
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
    if (listOk) {
      await saveLocalFeeds(feeds);
    } else {
      feeds = await loadLocalFeeds();
    }

    // サーバー側で消えたフィードの記事はローカルからも落とす。
    let records = await loadLocalArticles();
    const orphanIds = planOrphanArticles(records, feeds.map((f) => f.id));
    if (orphanIds.length) {
      await deleteLocalArticles(orphanIds);
      const dropped = new Set(orphanIds);
      records = records.filter((r) => !dropped.has(r.id));
    }

    // (b) 全フィード取得 → 取り込み。無効化されたフィードは取得しない。
    const fetchedAt = new Date().toISOString();
    const results = await fetchAllFeeds(feeds.filter((f) => f.enabled !== false));
    const byId = {};
    records.forEach((r) => { byId[r.id] = r; });
    for (const result of results) {
      if (!result.ok) continue;
      const puts = await planUpserts(byId, result.entries, result.feed, fetchedAt);
      puts.forEach((r) => { byId[r.id] = r; });
      await putLocalArticles(puts);
    }

    // 既読の初回取り込み (この端末で初回だけ)。取り込めた記事だけ既読にする。
    if (importPayload) {
      const readIds = (importPayload.articles || [])
        .filter((a) => a.isRead)
        .map((a) => a.id)
        .filter((id) => byId[id]);
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
  if (state.value.feedId === feedId) return;
  state.value = { ...state.value, feedId };
  displayLimit.value = DISPLAY_LIMIT;
}

function setCategory(category) {
  if (state.value.category === category) return;
  // カテゴリを変えたらフィード選択は解除する (対象外フィードが残らないように)。
  state.value = { ...state.value, category, feedId: '' };
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
const currentTime = ref(0);
const duration = ref(0);
const speed = ref(1);
const seeking = ref(false);
// 再生位置のメモリ上の控え (DB 読み直しを待たずに再開するため)。
const playPosMemory = new Map();
let pendingSeek = 0;
let lastPosSaveAt = 0;

const displayDuration = computed(() => {
  if (Number.isFinite(duration.value) && duration.value > 0) return duration.value;
  return currentEpisode.value?.durationSec || 0;
});
const seekStyle = computed(() => {
  const pct = Math.round(progressRatio(currentTime.value, displayDuration.value) * 1000) / 10;
  return { background: `linear-gradient(to right, var(--primary) ${pct}%, var(--border) ${pct}%)` };
});
const speedLabel = computed(() => `${speed.value}×`);

function isCurrentEpisode(article) {
  return !!currentEpisode.value && currentEpisode.value.id === article.id;
}

function tryPlayAudio() {
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
  const pos = Math.floor(audio.currentTime || 0);
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
  } catch {
    // Media Session が使えない環境では何もしない。
  }
}

function startEpisode(article) {
  savePlayPos();
  currentEpisode.value = article;
  duration.value = 0;
  currentTime.value = 0;
  pendingSeek = playPosMemory.has(article.id) ? playPosMemory.get(article.id) : (article.playPos || 0);
  audio.src = article.audioUrl;
  audio.playbackRate = speed.value;
  updateMediaSession(article);
  tryPlayAudio();
}

function togglePlay() {
  if (!currentEpisode.value) return;
  if (audio.paused) {
    if (audio.ended) audio.currentTime = 0;
    tryPlayAudio();
  } else {
    audio.pause();
  }
}

function toggleEpisode(article) {
  if (isCurrentEpisode(article)) togglePlay();
  else startEpisode(article);
}

function skipBy(delta) {
  if (!currentEpisode.value) return;
  audio.currentTime = clampSeek((audio.currentTime || 0) + delta, audio.duration);
  currentTime.value = audio.currentTime;
}

function cycleSpeed() {
  speed.value = nextSpeed(speed.value);
  audio.playbackRate = speed.value;
}

function onSeekInput(event) {
  const value = Number(event.target.value);
  currentTime.value = value;
  audio.currentTime = clampSeek(value, Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : displayDuration.value);
}

function stopPlayer() {
  savePlayPos();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  currentEpisode.value = null;
  isPlaying.value = false;
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
    audio.currentTime = clampSeek(pendingSeek, audio.duration);
    currentTime.value = audio.currentTime;
  }
  pendingSeek = 0;
});
audio.addEventListener('timeupdate', () => {
  if (!seeking.value) currentTime.value = audio.currentTime || 0;
  if (Date.now() - lastPosSaveAt > 10_000) {
    lastPosSaveAt = Date.now();
    savePlayPos();
  }
});
audio.addEventListener('play', () => { isPlaying.value = true; });
audio.addEventListener('pause', () => {
  isPlaying.value = false;
  savePlayPos();
});
audio.addEventListener('ended', () => {
  isPlaying.value = false;
  const ep = currentEpisode.value;
  if (!ep) return;
  clearPlayPos(ep.id);
  currentTime.value = 0;
  // 聴き終えたら、記事を開いたときと同じ経路で既読にする。
  const view = state.value.articles.find((a) => a.id === ep.id) || ep;
  onOpenArticle(view);
});

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

async function onToggleFeed(feed) {
  if (mgmtSavingId.value) return;
  mgmtSavingId.value = feed.id;
  try {
    const payload = await saveFeed(session.value.token, toggleEnabledPayload(feed));
    if (payload.feed) {
      mgmtFeeds.value = mgmtFeeds.value.map((f) => (f.id === feed.id ? { ...f, ...payload.feed } : f));
    }
    mgmtError.value = '';
  } catch (e) {
    if (e.message === 'unauthorized') expireSession();
    else mgmtError.value = `保存できませんでした（${e.message}）。`;
  } finally {
    mgmtSavingId.value = '';
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

function startAddFeed() {
  formMode.value = 'add';
  formBase.value = null;
  form.value = createFeedForm();
  formError.value = '';
  confirmDeleteId.value = '';
}

function startEditFeed(feed) {
  formMode.value = 'edit';
  formBase.value = feed;
  form.value = feedFormFromFeed(feed);
  formError.value = '';
  confirmDeleteId.value = '';
}

function closeForm() {
  formMode.value = '';
  formBase.value = null;
  formError.value = '';
}

async function submitFeedForm() {
  if (formSaving.value) return;
  const invalid = validateFeedForm(form.value, { isEdit: formMode.value === 'edit' });
  if (invalid) {
    formError.value = invalid;
    return;
  }
  formSaving.value = true;
  try {
    await saveFeed(session.value.token, buildSaveFeedPayload(form.value, formBase.value));
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
      <a class="brand" href="./" aria-label="リーダー トップへ">
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
            type="button"
            class="chip"
            :class="{ active: state.category === '' }"
            @click="setCategory('')"
          >すべて</button>
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
            type="button"
            class="chip"
            :class="{ active: state.feedId === '' }"
            @click="setFeed('')"
          >すべて</button>
          <button
            v-for="f in chipFeeds"
            :key="f.id"
            type="button"
            class="chip"
            :class="{ active: state.feedId === f.id }"
            @click="setFeed(f.id)"
          >{{ f.title }}<span v-if="f.unreadCount > 0" class="chip-count">{{ f.unreadCount }}</span></button>
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
                :aria-label="isCurrentEpisode(a) && isPlaying ? '一時停止' : '再生'"
                @click="toggleEpisode(a)"
              >
                <svg v-if="isCurrentEpisode(a) && isPlaying" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
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

          <form v-if="formMode" class="panel feed-form" @submit.prevent="submitFeedForm">
            <h2 class="feed-form-title">{{ formMode === 'edit' ? 'フィードを編集' : 'フィードを追加' }}</h2>
            <div class="field">
              <label for="feed-id">ID</label>
              <input
                id="feed-id"
                v-model="form.id"
                type="text"
                :disabled="formMode === 'edit'"
                autocomplete="off"
                placeholder="例: nhk-news"
              />
              <p v-if="formMode === 'edit'" class="field-note">IDは変更できません。</p>
            </div>
            <div class="field">
              <label for="feed-title">タイトル</label>
              <input id="feed-title" v-model="form.title" type="text" autocomplete="off" />
            </div>
            <div class="field">
              <label for="feed-url">URL</label>
              <input
                id="feed-url"
                v-model="form.url"
                type="url"
                autocomplete="off"
                placeholder="https://example.com/feed.xml"
              />
              <p class="field-note">a.ze.gs のフィードは自動で「プライベート」扱いになります（切り替えはできません）。</p>
            </div>
            <div class="field">
              <label for="feed-category">カテゴリ</label>
              <input id="feed-category" v-model="form.category" type="text" autocomplete="off" placeholder="例: news" />
            </div>
            <p v-if="formError" class="error">{{ formError }}</p>
            <div class="form-actions">
              <button class="primary" type="submit" :disabled="formSaving">
                {{ formSaving ? '保存中...' : '保存' }}
              </button>
              <button class="ghost" type="button" :disabled="formSaving" @click="closeForm">キャンセル</button>
            </div>
          </form>

          <p v-if="mgmtError" class="panel center error">{{ mgmtError }}
            <button class="ghost" type="button" @click="loadFeeds">再試行</button>
          </p>
          <p v-else-if="mgmtLoading" class="panel center"><span class="spinner"></span>読み込み中...</p>
          <template v-else>
            <p v-if="mgmtFeeds.length === 0" class="panel empty-note">フィードがありません。</p>
            <article
              v-for="(f, i) in mgmtFeeds"
              :key="f.id"
              class="card feed-card"
              :class="{ 'is-disabled': f.enabled === false }"
            >
              <p class="article-meta">
                <span class="feed-name">{{ f.title }}</span>
                <span v-if="f.category">{{ f.category }}</span>
                <span>未読 {{ f.unreadCount || 0 }}件</span>
                <span v-if="f.isPrivate" class="private-badge">プライベート</span>
                <span v-if="f.enabled === false" class="private-badge off">無効</span>
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
                <button
                  class="ghost"
                  type="button"
                  aria-label="上へ移動"
                  :disabled="i === 0"
                  @click="onMoveFeed(f, -1)"
                >↑</button>
                <button
                  class="ghost"
                  type="button"
                  aria-label="下へ移動"
                  :disabled="i === mgmtFeeds.length - 1"
                  @click="onMoveFeed(f, 1)"
                >↓</button>
                <button
                  class="ghost"
                  type="button"
                  :disabled="mgmtSavingId === f.id"
                  @click="onToggleFeed(f)"
                >{{ f.enabled === false ? '有効にする' : '無効にする' }}</button>
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
          <span class="player-time">{{ formatTime(currentTime) }}</span>
          <input
            class="player-seek"
            type="range"
            min="0"
            :max="displayDuration || 0"
            step="0.1"
            :value="currentTime"
            :style="seekStyle"
            aria-label="再生位置"
            @input="onSeekInput"
            @pointerdown="seeking = true"
            @pointerup="seeking = false"
          />
          <span class="player-time player-total">{{ formatTime(displayDuration) }}</span>
        </div>
        <div class="player-controls">
          <button type="button" class="player-button" aria-label="15秒戻る" @click="skipBy(-15)">−15秒</button>
          <button
            type="button"
            class="player-play"
            :aria-label="isPlaying ? '一時停止' : '再生'"
            @click="togglePlay"
          >
            <svg v-if="isPlaying" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          </button>
          <button type="button" class="player-button" aria-label="30秒進む" @click="skipBy(30)">+30秒</button>
          <button type="button" class="player-button" aria-label="再生速度" @click="cycleSpeed">{{ speedLabel }}</button>
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
