<script setup>
import { computed, onMounted, ref } from 'vue';
import { API_URL, GOOGLE_CLIENT_ID } from './config.js';
import { exchangeSession, exchangeShare, listArticles, markAllRead, markArticle } from './lib/api.js';
import { clearSession, loadSession, saveSession } from './lib/session.js';
import {
  applyListResponse,
  createListState,
  markAllReadInList,
  patchArticle,
  visibleArticles,
} from './lib/listState.js';
import { formatPublishedAt } from './lib/format.js';

const PAGE_SIZE = 50;
const year = new Date().getFullYear();

const session = ref(loadSession());
const bootError = ref('');
const loading = ref(true);
const loadingMore = ref(false);
const savingAll = ref(false);
const listError = ref('');
const state = ref(createListState());
const signinEl = ref(null);

const isReadonly = computed(() => session.value?.role === 'readonly');
const isOwner = computed(() => session.value?.role === 'owner');
const visible = computed(() => visibleArticles(state.value));
const unreadTotalCount = computed(() =>
  state.value.feeds.reduce((n, f) => n + (f.unreadCount || 0), 0)
);
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
      filter: state.value.filter,
      limit: PAGE_SIZE,
      offset: append ? state.value.articles.length : 0,
    });
    state.value = applyListResponse(state.value, payload, { append });
    listError.value = '';
  } catch (e) {
    if (e.message === 'unauthorized') {
      // セッション失効。保存分を消してサインイン画面に戻す。
      clearSession();
      session.value = null;
      listError.value = '';
      bootError.value = 'セッションの期限が切れました。もう一度サインインしてください。';
      renderSigninButton();
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

function setFilter(filter) {
  if (state.value.filter === filter) return;
  state.value = { ...state.value, filter, articles: [], total: 0 };
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
  state.value = markAllReadInList(state.value, state.value.feedId);
  try {
    await markAllRead(session.value.token, state.value.feedId);
    // 未読ビューのときは既読化した記事が残らないよう取り直す。
    if (state.value.filter === 'unread') await fetchList();
  } catch (e) {
    state.value = before;
    listError.value = `保存できませんでした（${e.message}）。`;
  } finally {
    savingAll.value = false;
  }
}

function adoptSession(data) {
  const s = { token: data.sessionToken, role: data.role || 'owner', expiresAt: data.expiresAt || null };
  saveSession(s);
  session.value = s;
}

async function onCredential(response) {
  try {
    const data = await exchangeSession(response.credential);
    adoptSession(data);
    state.value = createListState();
    await fetchList();
  } catch (e) {
    bootError.value = `サインインできませんでした（${e.message}）。許可されたアカウントでお試しください。`;
    loading.value = false;
  }
}

function renderSigninButton() {
  // GIS スクリプトの読み込み完了を待ってから描画する (tweet と同じ load 待ち)。
  const render = () => {
    if (!window.google || !signinEl.value) return;
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
    return;
  }
  const shared = await tryShareFromHash();
  if (shared || session.value) {
    await fetchList();
  } else {
    loading.value = false;
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
        <span v-if="session && unreadTotalCount > 0" class="unread-pill">未読 {{ unreadTotalCount }}</span>
        <span v-if="isReadonly" class="meta">閲覧のみ</span>
        <button v-if="session" class="ghost" type="button" @click="signOut">ログアウト</button>
      </span>
    </nav>
    <div class="layout">
      <p v-if="bootError" class="panel center error">{{ bootError }}</p>

      <template v-if="!session">
        <section class="panel center signin-box">
          <p class="hint">Googleログインが必要です。許可されたアカウントでサインインしてください。</p>
          <div ref="signinEl"></div>
        </section>
      </template>

      <template v-else>
        <p v-if="isReadonly" class="readonly-note">共有リンクで閲覧中（読み取り専用）です。既読やスターは付けられません。</p>

        <div class="feed-chips" role="tablist" aria-label="フィードで絞り込み">
          <button
            type="button"
            class="chip"
            :class="{ active: state.feedId === '' }"
            @click="setFeed('')"
          >すべて</button>
          <button
            v-for="f in state.feeds"
            :key="f.id"
            type="button"
            class="chip"
            :class="{ active: state.feedId === f.id }"
            @click="setFeed(f.id)"
          >{{ f.title }}<span v-if="f.unreadCount > 0" class="chip-count">{{ f.unreadCount }}</span></button>
        </div>

        <div class="view-tabs" role="tablist" aria-label="表示切替">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            type="button"
            :class="{ active: state.filter === f.key }"
            @click="setFilter(f.key)"
          >{{ f.label }}</button>
        </div>

        <div v-if="isOwner" class="list-toolbar">
          <button class="ghost" type="button" :disabled="savingAll || loading" @click="onMarkAllRead">
            {{ state.feedId ? 'このフィードをすべて既読' : 'すべて既読' }}
          </button>
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
