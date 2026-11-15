// URL パーマリンク (パス) と画面状態の同期の回帰テスト。
//
// 開いた URL が指す状態 (画面・ジャンル・フィード絞り込み) が
// 初期状態に反映されること、画面操作で URL が書き換わること、
// 存在しないジャンル・フィードを指定したら検証で落とされて
// URL も追随することを固定する。ハーネスは appCategoryAutoClear と同じ。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

const FEED_A = {
  id: 'b81e59da11f890d2', // https://feeds.rebuild.fm/rebuildfm のハッシュID
  title: 'Rebuild',
  url: 'https://feeds.rebuild.fm/rebuildfm',
  category: 'ポッドキャスト',
  isPrivate: false,
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
  isPrivate: true,
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '2026-11-15T01:00:00.000Z',
  unreadCount: 1,
};

let serverFeeds = [];

vi.mock('../src/lib/api.js', () => ({
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
