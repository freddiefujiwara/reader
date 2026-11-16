// フィード削除と背景更新の競合の回帰テスト。
//
// 保存 (saveFeedForm) には adminFeedsDirty の目印があり、タイムラインへ
// 戻る際に実行中の背景更新の完了後にもう一度更新して最新の一覧で
// 揃え直すが、削除 (onDeleteFeed) にはその目印が無かった。そのため、
// 削除前に始まった背景更新が実行中にタイムラインへ戻ると、その更新が
// 削除前の一覧で完了し、削除したフィードと記事がローカルに残った
// (次の更新機会で解消する一過性)。
//
// ここでは listArticles をゲートで包み、「削除前の一覧を取り始めた
// 背景更新が、削除とタイムライン復帰の後まで完了しない」という順序を
// 決定的に作って、削除したフィードと記事がローカルに残らないことを
// 固定する。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

const FEED_A = {
  id: 'b81e59da11f890d2', // https://feeds.rebuild.fm/rebuildfm のハッシュID
  title: 'Rebuild',
  url: 'https://feeds.rebuild.fm/rebuildfm',
  category: 'ポッドキャスト',
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '2026-11-15T01:00:00.000Z',
  unreadCount: 1,
};
const FEED_B = {
  id: '35797c975382389f', // https://a.ze.gs/x.freddie.xml のハッシュID
  title: 'X freddie',
  url: 'https://a.ze.gs/x.freddie.xml',
  category: 'private',
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '2026-11-15T01:00:00.000Z',
  unreadCount: 1,
};

let serverFeeds = [];

// listArticles のゲート。armed の間は、呼び出し時点のサーバー一覧を
// 取り込んだうえで「解放されるまで呼び出し側へ返さない」。
const listGate = vi.hoisted(() => ({ armed: false, pending: [] }));

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => {
    const payload = {
      ok: true,
      feeds: serverFeeds.map((f) => ({ ...f })),
      articles: [],
    };
    if (!listGate.armed) return payload;
    return new Promise((resolve) => {
      listGate.pending.push(() => resolve(payload));
    });
  }),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: serverFeeds.map((f) => ({ ...f })) })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  saveFeed: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../src/lib/feedFetch.js', () => ({
  fetchAllFeeds: vi.fn(async () => []),
  fetchFeedXml: vi.fn(async () => ''),
  fetchOneFeed: vi.fn(async (feed) => ({ feed, ok: false, entries: [], error: new Error('not mocked') })),
}));

vi.mock('../src/config.js', () => ({
  API_URL: 'https://example.com/exec',
  GOOGLE_CLIENT_ID: 'test-client-id',
}));

import App from '../src/App.vue';
import { deleteFeed, listArticles } from '../src/lib/api.js';
import {
  loadLocalArticles, loadLocalFeeds, saveLocalFeeds, putLocalArticles,
} from '../src/lib/localDb.js';

const rec = (id, feedId, title) => ({
  id,
  feed_id: feedId,
  title,
  link: `https://example.com/${id}`,
  published_at: '2026-11-14T00:00:00.000Z',
  fetched_at: '2026-11-15T00:00:00.000Z',
  summary: '',
  author: '',
  audio_url: '',
  duration_sec: 0,
  play_pos: 0,
  is_read: false,
  read_at: '',
});

let app = null;
let el = null;
let errors = [];

const flushRound = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

const flushUntil = async (cond, maxRounds = 120) => {
  for (let i = 0; i < maxRounds; i += 1) {
    if (await cond()) return true;
    await flushRound();
  }
  return !!(await cond());
};

const isRefreshingShown = () =>
  !!el && [...el.querySelectorAll('button')].some((b) => b.textContent.includes('更新中'));

const settleApp = async (maxRounds = 120) => {
  if (!el) return;
  let calm = 0;
  for (let i = 0; i < maxRounds && calm < 3; i += 1) {
    await flushRound();
    calm = isRefreshingShown() ? 0 : calm + 1;
  }
};

function findButton(root, text) {
  return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
}

const feedCards = () => [...el.querySelectorAll('.feed-card')];
const cardOf = (title) => feedCards().find((c) => c.textContent.includes(title));
const articleTitles = () =>
  [...el.querySelectorAll('.article-card .article-title')].map((n) => n.textContent.trim());

// 保留中の listArticles をすべて解放し、以後は素通しにする。
async function releaseListGate() {
  listGate.armed = false;
  while (listGate.pending.length) listGate.pending.shift()();
  await flushRound();
}

async function mountTimeline() {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([rec('art-a', FEED_A.id, '記事A'), rec('art-b', FEED_B.id, '記事B')]);
  window.history.pushState(null, '', '/reader/');
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(() => !!findButton(el, '管理'));
  await settleApp();
  expect(errors).toEqual([]);
}

beforeEach(() => {
  errors = [];
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
  listGate.armed = false;
  listGate.pending = [];
  document.body.innerHTML = '';
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.history.pushState(null, '', '/');
  localStorage.clear();
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok', role: 'owner', expiresAt: null })
  );
  vi.clearAllMocks();
  // 成功時はサーバー側からも消えたことにする (次回の list 系に反映)。
  deleteFeed.mockImplementation(async (_token, id) => {
    serverFeeds = serverFeeds.filter((f) => f.id !== id);
    return { ok: true };
  });
});

afterEach(async () => {
  await releaseListGate();
  await settleApp();
  if (app) app.unmount();
  app = null;
  el = null;
});

describe('フィード削除と背景更新の競合', () => {
  it('削除前に始まった背景更新が実行中にタイムラインへ戻っても、削除したフィードと記事がローカルに残らない', async () => {
    await mountTimeline();
    expect(articleTitles()).toEqual(['記事A', '記事B']);

    // 背景更新を始め、一覧の取得 (削除前の一覧を取り込んだ状態) で止める。
    listGate.armed = true;
    findButton(el, '更新').click();
    await flushUntil(() => listGate.pending.length >= 1);
    expect(isRefreshingShown()).toBe(true);

    // 更新の実行中に管理画面へ入り、フィードAを削除する。
    findButton(el, '管理').click();
    await flushUntil(() => feedCards().length === 2);
    findButton(cardOf('Rebuild'), '削除').click();
    await flushUntil(() => !!cardOf('Rebuild')?.querySelector('.delete-confirm'));
    findButton(cardOf('Rebuild'), '本当に削除').click();
    await flushUntil(() => feedCards().length === 1);
    expect(deleteFeed).toHaveBeenCalledWith('tok', FEED_A.id);
    expect(cardOf('Rebuild')).toBeUndefined();

    // 更新がまだ実行中のままタイムラインへ戻る。ブランドはトップへの
    // ページ遷移になったため、アプリ内で戻る経路はブラウザの戻る
    // (popstate) だけになった。ここでは戻る操作相当で戻す。
    window.history.pushState(null, '', '/reader/');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await flushRound();

    // 保留していた更新を解放する。その更新は削除前の一覧で完了するが、
    // 削除の目印により完了後にもう一度更新され、最新の一覧 (削除済み)
    // で揃え直されるはず。呼び出し回数の基準は解放前に取る。解放後の
    // スナップショットは、追随更新の一覧取得が先に済んでいるかどうか
    // というタイミングでぶれて基準にならない (解放前に始まった更新が
    // ゲートで止まっている間は、呼び出し回数が増えないことが確定
    // している)。
    const listCallsBeforeRelease = listArticles.mock.calls.length;
    await releaseListGate();
    // 追随更新が実際に走ること (一覧の取り直しが追加で起きること) を、
    // 回数が増えるまで待って確かめる。
    await flushUntil(() => listArticles.mock.calls.length > listCallsBeforeRelease);
    expect(listArticles.mock.calls.length).toBeGreaterThan(listCallsBeforeRelease);
    await flushUntil(async () => {
      const feeds = await loadLocalFeeds();
      const records = await loadLocalArticles();
      return feeds.map((f) => f.id).join(',') === FEED_B.id
        && records.map((r) => r.id).join(',') === 'art-b';
    });
    expect(errors).toEqual([]);

    const feeds = await loadLocalFeeds();
    expect(feeds.map((f) => f.id)).toEqual([FEED_B.id]);
    const records = await loadLocalArticles();
    expect(records.map((r) => r.id)).toEqual(['art-b']);
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事B']));
    expect(articleTitles()).toEqual(['記事B']);
    await settleApp();
  });
});
