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
    enabled: true,
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
    enabled: true,
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
    enabled: false,
    isPrivate: false,
    lastStatus: '200',
    lastError: '',
    lastFetchedAt: '2026-11-15T01:00:00.000Z',
    unreadCount: 1,
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
import { saveFeed } from '../src/lib/api.js';

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

  it('無効なフィードでは「有効にする」のチェックが外れている', async () => {
    await mountAdmin();
    const form = await openEdit(2);
    expect(form.querySelector('.field-check input').checked).toBe(false);
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
      enabled: true,
    });
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
