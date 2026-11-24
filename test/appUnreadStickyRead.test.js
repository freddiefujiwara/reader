// 未読のみ表示で既読にしたカードを、その場では消さずに残す仕様の固定。
//
// PR #95 (要約を展開したら既読にする) の副作用で、未読のみ表示で
// 「もっと見る」を押すと展開した瞬間にカードが消えてしまった。
// 仕様変更後は、未読フィルタ有効中に既読へ遷移した記事はセッション内
// (メモリ上) の保持集合に入り、既読スタイルのまま一覧に残る。消える
// のは、フィード・カテゴリ・既読フィルタを切り替えて絞り込みを
// 再適用したときだけ。未読件数の表示は従来どおり即時に減る。
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
  unreadCount: 2,
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

vi.mock('../src/config.js', () => ({
  API_URL: 'https://example.com/exec',
  GOOGLE_CLIENT_ID: 'test-client-id',
}));

import App from '../src/App.vue';
import {
  deleteLocalArticles,
  loadLocalArticles,
  putLocalArticles,
  saveLocalFeeds,
} from '../src/lib/localDb.js';

const rec = (id, feedId, title, publishedAt) => ({
  id,
  feed_id: feedId,
  title,
  link: `https://example.com/${id}`,
  published_at: publishedAt,
  fetched_at: '2026-11-15T00:00:00.000Z',
  summary: '',
  author: '',
  audio_url: '',
  audio_url_at: '',
  audio_stale: false,
  duration_sec: 0,
  play_pos: 0,
  is_read: false,
  read_at: '',
  starred: false,
  star_state: '',
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

const cardByTitle = (title) =>
  [...el.querySelectorAll('.article-card')].find(
    (c) => c.querySelector('.article-title').textContent.trim() === title
  );

const headerUnread = () => {
  const pill = [...el.querySelectorAll('button')].find((b) => /^未読 \d+$/.test(b.textContent.trim()));
  return pill ? Number(pill.textContent.trim().split(' ')[1]) : null;
};

const clickFilter = (text) => {
  findButton(el.querySelector('[aria-label="表示切替"]'), text).click();
};

const feedChip = (title) =>
  [...el.querySelectorAll('[aria-label="フィードで絞り込み"] .chip')]
    .find((b) => b.textContent.includes(title));

const categoryChip = (name) =>
  [...el.querySelectorAll('[aria-label="カテゴリで絞り込み"] .chip')]
    .find((b) => b.textContent.trim() === name);

async function seedAndMount() {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([
    rec('art-a1', FEED_A.id, '記事A1', '2026-11-15T00:00:00.000Z'),
    rec('art-a2', FEED_A.id, '記事A2', '2026-11-14T00:00:00.000Z'),
    rec('art-b', FEED_B.id, '記事B', '2026-11-13T00:00:00.000Z'),
  ]);
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(() => articleTitles().length === 3);
  await settleApp();
  expect(articleTitles()).toEqual(['記事A1', '記事A2', '記事B']);
  expect(headerUnread()).toBe(3);
}

// 未読のみ表示へ切り替え、記事A1を「既読にする」で既読化する。
async function markA1ReadInUnreadView() {
  clickFilter('未読');
  await flushUntil(() => articleTitles().length === 3);
  findButton(cardByTitle('記事A1'), '既読にする').click();
  await flushUntil(
    () => headerUnread() === 2 && cardByTitle('記事A1')?.classList.contains('is-read')
  );
}

beforeEach(async () => {
  errors = [];
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
  document.body.innerHTML = '';
  window.scrollTo = () => {};
  const rows = await loadLocalArticles();
  await deleteLocalArticles(rows.map((r) => r.id));
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

describe('未読のみ表示で既読にしたカードの保持', () => {
  it('既読ボタンで既読化してもカードが残り、未読数だけ即時に減る', async () => {
    await seedAndMount();
    await markA1ReadInUnreadView();

    expect(articleTitles()).toEqual(['記事A1', '記事A2', '記事B']);
    const card = cardByTitle('記事A1');
    expect(card.classList.contains('is-read'), '既読スタイルになる').toBe(true);
    expect(card.querySelector('.unread-dot'), '未読ドットは消える').toBeNull();
    expect(findButton(card, '未読に戻す'), 'ボタンは未読に戻すへ変わる').toBeTruthy();
    expect(headerUnread()).toBe(2);
    expect(errors).toEqual([]);
  });

  it('既読フィルタを切り替え直すと、保持していた既読カードが消える', async () => {
    await seedAndMount();
    await markA1ReadInUnreadView();
    expect(articleTitles()).toEqual(['記事A1', '記事A2', '記事B']);

    clickFilter('すべて');
    await flushUntil(() => articleTitles().length === 3);
    clickFilter('未読');
    await flushUntil(() => articleTitles().length === 2);

    expect(articleTitles()).toEqual(['記事A2', '記事B']);
    expect(errors).toEqual([]);
  });

  it('フィードを切り替えると、保持していた既読カードが消える', async () => {
    await seedAndMount();
    await markA1ReadInUnreadView();

    feedChip('Rebuild').click();
    await flushUntil(() => articleTitles().length === 1);

    // Rebuild の未読は記事A2だけ (既読の記事A1は保持が解けて消える)。
    expect(articleTitles()).toEqual(['記事A2']);
    expect(errors).toEqual([]);
  });

  it('カテゴリを切り替えると、保持していた既読カードが消える', async () => {
    await seedAndMount();
    await markA1ReadInUnreadView();

    categoryChip('ポッドキャスト').click();
    await flushUntil(() => articleTitles().length === 1);

    expect(articleTitles()).toEqual(['記事A2']);
    expect(errors).toEqual([]);
  });

  it('すべて既読でもカードは残り、絞り込み直すと消える', async () => {
    await seedAndMount();
    clickFilter('未読');
    await flushUntil(() => articleTitles().length === 3);

    findButton(el, 'すべて既読').click();
    await flushUntil(() => headerUnread() === null);
    expect(articleTitles()).toEqual(['記事A1', '記事A2', '記事B']);
    expect(
      [...el.querySelectorAll('.article-card')].every((c) => c.classList.contains('is-read'))
    ).toBe(true);

    clickFilter('すべて');
    await flushUntil(() => articleTitles().length === 3);
    clickFilter('未読');
    await flushUntil(() => articleTitles().length === 0);
    expect(articleTitles()).toEqual([]);
    expect(errors).toEqual([]);
  });
});
