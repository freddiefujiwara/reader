// 共有リンクで開いた側 (readonly セッション) の遮断テスト。
//
// 発行側 (管理画面の共有リンクセクション) は appShareLink で固定して
// いるが、閲覧側は「管理画面へ入れない」ことが権限の要になる。
// ここでは保存済みの readonly セッションで App をマウントし、
// (a) 管理ボタンが出ず readonly-note が出ること、(b) /reader/admin の
// URL で開いてもタイムラインに倒れること、(c) 編集系 API が一切
// 呼ばれないことを固定する。ハーネスは appRoute と同じ。
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
  id: '33452296be85fdbc', // https://example.com/x.freddie.xml のハッシュID
  title: 'X freddie',
  url: 'https://example.com/x.freddie.xml',
  category: 'private',
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '2026-11-15T01:00:00.000Z',
  unreadCount: 1,
};

let serverFeeds = [];

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({
    ok: true,
    feeds: serverFeeds.map((f) => ({ ...f })),
    articles: [],
  })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: serverFeeds.map((f) => ({ ...f })) })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
  getStats: vi.fn(async () => ({ ok: true, weekly: [], currentWeek: '', current: [] })),
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
import {
  deleteFeed,
  getShareLinkStatus,
  issueShareLink,
  listFeeds,
  reorderFeeds,
  revokeShareLink,
  saveFeed,
} from '../src/lib/api.js';
import { saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

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

const articleTitles = () =>
  [...el.querySelectorAll('.article-card .article-title')].map((n) => n.textContent.trim());
const feedCards = () => [...el.querySelectorAll('.feed-card')];

async function seedAndMount(routePath) {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([rec('art-a', FEED_A.id, '記事A'), rec('art-b', FEED_B.id, '記事B')]);
  window.history.pushState(null, '', routePath);
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
}

function expectEditApisNotCalled() {
  expect(listFeeds).not.toHaveBeenCalled();
  expect(getShareLinkStatus).not.toHaveBeenCalled();
  expect(saveFeed).not.toHaveBeenCalled();
  expect(deleteFeed).not.toHaveBeenCalled();
  expect(reorderFeeds).not.toHaveBeenCalled();
  expect(issueShareLink).not.toHaveBeenCalled();
  expect(revokeShareLink).not.toHaveBeenCalled();
}

beforeEach(() => {
  errors = [];
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
  document.body.innerHTML = '';
  window.scrollTo = () => {};
  window.history.pushState(null, '', '/');
  localStorage.clear();
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok-readonly', role: 'readonly', expiresAt: null })
  );
  vi.clearAllMocks();
});

afterEach(async () => {
  await settleApp();
  if (app) app.unmount();
  app = null;
  el = null;
});

describe('readonly セッションの遮断', () => {
  it('通常表示では管理ボタンが出ず、閲覧のみの注記が出て、編集系 API は呼ばれない', async () => {
    await seedAndMount('/reader/');
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']));
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A', '記事B']);
    // ヘッダー: 管理ボタンは無く、「閲覧のみ」が出る。
    expect(findButton(el, '管理')).toBeUndefined();
    expect(el.querySelector('.session-note').textContent).toContain('閲覧のみ');
    // タイムライン冒頭の readonly-note が出る。
    const note = el.querySelector('.readonly-note');
    expect(note, 'readonly-note が出る').toBeTruthy();
    expect(note.textContent).toContain('読み取り専用');
    // 管理画面の断片 (フィードカード・共有リンクセクション) は無い。
    expect(feedCards().length).toBe(0);
    expect(el.querySelector('.share-link-panel')).toBeNull();
    expectEditApisNotCalled();
    await settleApp();
  });

  it('/reader/admin で開いても管理画面には入らず、タイムラインに倒れる', async () => {
    await seedAndMount('/reader/admin');
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']));
    expect(errors).toEqual([]);
    // 管理画面ではなくタイムラインの記事一覧が出る。
    expect(articleTitles()).toEqual(['記事A', '記事B']);
    expect(feedCards().length).toBe(0);
    expect(el.querySelector('.share-link-panel')).toBeNull();
    expect(findButton(el, '管理')).toBeUndefined();
    expect(el.querySelector('.readonly-note'), 'readonly-note が出る').toBeTruthy();
    // 管理側の読み込み (listFeeds / 共有リンク状態) も走らない。
    expectEditApisNotCalled();
    await settleApp();
  });
});
