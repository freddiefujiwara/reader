// URL パーマリンク (パス) と画面状態の同期の回帰テスト。
//
// 開いた URL が指す状態 (画面・ジャンル・フィード絞り込み) が
// 初期状態に反映されること、画面操作で URL が書き換わること、
// 存在しないジャンル・フィードを指定したら検証で落とされて
// URL も追随することを固定する。ハーネスは appCategoryAutoClear と同じ。
import 'fake-indexeddb/auto';
import { flushRound, flushUntil } from './helpers/flush.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from 'vue';

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
  getFeedStats: vi.fn(async () => ({ ok: true, stats: {} })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
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

const categoryChips = () =>
  [...el.querySelectorAll('[aria-label="カテゴリで絞り込み"] .chip')];
const feedChips = () =>
  [...el.querySelectorAll('[aria-label="フィードで絞り込み"] .chip')];
const genreChips = () =>
  [...el.querySelectorAll('[aria-label="ジャンルで絞り込み"] .chip')];
const articleTitles = () =>
  [...el.querySelectorAll('.article-card .article-title')].map((n) => n.textContent.trim());
const feedCards = () => [...el.querySelectorAll('.feed-card')];
const activeChipText = (chips) =>
  chips.filter((b) => b.classList.contains('active')).map((b) => b.textContent.trim());
const path = () => window.location.pathname;
const enc = encodeURIComponent;

// 指定したパスで開いたことにする (履歴を積んでからマウントする)。
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

// 記事の中身を指定して開く (既読混じりの絞り込み確認用)。
async function seedAndMountArticles(routePath, articles) {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles(articles);
  window.history.pushState(null, '', routePath);
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
}

const filterTabs = () =>
  [...el.querySelectorAll('[aria-label="表示切替"] button')];
const activeFilterText = () =>
  filterTabs().filter((b) => b.classList.contains('active')).map((b) => b.textContent.trim());

// FEED_A に既読1件＋未読1件、FEED_B に未読1件。記事 ID は既存テストと
// 同じものを上書きする (このファイルは DB を消さずに使い回すため、
// 別 ID を足すと前テストの記事が残って混ざる)。
const MIXED_ARTICLES = () => [
  { ...rec('art-a', FEED_A.id, '記事A'), is_read: true, published_at: '2026-11-15T00:00:00.000Z' },
  { ...rec('art-a2', FEED_A.id, '記事A2'), published_at: '2026-11-14T00:00:00.000Z' },
  { ...rec('art-b', FEED_B.id, '記事B'), published_at: '2026-11-13T00:00:00.000Z' },
];

beforeEach(() => {
  errors = [];
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
  document.body.innerHTML = '';
  window.scrollTo = () => {};
  window.history.pushState(null, '', '/');
  localStorage.clear();
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok', role: 'owner', expiresAt: null })
  );
  vi.clearAllMocks();
});

afterEach(async () => {
  await settleApp();
  if (app) app.unmount();
  app = null;
  el = null;
});

describe('URL で開いた状態の初期反映', () => {
  it('ジャンル指定で開くと、そのジャンルに絞られて開く', async () => {
    await seedAndMount(`/reader/${enc('ポッドキャスト')}`);
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A']));
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A']);
    expect(activeChipText(categoryChips())).toEqual(['ポッドキャスト']);
    // 開いた URL はそのまま (書き換えで履歴を汚さない)。
    expect(path()).toBe(`/reader/${enc('ポッドキャスト')}`);
    await settleApp();
  });

  it('「すべて＋フィードID」で開くと、そのフィードだけに絞られて開く', async () => {
    await seedAndMount(`/reader/${enc('すべて')}/${FEED_B.id}`);
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事B']));
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事B']);
    expect(categoryChips().some((b) => b.classList.contains('active'))).toBe(false);
    expect(activeChipText(feedChips()).map((t) => t.replace(/\d+$/, '').trim())).toEqual(['X freddie']);
    expect(path()).toBe(`/reader/${enc('すべて')}/${FEED_B.id}`);
    await settleApp();
  });

  it('ジャンル＋フィードIDで開くと、両方で絞られて開く', async () => {
    await seedAndMount(`/reader/${enc('ポッドキャスト')}/${FEED_A.id}`);
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A']));
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A']);
    expect(activeChipText(categoryChips())).toEqual(['ポッドキャスト']);
    await settleApp();
  });

  it('/reader/admin で開くと管理画面が開く', async () => {
    await seedAndMount('/reader/admin');
    await flushUntil(() => feedCards().length === 2);
    expect(errors).toEqual([]);
    expect(feedCards().length).toBe(2);
    expect(path()).toBe('/reader/admin');
    await settleApp();
  });

  it('/reader/admin/<ジャンル> で開くと管理画面がそのジャンルで絞られる', async () => {
    await seedAndMount('/reader/admin/private');
    await flushUntil(() => feedCards().length === 1);
    expect(errors).toEqual([]);
    expect(feedCards().length).toBe(1);
    expect(feedCards()[0].textContent).toContain('X freddie');
    expect(activeChipText(genreChips())).toEqual(['private']);
    expect(path()).toBe('/reader/admin/private');
    await settleApp();
  });

  it('存在しないジャンルで開くと、検証で落とされて全件表示と素の URL に戻る', async () => {
    await seedAndMount(`/reader/${enc('未知ジャンル')}`);
    await flushUntil(
      () =>
        JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']) &&
        path() === '/reader/' &&
        !isRefreshingShown()
    );
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A', '記事B']);
    expect(categoryChips().some((b) => b.classList.contains('active'))).toBe(false);
    expect(path()).toBe('/reader/');
    await settleApp();
  });

  it('存在しないフィード ID で開くと、フィード絞り込みだけが落ちて URL も追随する', async () => {
    await seedAndMount(`/reader/${enc('すべて')}/0123456789abcdef`);
    await flushUntil(
      () =>
        JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']) &&
        path() === '/reader/' &&
        !isRefreshingShown()
    );
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A', '記事B']);
    expect(feedChips().some((b) => b.classList.contains('active'))).toBe(false);
    expect(path()).toBe('/reader/');
    await settleApp();
  });
});

describe('操作に合わせた URL の書き換え', () => {
  it('ジャンル選択→フィード選択→管理画面で URL が追随する', async () => {
    await seedAndMount('/reader/');
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']));
    expect(path()).toBe('/reader/');

    findButton(el.querySelector('[aria-label="カテゴリで絞り込み"]'), 'ポッドキャスト').click();
    await flushUntil(() => path() === `/reader/${enc('ポッドキャスト')}`);
    expect(path()).toBe(`/reader/${enc('ポッドキャスト')}`);

    const chipA = feedChips().find((b) => b.textContent.includes('Rebuild'));
    chipA.click();
    await flushUntil(() => path() === `/reader/${enc('ポッドキャスト')}/${FEED_A.id}`);
    expect(path()).toBe(`/reader/${enc('ポッドキャスト')}/${FEED_A.id}`);

    findButton(el, '管理').click();
    await flushUntil(() => feedCards().length === 2 && path() === '/reader/admin');
    expect(path()).toBe('/reader/admin');

    findButton(el.querySelector('[aria-label="ジャンルで絞り込み"]'), 'private').click();
    await flushUntil(() => path() === '/reader/admin/private');
    expect(path()).toBe('/reader/admin/private');
    expect(errors).toEqual([]);
    await settleApp();
  });

  it('popstate で URL の状態が画面へ反映される', async () => {
    await seedAndMount('/reader/');
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']));
    findButton(el.querySelector('[aria-label="カテゴリで絞り込み"]'), 'ポッドキャスト').click();
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A']));
    expect(articleTitles()).toEqual(['記事A']);

    // 戻る操作相当: URL を戻して popstate を発火させる。
    window.history.pushState(null, '', '/reader/');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']));
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A', '記事B']);
    expect(categoryChips().some((b) => b.classList.contains('active'))).toBe(false);
    await settleApp();
  });
});

describe('/unread (未読のみ表示) のパーマリンク', () => {
  it('/reader/すべて/<フィードID>/unread で開くと、そのフィードの未読だけが出る', async () => {
    await seedAndMountArticles(`/reader/${enc('すべて')}/${FEED_A.id}/unread`, MIXED_ARTICLES());
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A2']));
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A2']);
    expect(activeFilterText()).toEqual(['未読']);
    // 開いた URL はそのまま (書き換えで履歴を汚さない)。
    expect(path()).toBe(`/reader/${enc('すべて')}/${FEED_A.id}/unread`);
    await settleApp();
  });

  it('/reader/unread で開くと、全フィードの未読だけが出る', async () => {
    await seedAndMountArticles('/reader/unread', MIXED_ARTICLES());
    await flushUntil(
      () => JSON.stringify(articleTitles()) === JSON.stringify(['記事A2', '記事B'])
    );
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A2', '記事B']);
    expect(activeFilterText()).toEqual(['未読']);
    await settleApp();
  });

  it('未読のみから「すべて」へ切り替えると URL から /unread が消える', async () => {
    await seedAndMountArticles(`/reader/${enc('すべて')}/${FEED_A.id}/unread`, MIXED_ARTICLES());
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A2']));
    findButton(el.querySelector('[aria-label="表示切替"]'), 'すべて').click();
    await flushUntil(
      () =>
        JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事A2']) &&
        path() === `/reader/${enc('すべて')}/${FEED_A.id}`
    );
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A', '記事A2']);
    expect(path()).toBe(`/reader/${enc('すべて')}/${FEED_A.id}`);
    expect(activeFilterText()).toEqual(['すべて']);
    await settleApp();
  });

  it('通常表示から「未読」を押すと URL に /unread が付く', async () => {
    await seedAndMountArticles('/reader/', MIXED_ARTICLES());
    await flushUntil(
      () => JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事A2', '記事B'])
    );
    findButton(el.querySelector('[aria-label="表示切替"]'), '未読').click();
    await flushUntil(
      () =>
        JSON.stringify(articleTitles()) === JSON.stringify(['記事A2', '記事B']) &&
        path() === `/reader/${enc('すべて')}/unread`
    );
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A2', '記事B']);
    expect(path()).toBe(`/reader/${enc('すべて')}/unread`);
    await settleApp();
  });

  it('popstate で /unread 付き URL の状態が画面へ反映される', async () => {
    await seedAndMountArticles('/reader/', MIXED_ARTICLES());
    await flushUntil(
      () => JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事A2', '記事B'])
    );
    window.history.pushState(null, '', `/reader/${enc('すべて')}/${FEED_A.id}/unread`);
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A2']));
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A2']);
    expect(activeFilterText()).toEqual(['未読']);
    await settleApp();
  });
});
