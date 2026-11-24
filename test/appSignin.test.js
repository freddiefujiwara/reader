// サインイン画面 (ゲート) の表示と文言。ハーネスは appSessionExpiry と同じ。
//
// - 起動中はボタンではなくスピナー＋「読み込んでいます…」が出る
// - GIS スクリプトが読み込めないと、理由がサインインボックスに出る
// - サインイン交換の失敗は汎用文言 (内部メッセージは出さない)、
//   forbidden のときだけ権限なしの文言に振り分ける
// - 無効な共有リンクは一時アクセスリンクの文言で案内する
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true, sessionToken: 'tok', role: 'owner', expiresAt: null })),
  exchangeShare: vi.fn(async () => ({ ok: true, sessionToken: 'tok', role: 'readonly', expiresAt: null })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  getFeedStats: vi.fn(async () => ({ ok: true, stats: {} })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  listArticles: vi.fn(async () => ({ ok: true, feeds: [], articles: [] })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: [] })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
  saveFeed: vi.fn(async () => ({ ok: true, feed: null })),
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
import { exchangeSession, exchangeShare } from '../src/lib/api.js';

let app = null;
let el = null;
let errors = [];
let credentialCallback = null;

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

const signinBox = () => (el ? el.querySelector('.signin-box') : null);

function mountApp() {
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
}

function installGoogle() {
  credentialCallback = null;
  window.google = {
    accounts: {
      id: {
        initialize: vi.fn((opts) => { credentialCallback = opts.callback; }),
        renderButton: vi.fn(),
        disableAutoSelect: vi.fn(),
      },
    },
  };
}

beforeEach(() => {
  errors = [];
  document.body.innerHTML = '';
  window.scrollTo = () => {};
  window.history.pushState(null, '', '/');
  localStorage.clear();
  delete window.google;
  vi.clearAllMocks();
});

afterEach(async () => {
  for (let i = 0; i < 5; i += 1) await flushRound();
  if (app) app.unmount();
  app = null;
  el = null;
  delete window.google;
});

describe('サインイン画面の表示', () => {
  it('起動中はスピナーと「読み込んでいます…」が出て、ボタンは出ない', async () => {
    mountApp();
    // マウント直後 (booting 中) の同期描画を見る。
    const box = signinBox();
    expect(box).not.toBeNull();
    expect(box.querySelector('.spinner')).not.toBeNull();
    expect(box.textContent).toContain('読み込んでいます…');
    expect(box.textContent).not.toContain('サインインしています…');
    expect(errors).toEqual([]);
  });

  it('GIS が読み込めないと、スクリプト読み込み失敗の案内が出る', async () => {
    mountApp();
    await flushUntil(() => signinBox() && signinBox().textContent.includes('Googleログインが必要です'));
    expect(errors).toEqual([]);
    expect(signinBox().textContent).toContain('Googleログインスクリプトの読み込みに失敗しました。広告ブロック等を解除して再読み込みしてください。');
  });

  it('GIS がある場合はボタンが pill で描画され、失敗の案内は出ない', async () => {
    installGoogle();
    mountApp();
    await flushUntil(() => credentialCallback);
    expect(errors).toEqual([]);
    const renderButton = window.google.accounts.id.renderButton;
    expect(renderButton).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ shape: 'pill' }));
    expect(signinBox().textContent).not.toContain('読み込みに失敗しました');
  });

  it('サインイン交換が失敗すると汎用文言になり、内部メッセージは出ない', async () => {
    installGoogle();
    exchangeSession.mockImplementation(async () => { throw new Error('invalid_token_detail'); });
    mountApp();
    await flushUntil(() => credentialCallback);
    credentialCallback({ credential: 'dummy' });
    await flushUntil(() => el.textContent.includes('ログインに失敗しました'));
    expect(errors).toEqual([]);
    expect(el.textContent).toContain('ログインに失敗しました。もう一度お試しください。');
    expect(el.textContent).not.toContain('invalid_token_detail');
  });

  it('サインイン交換が forbidden なら権限なしの文言になる', async () => {
    installGoogle();
    exchangeSession.mockImplementation(async () => { throw new Error('forbidden'); });
    mountApp();
    await flushUntil(() => credentialCallback);
    credentialCallback({ credential: 'dummy' });
    await flushUntil(() => el.textContent.includes('このアカウントでは利用できません'));
    expect(errors).toEqual([]);
    expect(el.textContent).toContain('このアカウントでは利用できません。');
    expect(el.textContent).not.toContain('ログインに失敗しました');
  });

  it('無効な共有リンクは一時アクセスリンクの文言で案内する', async () => {
    exchangeShare.mockImplementation(async () => { throw new Error('unauthorized'); });
    window.history.pushState(null, '', '/#share=invalid-token');
    mountApp();
    await flushUntil(() => el.textContent.includes('この一時アクセスリンクは無効か、期限切れです'));
    expect(errors).toEqual([]);
    expect(el.textContent).toContain('この一時アクセスリンクは無効か、期限切れです。発行者に新しいリンクを依頼してください。');
  });
});
