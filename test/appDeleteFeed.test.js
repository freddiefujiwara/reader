// 管理画面の削除フローを通すテスト。
//
// appAdmin はボタンの配置やカテゴリ文脈での削除を固定しているが、
// 「確認を出す → 確定で deleteFeed が呼ばれる → 管理一覧から消える →
// タイムラインへ戻るとローカルの記事からも消える」という破壊的操作の
// 一連の流れ自体は未検証だった。あわせてキャンセルと失敗時も固定する。
// ハーネスは appRoute と同じ (サーバー側のフィード一覧は可変にし、
// deleteFeed の成功時はサーバーからも消えたことにする)。
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
import { deleteFeed } from '../src/lib/api.js';
import { loadLocalArticles, saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

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

async function mountAdmin() {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([rec('art-a', FEED_A.id, '記事A'), rec('art-b', FEED_B.id, '記事B')]);
  window.history.pushState(null, '', '/reader/');
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(() => !!findButton(el, '管理'));
  findButton(el, '管理').click();
  await flushUntil(() => feedCards().length === 2);
  expect(errors).toEqual([]);
}

beforeEach(() => {
  errors = [];
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
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
  await settleApp();
  if (app) app.unmount();
  app = null;
  el = null;
});

describe('管理画面の削除フロー', () => {
  it('確認を経て削除すると、管理一覧から消え、タイムラインへ戻るとローカルの記事からも消える', async () => {
    await mountAdmin();
    const card = cardOf('Rebuild');
    findButton(card, '削除').click();
    await flushUntil(() => !!cardOf('Rebuild')?.querySelector('.delete-confirm'));
    // 確認が出ただけではまだ削除されない。
    expect(deleteFeed).not.toHaveBeenCalled();
    expect(cardOf('Rebuild').querySelector('.delete-confirm').textContent)
      .toContain('このフィードを削除しますか？');

    findButton(cardOf('Rebuild'), '本当に削除').click();
    await flushUntil(() => feedCards().length === 1);
    expect(errors).toEqual([]);
    expect(deleteFeed).toHaveBeenCalledWith('tok', FEED_A.id);
    expect(cardOf('Rebuild')).toBeUndefined();
    expect(cardOf('X freddie')).toBeTruthy();

    // タイムラインへ戻ると、背景更新の孤児掃除でローカルの記事からも消える。
    // 実行中の背景更新があると、それは削除前に取り始めた一覧で完了して
    // しまうため、ここでは起動時の更新が終わってから戻る (現実の操作でも
    // 削除の操作中に更新は終わっているのが通常)。
    await settleApp();
    // ブランドはトップへのページ遷移になったため、アプリ内で戻る
    // 経路はブラウザの戻る (popstate) だけになった。戻る操作相当で戻す。
    window.history.pushState(null, '', '/reader/');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await flushUntil(async () => {
      const records = await loadLocalArticles();
      return records.length === 1 && records[0].id === 'art-b'
        && JSON.stringify(articleTitles()) === JSON.stringify(['記事B']);
    });
    expect(errors).toEqual([]);
    const records = await loadLocalArticles();
    expect(records.map((r) => r.id)).toEqual(['art-b']);
    expect(articleTitles()).toEqual(['記事B']);
    await settleApp();
  });

  it('確認をキャンセルすると、削除されずにカードが残る', async () => {
    await mountAdmin();
    const card = cardOf('Rebuild');
    findButton(card, '削除').click();
    await flushUntil(() => !!cardOf('Rebuild')?.querySelector('.delete-confirm'));
    findButton(cardOf('Rebuild').querySelector('.delete-confirm'), 'キャンセル').click();
    await flushUntil(() => !cardOf('Rebuild')?.querySelector('.delete-confirm'));
    expect(errors).toEqual([]);
    expect(deleteFeed).not.toHaveBeenCalled();
    expect(feedCards().length).toBe(2);
    expect(cardOf('Rebuild')).toBeTruthy();
    // 削除ボタンが戻っている (通常表示に復帰)。
    expect(findButton(cardOf('Rebuild'), '削除')).toBeTruthy();
    await settleApp();
  });

  it('削除に失敗すると、エラーが出て、再試行で一覧が戻りフィードは残っている', async () => {
    deleteFeed.mockImplementation(async () => {
      throw new Error('boom');
    });
    await mountAdmin();
    const card = cardOf('Rebuild');
    findButton(card, '削除').click();
    await flushUntil(() => !!cardOf('Rebuild')?.querySelector('.delete-confirm'));
    findButton(cardOf('Rebuild'), '本当に削除').click();
    await flushUntil(() => el.textContent.includes('削除できませんでした'));
    expect(errors).toEqual([]);
    expect(deleteFeed).toHaveBeenCalledWith('tok', FEED_A.id);
    expect(el.textContent).toContain('削除できませんでした（boom）。');
    // エラー表示中は一覧がエラーパネルに置き換わる。再試行で一覧が
    // 戻り、削除できなかったフィードが残っていることを確認する。
    findButton(el, '再試行').click();
    await flushUntil(() => feedCards().length === 2);
    expect(errors).toEqual([]);
    expect(cardOf('Rebuild')).toBeTruthy();
    expect(cardOf('X freddie')).toBeTruthy();
    await settleApp();
  });
});
