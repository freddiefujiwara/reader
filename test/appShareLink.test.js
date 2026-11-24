// 管理画面最下部の「共有リンク」セクションのコンポーネントテスト。
// API だけをモックし、実際の App をマウントして発行・無効化の
// 経路を踏む。トークンはダミー値を使う。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

const FEEDS = [
  {
    id: 'b81e59da11f890d2',
    title: 'Rebuild',
    url: 'https://feeds.rebuild.fm/rebuildfm',
    category: 'ポッドキャスト',
    lastStatus: '200',
    lastError: '',
    lastFetchedAt: '2026-11-15T01:00:00.000Z',
    unreadCount: 3,
  },
];
const EXPIRES = '2026-12-16T05:47:00.000Z';

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: EXPIRES })),
  listArticles: vi.fn(async () => ({ ok: true, feeds: FEEDS, articles: [] })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: FEEDS })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
  saveFeed: vi.fn(async () => ({ ok: true, feed: FEEDS[0] })),
}));

vi.mock('../src/lib/feedFetch.js', () => ({
  fetchAllFeeds: vi.fn(async () => []),
  fetchFeedXml: vi.fn(async () => ''),
  fetchOneFeed: vi.fn(async (feed) => ({ feed, ok: false, entries: [], error: new Error('not mocked') })),
}));

import App from '../src/App.vue';
import { getShareLinkStatus, issueShareLink, revokeShareLink } from '../src/lib/api.js';
import { formatShareExpiry } from '../src/lib/shareLink.js';

let app = null;
let el = null;
let errors = [];
let writeText = null;

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

function findButton(root, text) {
  return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
}

function panel() {
  return el.querySelector('.share-link-panel');
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
  expect(panel(), '共有リンクセクションが出る').toBeTruthy();
}

beforeEach(() => {
  errors = [];
  document.body.innerHTML = '';
  localStorage.clear();
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok', role: 'owner', expiresAt: null })
  );
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.scrollTo = function () {};
  writeText = vi.fn(async () => {});
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  vi.clearAllMocks();
  getShareLinkStatus.mockImplementation(async () => ({ ok: true, active: false, expiresAt: null }));
  issueShareLink.mockImplementation(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: EXPIRES }));
  revokeShareLink.mockImplementation(async () => ({ ok: true }));
});

afterEach(() => {
  if (app) app.unmount();
  app = null;
  el = null;
});

describe('共有リンクの状態表示', () => {
  it('リンクが無い状態を開くと、その旨と発行ボタンだけが出る', async () => {
    await mountAdmin();
    expect(errors).toEqual([]);
    expect(getShareLinkStatus).toHaveBeenCalledWith('tok');
    expect(panel().textContent).toContain('有効なリンクはありません。');
    expect(findButton(panel(), 'リンクを発行する')).toBeTruthy();
    expect(findButton(panel(), 'リンクを無効化する')).toBeUndefined();
  });

  it('有効なリンクがあると、期限と無効化ボタンが出る', async () => {
    getShareLinkStatus.mockImplementation(async () => ({ ok: true, active: true, expiresAt: EXPIRES }));
    await mountAdmin();
    expect(panel().textContent).toContain('有効なリンクがあります');
    expect(panel().textContent).toContain(formatShareExpiry(EXPIRES));
    expect(findButton(panel(), 'リンクを無効化する')).toBeTruthy();
  });

  it('状態の取得に失敗するとエラーが出る', async () => {
    getShareLinkStatus.mockImplementation(async () => { throw new Error('boom'); });
    await mountAdmin();
    expect(panel().textContent).toContain('共有リンクの状態を取得できませんでした（boom）。');
  });
});

describe('共有リンクの発行', () => {
  it('確認を経て発行すると、URL と「発行直後だけ」の注記が出る', async () => {
    await mountAdmin();
    findButton(panel(), 'リンクを発行する').click();
    await flush();
    expect(issueShareLink).not.toHaveBeenCalled();
    expect(panel().textContent).toContain('共有リンクを発行しますか？');
    findButton(panel(), '発行する').click();
    await flush();
    expect(issueShareLink).toHaveBeenCalledWith('tok');
    const input = panel().querySelector('.share-url');
    expect(input.value).toBe(`${window.location.origin}/reader/#share=dummy-share-token`);
    expect(panel().textContent).toContain('表示できるのは発行直後だけです');
    expect(panel().textContent).toContain('有効なリンクがあります');
  });

  it('有効なリンクがあるときの確認には、旧リンクが使えなくなる旨が出る', async () => {
    getShareLinkStatus.mockImplementation(async () => ({ ok: true, active: true, expiresAt: EXPIRES }));
    await mountAdmin();
    findButton(panel(), 'リンクを発行する').click();
    await flush();
    expect(panel().textContent).toContain('いまのリンクは使えなくなります');
  });

  it('確認をキャンセルすると発行しない', async () => {
    await mountAdmin();
    findButton(panel(), 'リンクを発行する').click();
    await flush();
    findButton(panel(), 'キャンセル').click();
    await flush();
    expect(issueShareLink).not.toHaveBeenCalled();
    expect(findButton(panel(), 'リンクを発行する')).toBeTruthy();
  });

  it('コピーボタンで URL をクリップボードへ渡す', async () => {
    await mountAdmin();
    findButton(panel(), 'リンクを発行する').click();
    await flush();
    findButton(panel(), '発行する').click();
    await flush();
    findButton(panel(), 'コピー').click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/reader/#share=dummy-share-token`);
    expect(findButton(panel(), 'コピーしました')).toBeTruthy();
  });

  it('発行に失敗するとエラーが出て、URL は出ない', async () => {
    issueShareLink.mockImplementation(async () => { throw new Error('boom'); });
    await mountAdmin();
    findButton(panel(), 'リンクを発行する').click();
    await flush();
    findButton(panel(), '発行する').click();
    await flush();
    expect(panel().textContent).toContain('リンクを発行できませんでした（boom）。');
    expect(panel().querySelector('.share-url')).toBeNull();
  });
});

describe('共有リンクの無効化', () => {
  it('確認を経て無効化すると、状態が「なし」に戻る', async () => {
    getShareLinkStatus.mockImplementation(async () => ({ ok: true, active: true, expiresAt: EXPIRES }));
    await mountAdmin();
    findButton(panel(), 'リンクを無効化する').click();
    await flush();
    expect(revokeShareLink).not.toHaveBeenCalled();
    expect(panel().textContent).toContain('共有リンクを無効化しますか？');
    findButton(panel(), '無効化する').click();
    await flush();
    expect(revokeShareLink).toHaveBeenCalledWith('tok');
    expect(panel().textContent).toContain('有効なリンクはありません。');
    expect(findButton(panel(), 'リンクを無効化する')).toBeUndefined();
  });

  it('無効化に失敗するとエラーが出て、状態は有効のまま', async () => {
    getShareLinkStatus.mockImplementation(async () => ({ ok: true, active: true, expiresAt: EXPIRES }));
    revokeShareLink.mockImplementation(async () => { throw new Error('boom'); });
    await mountAdmin();
    findButton(panel(), 'リンクを無効化する').click();
    await flush();
    findButton(panel(), '無効化する').click();
    await flush();
    expect(panel().textContent).toContain('リンクを無効化できませんでした（boom）。');
    expect(panel().textContent).toContain('有効なリンクがあります');
  });
});
