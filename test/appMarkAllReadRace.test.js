// 「すべて既読」を押してもすぐ反応せず、何度かタップしてようやく
// 効いた、という実機報告の再現テスト。
//
// 背景更新 (refreshOnce) は最後に reloadLocal で IndexedDB の中身から
// 画面の状態を作り直す。その読み取りは「読み取り開始時点の
// スナップショット」で、読み取り開始から状態への反映までの間に
// 付けた既読は、DB へ書けていても反映の瞬間に古いスナップショットで
// 上書きされ、未読へ巻き戻る (DB 層の競合は PR #36 で直したが、
// 画面状態の層には同じ穴が残っていた)。
//
// ここでは loadLocalArticles をゲートで包み、「スナップショットは
// 取れているが、呼び出し側へはまだ返っていない」という実機の
// 順序を決定的に作って、既読が巻き戻らないことを固定する。
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

// loadLocalArticles のゲート。armed の間は、スナップショットを
// 取ったうえで「解放されるまで呼び出し側へ返さない」。
const gate = vi.hoisted(() => ({ armed: false, pending: [] }));

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

vi.mock('../src/lib/localDb.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    loadLocalArticles: async (...args) => {
      const snapshot = await orig.loadLocalArticles(...args);
      if (!gate.armed) return snapshot;
      return new Promise((resolve) => {
        gate.pending.push(() => resolve(snapshot));
      });
    },
  };
});

import App from '../src/App.vue';
import { loadLocalArticles, saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

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

const headerUnread = () => {
  const pill = [...el.querySelectorAll('button')].find((b) => /^未読 \d+$/.test(b.textContent.trim()));
  return pill ? Number(pill.textContent.trim().split(' ')[1]) : null;
};

const feedChip = (title) =>
  [...el.querySelectorAll('[aria-label="フィードで絞り込み"] .chip')]
    .find((b) => b.textContent.includes(title));

// 保留中の読み取りを1件解放する (保留が出るまで待つ)。
async function releaseNextLoad() {
  await flushUntil(() => gate.pending.length >= 1);
  const release = gate.pending.shift();
  release();
  await flushRound();
}

async function releaseAllLoads() {
  gate.armed = false;
  while (gate.pending.length) gate.pending.shift()();
  await flushRound();
}

async function seedAndMount() {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([
    rec('art-a', FEED_A.id, '記事A', '2026-11-15T00:00:00.000Z'),
    rec('art-b', FEED_B.id, '記事B', '2026-11-14T00:00:00.000Z'),
  ]);
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']));
  await settleApp();
  expect(articleTitles()).toEqual(['記事A', '記事B']);
  expect(headerUnread()).toBe(2);
}

beforeEach(() => {
  errors = [];
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
  gate.armed = false;
  gate.pending = [];
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
  await releaseAllLoads();
  await settleApp();
  if (app) app.unmount();
  app = null;
  el = null;
});

describe('すべて既読と背景更新の読み直しの競合', () => {
  it('読み直しの保留中に付けた既読が、読み直しの反映で巻き戻らない', async () => {
    await seedAndMount();

    // 実機の録画と同じ状態にする: フィードを選択し、未読タブへ。
    feedChip('Rebuild').click();
    await flushRound();
    findButton(el, '未読').click();
    await flushRound();
    expect(articleTitles()).toEqual(['記事A']);

    // 背景更新を始め、最終段の reloadLocal の読み取りだけを
    // 「スナップショット取得済み・未返却」の状態で止める。
    gate.armed = true;
    findButton(el, '更新').click();
    await releaseNextLoad(); // 孤児チェックの読み取り
    await releaseNextLoad(); // 剪定の読み取り
    await flushUntil(() => gate.pending.length >= 1); // reloadLocal の読み取りが保留中

    // その間に「すべて既読」を押す。画面へは即座に効き、DB へも書ける。
    findButton(el, 'すべて既読').click();
    await flushUntil(() => headerUnread() === 1);
    expect(articleTitles()).toEqual([]);
    gate.armed = false;
    const records = await loadLocalArticles();
    expect(records.find((r) => r.id === 'art-a').is_read).toBe(true);
    gate.armed = true;

    // 保留していた読み直しを解放する。スナップショットは既読化の
    // 前に取られているため、この反映で既読が巻き戻ってはならない。
    await releaseAllLoads();
    await flushRound();
    await flushRound();
    expect(articleTitles()).toEqual([]);
    expect(headerUnread()).toBe(1);

    // 次の背景更新 (今度は新しいスナップショット) でも既読のまま。
    findButton(el, '更新').click();
    await settleApp();
    expect(articleTitles()).toEqual([]);
    expect(headerUnread()).toBe(1);
    expect(errors).toEqual([]);
  });

  it('読み直しの保留中に付けた1件の既読も、読み直しの反映で巻き戻らない', async () => {
    await seedAndMount();

    gate.armed = true;
    findButton(el, '更新').click();
    await releaseNextLoad(); // 孤児チェックの読み取り
    await releaseNextLoad(); // 剪定の読み取り
    await flushUntil(() => gate.pending.length >= 1); // reloadLocal の読み取りが保留中

    // その間に記事Aを「既読にする」。
    const cardA = [...el.querySelectorAll('.article-card')]
      .find((c) => c.querySelector('.article-title').textContent.trim() === '記事A');
    findButton(cardA, '既読にする').click();
    await flushUntil(() => headerUnread() === 1);
    expect(findButton(cardA, '未読に戻す')).toBeTruthy();

    // 保留していた読み直しを解放しても、既読のままであること。
    await releaseAllLoads();
    await flushRound();
    await flushRound();
    const cardA2 = [...el.querySelectorAll('.article-card')]
      .find((c) => c.querySelector('.article-title').textContent.trim() === '記事A');
    expect(findButton(cardA2, '未読に戻す')).toBeTruthy();
    expect(headerUnread()).toBe(1);
    expect(errors).toEqual([]);
  });
});
