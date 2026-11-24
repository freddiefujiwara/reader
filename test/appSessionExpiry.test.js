// セッション失効 (API が unauthorized を返す) 時の App の振る舞い。
//
// expireSession への分岐は App.vue の複数箇所にあるが、ここでは
// 代表経路として (1) 起動時の初回取得、(2) 起動後の背景更新 (手動更新)
// の2経路で「保存済みセッションが消え、サインイン画面へ戻り、
// 期限切れの案内が出る」ことを固定する。ハーネスは appRoute と同じ。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

const FEEDS = [
  {
    id: 'b81e59da11f890d2',
    title: 'Rebuild',
    url: 'https://feeds.rebuild.fm/rebuildfm',
    category: 'ポッドキャスト',
    lastStatus: '200',
    lastError: '',
    lastFetchedAt: '2026-11-15T01:00:00.000Z',
    unreadCount: 0,
  },
];

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  getFeedStats: vi.fn(async () => ({ ok: true, stats: {} })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  listArticles: vi.fn(async () => ({ ok: true, feeds: FEEDS, articles: [] })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: FEEDS })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
  saveFeed: vi.fn(async () => ({ ok: true, feed: FEEDS[0] })),
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
import { listArticles } from '../src/lib/api.js';

const unauthorized = async () => {
  throw new Error('unauthorized');
};

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

const signinShown = () => !!el && !!el.querySelector('.signin-box');

function mountApp() {
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
}

function expectExpiredToSignin() {
  expect(signinShown(), 'サインイン画面に戻る').toBe(true);
  expect(el.textContent).toContain('ログインの有効期限が切れました。再度ログインしてください。');
  expect(localStorage.getItem('reader:session:v1')).toBeNull();
  expect(findButton(el, 'ログアウト')).toBeUndefined();
  expect(findButton(el, '管理')).toBeUndefined();
}

beforeEach(() => {
  errors = [];
  document.body.innerHTML = '';
  window.scrollTo = () => {};
  window.history.pushState(null, '', '/');
  localStorage.clear();
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok', role: 'owner', expiresAt: null })
  );
  vi.clearAllMocks();
  listArticles.mockImplementation(async () => ({ ok: true, feeds: FEEDS, articles: [] }));
});

afterEach(async () => {
  await settleApp();
  if (app) app.unmount();
  app = null;
  el = null;
});

describe('セッション失効時の遷移', () => {
  it('起動時の初回取得で unauthorized になると、サインイン画面へ戻る', async () => {
    listArticles.mockImplementation(unauthorized);
    mountApp();
    await flushUntil(() => signinShown());
    expect(errors).toEqual([]);
    expect(listArticles).toHaveBeenCalled();
    expectExpiredToSignin();
    await settleApp();
  });

  it('起動後の手動更新で unauthorized になると、サインイン画面へ戻る', async () => {
    mountApp();
    // まず正常に起動してタイムラインが出る (更新ボタンが押せる状態)。
    await flushUntil(() => {
      const b = findButton(el, '更新');
      return !!b && !b.disabled && !signinShown();
    });
    expect(errors).toEqual([]);
    expect(localStorage.getItem('reader:session:v1')).not.toBeNull();

    listArticles.mockImplementation(unauthorized);
    findButton(el, '更新').click();
    await flushUntil(() => signinShown());
    expect(errors).toEqual([]);
    expectExpiredToSignin();
    await settleApp();
  });
});
