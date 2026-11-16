// 「すべて既読」の確認ステップとスコープの固定テスト。
//
// すべて既読は端末ローカル (IndexedDB) だけの操作で、誤タップで
// 大量に既読化しないよう、対象が100件以上のときだけ実行前に
// 下部バー内で確認を取る。100件未満は確認なしで即座に実行する。
// ここでは (1) 100件未満では確認なしで即座に既読化されること、
// (2) 対象が現在のスコープ (フィード／全体) 内の未読だけである
// こと、(3) 未読ゼロではボタンが押せないこと、(4) 未読のみ表示へ
// 即時に反映されること、(5) 境界 (99件では確認なし／100件では
// 確認あり) と100件でのキャンセルを固定する。
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
import { loadLocalArticles, saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

const rec = (id, feedId, title, publishedAt, isRead = false) => ({
  id,
  feed_id: feedId,
  title,
  link: `https://example.com/${id}`,
  published_at: publishedAt,
  fetched_at: '2026-11-15T00:00:00.000Z',
  summary: '',
  author: '',
  audio_url: '',
  duration_sec: 0,
  play_pos: 0,
  is_read: isRead,
  read_at: isRead ? '2026-11-15T01:00:00.000Z' : '',
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

const headerUnread = () => {
  const pill = [...el.querySelectorAll('button')].find((b) => /^未読 \d+$/.test(b.textContent.trim()));
  return pill ? Number(pill.textContent.trim().split(' ')[1]) : null;
};

const feedChip = (title) =>
  [...el.querySelectorAll('[aria-label="フィードで絞り込み"] .chip')]
    .find((b) => b.textContent.includes(title));

const confirmText = () => {
  const node = el.querySelector('.mark-all-confirm-text');
  return node ? node.textContent.trim() : null;
};

const readFlags = async () => {
  const records = await loadLocalArticles();
  const flags = {};
  records.forEach((r) => { flags[r.id] = r.is_read; });
  return flags;
};

async function seedAndMount(allRead = false) {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([
    rec('art-a1', FEED_A.id, '記事A1', '2026-11-15T00:00:00.000Z', allRead),
    rec('art-a2', FEED_A.id, '記事A2', '2026-11-14T00:00:00.000Z', allRead),
    rec('art-b', FEED_B.id, '記事B', '2026-11-13T00:00:00.000Z', allRead),
  ]);
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(() => articleTitles().length === 3);
  await settleApp();
  expect(articleTitles()).toEqual(['記事A1', '記事A2', '記事B']);
}

// 境界テスト用に、1フィードへ大量の未読記事を用意してマウントする。
async function seedBulkAndMount(count) {
  const feed = { ...FEED_A, unreadCount: count };
  serverFeeds = [feed];
  await saveLocalFeeds([feed]);
  const base = Date.parse('2026-11-15T00:00:00.000Z');
  const records = [];
  for (let i = 0; i < count; i += 1) {
    records.push(rec(
      `bulk-${i + 1}`,
      FEED_A.id,
      `記事${i + 1}`,
      new Date(base - i * 60000).toISOString()
    ));
  }
  await putLocalArticles(records);
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(() => headerUnread() === count);
  await settleApp();
  expect(headerUnread()).toBe(count);
}

// 大量記事の既読フラグを bulk-1 から順に配列で返す。
const bulkReadFlags = async (count) => {
  const flags = await readFlags();
  return Array.from({ length: count }, (_, i) => flags[`bulk-${i + 1}`]);
};

beforeEach(() => {
  errors = [];
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
  document.body.innerHTML = '';
  window.scrollTo = () => {};
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

describe('すべて既読の確認とスコープ', () => {
  it('100件未満では確認なしで即座に全体が既読化され、未読数が追随する', async () => {
    await seedAndMount();
    expect(headerUnread()).toBe(3);

    const btn = findButton(el, 'すべて既読');
    expect(btn.disabled).toBe(false);
    btn.click();
    await flushUntil(() => headerUnread() === null);

    // 確認は出ず、そのまま既読化されている。
    expect(confirmText()).toBe(null);
    expect(await readFlags()).toEqual({ 'art-a1': true, 'art-a2': true, 'art-b': true });

    // 未読ゼロになったボタンは押せない。
    expect(findButton(el, 'すべて既読').disabled).toBe(true);
    expect(errors).toEqual([]);
  });

  it('フィードで絞った範囲だけが既読化され、範囲外は未読のまま', async () => {
    await seedAndMount();
    feedChip('Rebuild').click();
    await flushRound();
    expect(articleTitles()).toEqual(['記事A1', '記事A2']);

    findButton(el, 'すべて既読').click();
    await flushUntil(() => headerUnread() === 1);
    expect(confirmText()).toBe(null);
    expect(await readFlags()).toEqual({ 'art-a1': true, 'art-a2': true, 'art-b': false });
    expect(errors).toEqual([]);
  });

  it('未読が無ければボタンは押せない', async () => {
    await seedAndMount(true);
    expect(headerUnread()).toBe(null);
    const btn = findButton(el, 'すべて既読');
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    expect(errors).toEqual([]);
  });

  it('未読のみ表示では、既読化した記事が即座に一覧から消える', async () => {
    await seedAndMount();
    findButton(el, '未読').click();
    await flushRound();
    expect(articleTitles()).toEqual(['記事A1', '記事A2', '記事B']);

    findButton(el, 'すべて既読').click();
    await flushUntil(() => articleTitles().length === 0);
    expect(headerUnread()).toBe(null);
    expect(await readFlags()).toEqual({ 'art-a1': true, 'art-a2': true, 'art-b': true });
    expect(errors).toEqual([]);
  });

  it('99件では確認なしで即座に既読化される (境界の下)', async () => {
    await seedBulkAndMount(99);
    findButton(el, 'すべて既読').click();
    await flushUntil(() => headerUnread() === null);
    expect(confirmText()).toBe(null);
    expect(await bulkReadFlags(99)).toEqual(Array(99).fill(true));
    expect(errors).toEqual([]);
  });

  it('100件では確認を経て初めて既読化される (境界の上)', async () => {
    await seedBulkAndMount(100);
    const btn = findButton(el, 'すべて既読');
    expect(btn.disabled).toBe(false);
    btn.click();
    await flushRound();

    // 確認が出ただけでは、まだ何も既読になっていない。
    expect(confirmText()).toBe('未読100件をすべて既読にしますか？');
    expect(headerUnread()).toBe(100);
    expect(await bulkReadFlags(100)).toEqual(Array(100).fill(false));

    findButton(el, 'すべて既読にする').click();
    await flushUntil(() => headerUnread() === null);
    expect(await bulkReadFlags(100)).toEqual(Array(100).fill(true));

    // 確認は閉じ、未読ゼロになったボタンは押せない。
    expect(confirmText()).toBe(null);
    expect(findButton(el, 'すべて既読').disabled).toBe(true);
    expect(errors).toEqual([]);
  });

  it('100件ではキャンセルで何も変わらず、確認が閉じる', async () => {
    await seedBulkAndMount(100);
    findButton(el, 'すべて既読').click();
    await flushRound();
    expect(confirmText()).toBe('未読100件をすべて既読にしますか？');

    findButton(el, 'キャンセル').click();
    await flushRound();
    expect(confirmText()).toBe(null);
    expect(headerUnread()).toBe(100);
    expect(await bulkReadFlags(100)).toEqual(Array(100).fill(false));
    expect(findButton(el, 'すべて既読').disabled).toBe(false);
    expect(errors).toEqual([]);
  });
});
