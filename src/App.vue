<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { API_URL, GOOGLE_CLIENT_ID } from './config.js';
import {
  deleteFeed,
  exchangeSession,
  exchangeShare,
  listArticles,
  listFeeds,
  markAllRead,
  markArticle,
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
  applyListResponse,
  createListState,
  markAllReadInList,
  patchArticle,
  visibleArticles,
  visibleFeedChips,
  feedCategories,
} from './lib/listState.js';
import { formatPublishedAt } from './lib/format.js';

const PAGE_SIZE = 50;
const year = new Date().getFullYear();

const session = ref(loadSession());
const bootError = ref('');
// 起動中 (セッション復元・共有リンク交換) とサインイン交換中は
// ログインボタンを出さず「サインインしています…」にする (戻ってきた直後に
// ボタンが見えて未ログインと誤解されるのを防ぐ)。
const booting = ref(true);
const signingIn = ref(false);
const loading = ref(true);
const loadingMore = ref(false);
const savingAll = ref(false);
const listError = ref('');
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
const unreadTotalCount = computed(() =>
  state.value.feeds.reduce((n, f) => n + (f.unreadCount || 0), 0)
);
const chipFeeds = computed(() => visibleFeedChips(state.value));
const categoryList = computed(() => feedCategories(state.value.feeds));
const hasMore = computed(() => state.value.articles.length < state.value.total);

const FILTERS = [
  { key: 'all', label: 'すべて' },
  { key: 'unread', label: '未読' },
  { key: 'starred', label: 'スター' },
];

async function fetchList({ append = false } = {}) {
  if (!session.value) return;
  if (append) loadingMore.value = true;
  else loading.value = true;
  try {
    const payload = await listArticles(session.value.token, {
      feedId: state.value.feedId,
      category: state.value.category,
      filter: state.value.filter,
      limit: PAGE_SIZE,
      offset: append ? state.value.articles.length : 0,
    });
    state.value = applyListResponse(state.value, payload, { append });
    listError.value = '';
  } catch (e) {
    if (e.message === 'unauthorized') {
      // セッション失効。保存分を消してサインイン画面に戻す。
      listError.value = '';
      expireSession();
    } else {
      listError.value = `記事を読み込めませんでした（${e.message}）。時間をおいて開き直してください。`;
    }
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function setFeed(feedId) {
  if (state.value.feedId === feedId) return;
  state.value = { ...state.value, feedId, articles: [], total: 0 };
  fetchList();
}

function setCategory(category) {
  if (state.value.category === category) return;
  // カテゴリを変えたらフィード選択は解除する (対象外フィードが残らないように)。
  state.value = { ...state.value, category, feedId: '', articles: [], total: 0 };
  fetchList();
}

function setFilter(filter) {
  if (state.value.filter === filter) return;
  state.value = { ...state.value, filter, articles: [], total: 0 };
  fetchList();
}

// ヘッダーの未読ピル: 全フィードの未読一覧へ移動する。
async function goUnreadAll() {
  const fromAdmin = view.value !== 'timeline';
  if (fromAdmin) view.value = 'timeline';
  if (state.value.feedId === '' && state.value.category === '' && state.value.filter === 'unread' && !fromAdmin) return;
  state.value = { ...state.value, feedId: '', category: '', filter: 'unread', articles: [], total: 0 };
  if (fromAdmin) await waitReorderSettled();
  fetchList();
}

// 楽観的更新つきの mark。失敗したら元の状態へ戻す。
async function applyMark(article, patch) {
  if (!isOwner.value) return;
  const before = state.value.articles;
  state.value = { ...state.value, articles: patchArticle(before, article.id, patch) };
  try {
    await markArticle(session.value.token, article.id, patch);
  } catch (e) {
    state.value = { ...state.value, articles: before };
    listError.value = `保存できませんでした（${e.message}）。`;
  }
}

function onOpenArticle(article) {
  if (isOwner.value && !article.isRead) {
    // 元記事を開く操作は止めない。既読化は裏で送る。
    applyMark(article, { isRead: true });
  }
}

async function onMarkAllRead() {
  if (!isOwner.value || savingAll.value) return;
  savingAll.value = true;
  const before = state.value;
  state.value = markAllReadInList(state.value, state.value.feedId, state.value.category);
  try {
    await markAllRead(session.value.token, {
      feedId: state.value.feedId,
      category: state.value.feedId ? '' : state.value.category,
    });
    // 未読ビューのときは既読化した記事が残らないよう取り直す。
    if (state.value.filter === 'unread') await fetchList();
  } catch (e) {
    state.value = before;
    listError.value = `保存できませんでした（${e.message}）。`;
  } finally {
    savingAll.value = false;
  }
}

// セッション失効時の共通処理。保存分を消してサインイン画面に戻す。
function expireSession() {
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
  // 管理で変わったフィード構成・未読数をタイムラインへ反映するため取り直す。
  // 並び替え保存が終わる前に取り直すと古い並びが返るため、先に完了を待つ。
  await waitReorderSettled();
  fetchList();
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
// 待ってから一覧を取り直す。待たないと、保存前の並びで書かれたシートを
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
    await fetchList();
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
    await fetchList();
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
        <button v-if="session && isOwner" class="ghost nav-mgmt" type="button" @click="openFeedAdmin">管理</button>
        <button v-if="session" class="nav-logout" type="button" @click="signOut">ログアウト</button>
      </span>
    </nav>
    <div class="layout">
      <p v-if="bootError" class="panel center error">{{ bootError }}</p>

      <template v-if="!session">
        <section class="panel center signin-box">
          <p class="hint">{{ booting || signingIn ? 'サインインしています…' : 'Googleログインが必要です。許可されたアカウントでサインインしてください。' }}</p>
          <div v-show="!booting && !signingIn" ref="signinEl"></div>
        </section>
      </template>

      <template v-else>
        <p v-if="isReadonly" class="readonly-note">共有リンクで閲覧中（読み取り専用）です。既読やスターは付けられません。</p>

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
          <button class="ghost" type="button" @click="fetchList()">再試行</button>
        </p>
        <p v-else-if="loading" class="panel center"><span class="spinner"></span>読み込み中...</p>
        <template v-else>
          <p v-if="visible.length === 0" class="panel empty-note">記事がありません。</p>
          <article
            v-for="a in visible"
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
            <div v-if="isOwner" class="article-foot">
              <span v-if="!a.isRead" class="unread-dot" aria-label="未読"></span>
              <button
                type="button"
                class="star-btn"
                :class="{ starred: a.isStarred }"
                :aria-label="a.isStarred ? 'スターを外す' : 'スターを付ける'"
                @click="applyMark(a, { isStarred: !a.isStarred })"
              >{{ a.isStarred ? '★' : '☆' }}</button>
              <button
                type="button"
                class="read-toggle"
                @click="applyMark(a, { isRead: !a.isRead })"
              >{{ a.isRead ? '未読に戻す' : '既読にする' }}</button>
            </div>
            <div v-else class="article-foot">
              <span v-if="!a.isRead" class="unread-dot" aria-label="未読"></span>
            </div>
          </article>
          <p v-if="hasMore" class="more-row">
            <button class="ghost" type="button" :disabled="loadingMore" @click="fetchList({ append: true })">
              {{ loadingMore ? '読み込み中...' : 'もっと見る' }}
            </button>
          </p>
        </template>

        <div class="bottom-bar">
          <button
            v-if="isOwner"
            class="primary mark-all-btn"
            type="button"
            :disabled="savingAll || loading"
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

      <footer class="site-footer">
        <div class="foot-links">
          <a href="https://freddiefujiwara.com/" target="_blank" rel="noopener">トップ <span class="arr">↗</span></a>
        </div>
        <p class="copy">© {{ year }} freddiefujiwara.com</p>
      </footer>
    </div>
  </div>
</template>
