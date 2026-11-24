// フィード・ジャンルの選択を変えたらタイムライン先頭へスクロール
// することの回帰テスト。
//
// チャンネル (フィード) を移動するたびに手動で一番上まで戻して
// いたため、選択変更時はアプリ側で先頭へ寄せることにした。対象は
// ユーザー操作による選択変更だけで、初期表示や背景更新では
// スクロール位置を動かさないこともあわせて固定する。
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
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  saveFeed: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../src/lib/feedFetch.js', () => ({
  fetchAllFeeds: vi.fn(async () => []),
  fetchFeedXml: vi.fn(async () => ''),
  fetchOneFeed: vi.fn(async (feed) => ({ feed, ok: false, entries: [], error: new Error('not mocked') })),
}));

// ローカルでは API_URL はプレースホルダで空になり、起動処理が
// 止まってしまうため、値が入った形に差し替える (appPlayer と同様)。
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
let scrollToCalls = [];

const flushRound = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

// 条件が成り立つまで flush を繰り返す (appGenreReflect と同じ作法)。
const flushUntil = async (cond, maxRounds = 120) => {
  for (let i = 0; i < maxRounds; i += 1) {
    if (await cond()) return true;
    await flushRound();
  }
  return !!(await cond());
};

// ヘッダーの更新ボタンは背景更新の実行中だけ「更新中…」になる。
const isRefreshingShown = () =>
  !!el && [...el.querySelectorAll('button')].some((b) => b.textContent.includes('更新中'));

// 背景更新が落ち着くまで待つ (appGenreReflect と同じ作法)。
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
  [...el.querySelectorAll('[aria-label="カテゴリで絞り込み"] .chip')].map((b) => b.textContent.trim());
const feedChips = () => [...el.querySelectorAll('[aria-label="フィードで絞り込み"] .chip')];
const articleTitles = () =>
  [...el.querySelectorAll('.article-card .article-title')].map((n) => n.textContent.trim());

async function seedAndMount() {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([rec('art-a', FEED_A.id, '記事A'), rec('art-b', FEED_B.id, '記事B')]);
  window.history.pushState(null, '', '/reader/');
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(
    () =>
      JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']) &&
      JSON.stringify(categoryChips()) === JSON.stringify(['ポッドキャスト', 'private'])
  );
  expect(articleTitles(), 'タイムラインに記事が2件出る').toEqual(['記事A', '記事B']);
  await settleApp();
}

beforeEach(() => {
  errors = [];
  scrollToCalls = [];
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
  document.body.innerHTML = '';
  window.scrollTo = function (opts) {
    scrollToCalls.push(opts);
  };
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

describe('選択変更時の先頭スクロール', () => {
  it('初期表示ではスクロールしない', async () => {
    await seedAndMount();
    expect(errors).toEqual([]);
    expect(scrollToCalls).toEqual([]);
  });

  it('フィードチップで切り替えると先頭へスクロールし、解除でもう一度スクロールする', async () => {
    await seedAndMount();
    const chipB = feedChips().find((b) => b.textContent.includes('X freddie'));
    chipB.click();
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事B']));
    expect(articleTitles()).toEqual(['記事B']);
    expect(scrollToCalls).toEqual([{ top: 0 }]);

    // 再タップで解除して全件表示に戻るときも先頭へ寄せる。
    chipB.click();
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']));
    expect(articleTitles()).toEqual(['記事A', '記事B']);
    expect(scrollToCalls).toEqual([{ top: 0 }, { top: 0 }]);
    expect(errors).toEqual([]);
  });

  it('カテゴリチップで切り替えると先頭へスクロールする', async () => {
    await seedAndMount();
    findButton(el.querySelector('[aria-label="カテゴリで絞り込み"]'), 'ポッドキャスト').click();
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A']));
    expect(articleTitles()).toEqual(['記事A']);
    expect(scrollToCalls).toEqual([{ top: 0 }]);
    expect(errors).toEqual([]);
  });

  it('未読のみ表示への切替でも先頭へスクロールし、同じ表示の再押下ではスクロールしない', async () => {
    await seedAndMount();
    const tabs = el.querySelector('.view-tabs');
    findButton(tabs, '未読').click();
    await flushRound();
    expect(scrollToCalls).toEqual([{ top: 0 }]);
    // 既に未読のみ表示なので、もう一度押しても選択は変わらず
    // スクロールもしない。
    findButton(tabs, '未読').click();
    await flushRound();
    expect(scrollToCalls).toEqual([{ top: 0 }]);
    expect(errors).toEqual([]);
  });

  it('背景更新 (手動更新) ではスクロールしない', async () => {
    await seedAndMount();
    expect(scrollToCalls).toEqual([]);
    findButton(el, '更新').click();
    await settleApp();
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A', '記事B']);
    expect(scrollToCalls).toEqual([]);
  });
});
