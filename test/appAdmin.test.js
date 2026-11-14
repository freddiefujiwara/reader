// 管理画面 (App.vue) のコンポーネントテスト。API と取得経路だけを
// モックし、実際の App をマウントして「編集」ボタンの経路を踏む。
// 過去の不具合: フォームは一覧より上に開くため、下の方のフィードから
// 開くと画面の外に出て「押しても何も起きない」ように見えた。
// 開いたらフォームへスクロールすることをここで固定する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

// 移行後 (ハッシュID) の形をしたフィード一覧。
const FEEDS = [
  {
    id: 'b81e59da11f890d2',
    title: 'Rebuild',
    url: 'https://feeds.rebuild.fm/rebuildfm',
    category: 'ポッドキャスト',
    isPrivate: false,
    lastStatus: '200',
    lastError: '',
    lastFetchedAt: '2026-11-15T01:00:00.000Z',
    unreadCount: 3,
  },
  {
    id: '0858a4357049d0a0',
    title: '', // YouTube のタイトル補完待ち
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx',
    category: '教養・ラジオ',
    isPrivate: false,
    lastStatus: '200',
    lastError: '',
    lastFetchedAt: '2026-11-15T01:00:00.000Z',
    unreadCount: 0,
  },
  {
    id: '4a5a9e5990e4c47c',
    title: 'ゆる言語学ラジオ',
    url: 'https://api.robotstart.jp/api/v1/feeds/35d00481/get-feeds/podcast',
    category: 'ポッドキャスト',
    isPrivate: false,
    lastStatus: '200',
    lastError: '',
    lastFetchedAt: '2026-11-15T01:00:00.000Z',
    unreadCount: 1,
  },
  {
    id: '35797c975382389f',
    title: 'X freddie',
    url: 'https://a.ze.gs/x.freddie.xml',
    category: 'private',
    isPrivate: true,
    lastStatus: '200',
    lastError: '',
    lastFetchedAt: '2026-11-15T01:00:00.000Z',
    unreadCount: 46,
  },
];

vi.mock('../src/lib/api.js', () => ({
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({ ok: true, feeds: FEEDS, articles: [] })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: FEEDS })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  saveFeed: vi.fn(async () => ({ ok: true, feed: FEEDS[0] })),
}));

vi.mock('../src/lib/feedFetch.js', () => ({
  fetchAllFeeds: vi.fn(async () => []),
  fetchFeedXml: vi.fn(async () => ''),
}));

import App from '../src/App.vue';
import { saveFeed, listFeeds } from '../src/lib/api.js';
import { fetchFeedXml } from '../src/lib/feedFetch.js';

const scrollCalls = [];
let app = null;
let el = null;
let errors = [];

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

function findButton(root, text) {
  return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
}

async function mountAdmin() {
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flush();
  findButton(el, '管理').click();
  await flush();
  expect(el.querySelectorAll('.feed-card').length).toBe(FEEDS.length);
}

async function openEdit(idx) {
  const card = el.querySelectorAll('.feed-card')[idx];
  findButton(card, '編集').click();
  await flush();
  return el.querySelector('.feed-form');
}

beforeEach(() => {
  errors = [];
  scrollCalls.length = 0;
  document.body.innerHTML = '';
  localStorage.clear();
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok', role: 'owner', expiresAt: null })
  );
  // jsdom はスクロールを実装しないため、呼び出し自体を記録する。
  window.HTMLElement.prototype.scrollIntoView = function (opts) {
    scrollCalls.push({ el: this, opts });
  };
  vi.clearAllMocks();
});

afterEach(() => {
  if (app) app.unmount();
  app = null;
  el = null;
});

describe('管理画面の編集フォーム', () => {
  it('編集を押すと、そのフィードの内容でフォームが開き、フォームへスクロールする', async () => {
    await mountAdmin();
    const form = await openEdit(0);
    expect(errors).toEqual([]);
    expect(form, '編集フォームが開く').toBeTruthy();
    expect(form.querySelector('.feed-form-title').textContent).toContain('フィードを編集');
    expect(form.querySelector('.field-static').textContent).toBe('Rebuild');
    expect(form.querySelector('#feed-category').value).toBe('ポッドキャスト');
    // 開いたフォーム自体へ scrollIntoView されている (画面外に開きっぱなしにしない)。
    const call = scrollCalls.find((c) => c.el === form);
    expect(call, 'フォームへのスクロール').toBeTruthy();
    expect(call.opts).toMatchObject({ block: 'start' });
  });

  it('タイトル未取得のフィードでは「（未取得）」と表示して開ける', async () => {
    await mountAdmin();
    const form = await openEdit(1);
    expect(errors).toEqual([]);
    expect(form, '編集フォームが開く').toBeTruthy();
    expect(form.querySelector('.field-static').textContent).toBe('（未取得）');
    expect(scrollCalls.some((c) => c.el === form)).toBe(true);
  });

  it('ジャンルを変更して保存すると、元の ID / タイトル / URL のまま saveFeed へ渡り、フォームが閉じる', async () => {
    await mountAdmin();
    const form = await openEdit(0);
    const input = form.querySelector('#feed-category');
    input.value = '新しいジャンル';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    expect(errors).toEqual([]);
    expect(saveFeed).toHaveBeenCalledTimes(1);
    const [token, payload] = saveFeed.mock.calls[0];
    expect(token).toBe('tok');
    expect(payload).toMatchObject({
      id: FEEDS[0].id,
      title: 'Rebuild',
      url: 'https://feeds.rebuild.fm/rebuildfm',
      category: '新しいジャンル',
    });
    expect('enabled' in payload).toBe(false);
    expect(el.querySelector('.feed-form'), '保存後はフォームが閉じる').toBeNull();
  });

  it('追加フォームを開いたときもフォームへスクロールする', async () => {
    await mountAdmin();
    findButton(el, 'フィードを追加').click();
    await flush();
    const form = el.querySelector('.feed-form');
    expect(form, '追加フォームが開く').toBeTruthy();
    expect(form.querySelector('.feed-form-title').textContent).toContain('フィードを追加');
    expect(scrollCalls.some((c) => c.el === form)).toBe(true);
  });
});

describe('管理画面のプライベート表示', () => {
  it('isPrivate なフィードでも「プライベート」バッジを表示しない', async () => {
    await mountAdmin();
    expect(errors).toEqual([]);
    // 対象フィード自体は通常どおり描画される。
    const titles = [...el.querySelectorAll('.feed-card .feed-name')].map((n) => n.textContent.trim());
    expect(titles).toContain('X freddie');
    // バッジ (private-badge) も「プライベート」の文言も出ない。
    expect(el.querySelector('.private-badge')).toBeNull();
    expect(el.textContent).not.toContain('プライベート');
  });
});

describe('管理画面のジャンル絞り込み', () => {
  const genreTablist = () => el.querySelector('[aria-label="ジャンルで絞り込み"]');
  const moveButtons = () =>
    el.querySelectorAll('button[aria-label="上へ移動"], button[aria-label="下へ移動"]');
  const cardTitles = () =>
    [...el.querySelectorAll('.feed-card .feed-name')].map((n) => n.textContent.trim());

  it('絞っていないときは全件に移動ボタンが出る', async () => {
    await mountAdmin();
    expect(genreTablist(), 'ジャンルタブ行が出る').toBeTruthy();
    expect(el.querySelectorAll('.feed-card').length).toBe(FEEDS.length);
    expect(moveButtons().length).toBe(FEEDS.length * 2);
  });

  it('ジャンルタブで絞るとそのジャンルだけになり、移動ボタンが消える (編集・削除は残る)', async () => {
    await mountAdmin();
    findButton(genreTablist(), 'ポッドキャスト').click();
    await flush();
    expect(errors).toEqual([]);
    expect(cardTitles()).toEqual(['Rebuild', 'ゆる言語学ラジオ']);
    expect(moveButtons().length).toBe(0);
    const card = el.querySelector('.feed-card');
    expect(findButton(card, '編集'), '編集ボタンは残る').toBeTruthy();
    expect(findButton(card, '削除'), '削除ボタンは残る').toBeTruthy();
  });

  it('「すべて」に戻すと全件と移動ボタンが戻る', async () => {
    await mountAdmin();
    findButton(genreTablist(), '教養・ラジオ').click();
    await flush();
    expect(el.querySelectorAll('.feed-card').length).toBe(1);
    expect(moveButtons().length).toBe(0);
    findButton(genreTablist(), 'すべて').click();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelectorAll('.feed-card').length).toBe(FEEDS.length);
    expect(moveButtons().length).toBe(FEEDS.length * 2);
  });

  it('絞り込みは管理画面側の状態として保持され、タイムラインと行き来しても残る', async () => {
    await mountAdmin();
    findButton(genreTablist(), 'ポッドキャスト').click();
    await flush();
    expect(el.querySelectorAll('.feed-card').length).toBe(2);
    findButton(el, '← タイムラインに戻る').click();
    await flush();
    findButton(el, '管理').click();
    await flush();
    expect(errors).toEqual([]);
    // タイムラインのカテゴリ選択とは別の状態なので、戻っても絞り込みは維持される。
    expect(el.querySelectorAll('.feed-card').length).toBe(2);
    expect(moveButtons().length).toBe(0);
    const active = genreTablist().querySelector('.chip.active');
    expect(active.textContent.trim()).toBe('ポッドキャスト');
  });
});

describe('管理画面の YouTube チャンネル URL 追加', () => {
  // サーバーが返す解決済みフィード: URL は /channel/ の正規形、タイトル補完済み。
  const RESOLVED = {
    id: 'a1b2c3d4e5f60708',
    title: 'rakutentech',
    url: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A',
    category: '',
    isPrivate: false,
    lastStatus: '',
    lastError: '',
    lastFetchedAt: '',
    unreadCount: 0,
  };
  let saved = false;

  beforeEach(() => {
    saved = false;
    // 保存が済むと一覧に解決済みフィードが現れる、というサーバーの応答を再現する。
    saveFeed.mockImplementation(async () => {
      saved = true;
      return { ok: true, feed: RESOLVED };
    });
    listFeeds.mockImplementation(async () => ({
      ok: true,
      feeds: saved ? [...FEEDS, RESOLVED] : FEEDS,
    }));
  });

  afterEach(() => {
    saveFeed.mockImplementation(async () => ({ ok: true, feed: FEEDS[0] }));
    listFeeds.mockImplementation(async () => ({ ok: true, feeds: FEEDS }));
  });

  async function submitAddUrl(url) {
    await mountAdmin();
    findButton(el, 'フィードを追加').click();
    await flush();
    const form = el.querySelector('.feed-form');
    const input = form.querySelector('#feed-url');
    input.value = url;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
  }

  const cardTitles = () =>
    [...el.querySelectorAll('.feed-card .feed-name')].map((n) => n.textContent.trim());

  it('@ハンドルの URL は取得を省いてタイトル空で保存し、一覧に解決済みタイトルが出る', async () => {
    await submitAddUrl('https://www.youtube.com/@rakutentech');
    expect(errors).toEqual([]);
    // プロキシ取得は走らない。
    expect(fetchFeedXml).not.toHaveBeenCalled();
    // 貼った URL のまま・タイトル '' で saveFeed へ渡る (ID は送らない)。
    expect(saveFeed).toHaveBeenCalledTimes(1);
    const [token, payload] = saveFeed.mock.calls[0];
    expect(token).toBe('tok');
    expect(payload).toEqual({
      title: '',
      url: 'https://www.youtube.com/@rakutentech',
      category: '',
      isPrivate: false,
    });
    // 保存後はフォームが閉じ、サーバーが返した解決済みフィードが一覧に出る。
    expect(el.querySelector('.feed-form'), '保存後はフォームが閉じる').toBeNull();
    expect(cardTitles()).toContain('rakutentech');
    const urls = [...el.querySelectorAll('.feed-card .feed-url')].map((n) => n.textContent.trim());
    expect(urls).toContain('https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A');
  });

  it('/channel/UC... の URL も取得を省いて保存する', async () => {
    await submitAddUrl('https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A');
    expect(errors).toEqual([]);
    expect(fetchFeedXml).not.toHaveBeenCalled();
    expect(saveFeed).toHaveBeenCalledTimes(1);
    const [, payload] = saveFeed.mock.calls[0];
    expect(payload.title).toBe('');
    expect(payload.url).toBe('https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A');
    expect(cardTitles()).toContain('rakutentech');
  });
});
