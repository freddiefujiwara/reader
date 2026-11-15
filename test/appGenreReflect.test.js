// 管理画面でジャンルを編集しても、タイムラインに戻ると反映されて
// いない不具合の回帰テスト。
//
// タイムラインのジャンルは、メモリ内の状態と IndexedDB のフィード
// キャッシュから作られる。背景更新が共有状態を読み直すのは全フィード
// 再取得の完了後で、しかも実行中の更新があると新しい取得は始まら
// ないため、保存前に始まった更新が残っていると、戻っても古い
// ジャンルのままになっていた (以前はヘッダーがフルリロードだった
// ため表面化しなかった)。
//
// ここでは「初回の背景更新が保存をまたいで実行中のまま」という
// 実機の状態を再現し、(1) 保存した時点で共有状態へ反映されること、
// (2) 実行中だった更新が旧一覧で上書きしても、戻る際の追随更新で
// 最新に揃い直すこと、を固定する。
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

// サーバー側の正本。saveFeed で書き換わり、list 系はここから返す。
let serverFeeds = [];
// 初回の listArticles を保留するかどうか (実行中の背景更新の再現)。
let holdList = false;
let listArticlesCalls = 0;
let releaseHeldList = null;

vi.mock('../src/lib/api.js', () => ({
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(() => {
    listArticlesCalls += 1;
    if (holdList && listArticlesCalls === 1) {
      // 呼び出し時点 (保存前) の一覧を捕まえ、解放されるまで返さない。
      const snapshot = serverFeeds.map((f) => ({ ...f }));
      return new Promise((resolve) => {
        releaseHeldList = () => resolve({ ok: true, feeds: snapshot, articles: [] });
      });
    }
    return Promise.resolve({ ok: true, feeds: serverFeeds.map((f) => ({ ...f })), articles: [] });
  }),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: serverFeeds.map((f) => ({ ...f })) })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  saveFeed: vi.fn(async (token, payload) => {
    serverFeeds = serverFeeds.map((f) => (f.id === payload.id ? { ...f, ...payload } : f));
    return { ok: true, feed: serverFeeds.find((f) => f.id === payload.id) };
  }),
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
import { loadLocalFeeds, saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

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

// 条件が成り立つまで flush を繰り返す。保存→反映→背景更新のような
// 非同期チェーンが何マクロタスクで終わるかはマシンの負荷で変わる
// ため、固定回数の flush では、速い環境では収まっても CI では
// 完了前に検証へ進んでしまう。検証内容は変えず、「完了するまで
// 待つ」ことだけを決定的にするためのヘルパー。
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

// 背景更新が落ち着くまで待つ。実行中の更新がテストをまたいで残ると、
// 共有の IndexedDB へ後から書き込んで次のテストの前提を壊すため、
// テストの終わりと unmount 前に必ず静まるまで待つ (チェーンの合間に
// 一瞬だけ「更新中」でなくなることがあるため、連続で確認する)。
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
const articleTitles = () =>
  [...el.querySelectorAll('.article-card .article-title')].map((n) => n.textContent.trim());

async function seedAndMount() {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([rec('art-a', FEED_A.id, '記事A'), rec('art-b', FEED_B.id, '記事B')]);
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
  expect(categoryChips()).toEqual(['ポッドキャスト', 'private']);
}

async function editFirstFeedCategory(category) {
  findButton(el, '管理').click();
  await flushUntil(() => el.querySelectorAll('.feed-card').length >= 2);
  const card = el.querySelectorAll('.feed-card')[0];
  findButton(card, '編集').click();
  await flushUntil(() => !!el.querySelector('.feed-form'));
  const form = el.querySelector('.feed-form');
  const input = form.querySelector('#feed-category');
  input.value = category;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flushUntil(() => !el.querySelector('.feed-form'));
  expect(el.querySelector('.feed-form'), '保存後はフォームが閉じる').toBeNull();
}

beforeEach(() => {
  errors = [];
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
  holdList = false;
  listArticlesCalls = 0;
  releaseHeldList = null;
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
  // 実行中の背景更新を残したまま unmount すると、共有の IndexedDB へ
  // 後から書き込んで次のテストの前提を壊すため、先に静まるまで待つ。
  await settleApp();
  if (app) app.unmount();
  app = null;
  el = null;
});

describe('管理でのジャンル編集のタイムライン反映', () => {
  it('保存した時点で、共有状態 (IndexedDB のフィードキャッシュ) へ反映される', async () => {
    await seedAndMount();
    await editFirstFeedCategory('新ジャンル');
    expect(errors).toEqual([]);
    // まだ管理画面にいる時点で、タイムライン側のキャッシュも新しい
    // ジャンルになっている (戻った後の読み直しで古くならない)。
    // 反映は保存フローの最後に行われる非同期処理なので、完了を待つ。
    await flushUntil(
      async () =>
        (await loadLocalFeeds()).find((f) => f.id === FEED_A.id)?.category === '新ジャンル'
    );
    const cached = await loadLocalFeeds();
    expect(cached.find((f) => f.id === FEED_A.id).category).toBe('新ジャンル');
    // タイムラインへ戻ると、新しいジャンルのチップで絞れる。
    el.querySelector('.brand').click();
    await flushUntil(
      () => JSON.stringify(categoryChips()) === JSON.stringify(['新ジャンル', 'private'])
    );
    expect(errors).toEqual([]);
    expect(categoryChips()).toEqual(['新ジャンル', 'private']);
    findButton(el.querySelector('[aria-label="カテゴリで絞り込み"]'), '新ジャンル').click();
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A']));
    expect(articleTitles()).toEqual(['記事A']);
    await settleApp();
  });

  it('保存前に始まった背景更新が実行中でも、戻れば新しいジャンルになり、旧一覧で上書きされても揃い直す', async () => {
    holdList = true; // 初回の背景更新を保存後まで実行中に保つ
    await seedAndMount();
    await editFirstFeedCategory('新ジャンル');
    el.querySelector('.brand').click();
    // 反映 (保存フローの最後の非同期処理) が状態へ届くまで待つ。
    await flushUntil(
      () => JSON.stringify(categoryChips()) === JSON.stringify(['新ジャンル', 'private'])
    );
    expect(errors).toEqual([]);
    // 実行中の更新は保存前の一覧しか持っていないが、保存時の反映で
    // タイムラインは既に新しいジャンルになっている。
    expect(categoryChips()).toEqual(['新ジャンル', 'private']);
    // 実行中だった更新が終わる (旧一覧でキャッシュと状態が上書き
    // される) と、戻る際に予約した追随更新が最新の一覧を取り直す。
    // 追随更新の完了までは、状態とキャッシュは一時的に旧ジャンルへ
    // 戻るため、「追随更新が呼ばれ、更新が終わり、状態とキャッシュの
    // 両方が新しいジャンル」になるまでを完了の条件にする (途中の
    // 状態を掴んで早期に合格にしない)。
    releaseHeldList();
    await flushUntil(
      async () =>
        listArticlesCalls >= 2 &&
        !isRefreshingShown() &&
        JSON.stringify(categoryChips()) === JSON.stringify(['新ジャンル', 'private']) &&
        (await loadLocalFeeds()).find((f) => f.id === FEED_A.id)?.category === '新ジャンル'
    );
    expect(errors).toEqual([]);
    expect(listArticlesCalls).toBeGreaterThanOrEqual(2);
    expect(categoryChips()).toEqual(['新ジャンル', 'private']);
    const cached = await loadLocalFeeds();
    expect(cached.find((f) => f.id === FEED_A.id).category).toBe('新ジャンル');
    await settleApp();
  });

  it('保存前に始まった背景更新が、カテゴリ選択後に旧一覧で読み直しても選択を解除しない', async () => {
    holdList = true; // 初回の背景更新を、カテゴリ選択後まで実行中に保つ
    await seedAndMount();
    await editFirstFeedCategory('新ジャンル');
    el.querySelector('.brand').click();
    await flushUntil(
      () => JSON.stringify(categoryChips()) === JSON.stringify(['新ジャンル', 'private'])
    );
    expect(errors).toEqual([]);
    expect(categoryChips()).toEqual(['新ジャンル', 'private']);

    // 新しいジャンルを選択し、記事が1件に絞られた状態にする。
    findButton(el.querySelector('[aria-label="カテゴリで絞り込み"]'), '新ジャンル').click();
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A']));
    expect(articleTitles()).toEqual(['記事A']);

    // ここで保存前に始まっていた更新を解放する。その更新は旧一覧
    // (A は「ポッドキャスト」) しか持たないため、完了時には一時的に
    // 旧カテゴリ構成で読み直される。続いて戻る際に予約された追随
    // 更新が最新の一覧を取り直し、最終状態では「新ジャンル」が
    // 存在する。途中の旧一覧で選択を解除してしまうと、最終状態で
    // カテゴリが戻っても絞り込みだけが外れたままになる。
    releaseHeldList();
    await flushUntil(
      async () =>
        listArticlesCalls >= 2 &&
        !isRefreshingShown() &&
        JSON.stringify(categoryChips()) === JSON.stringify(['新ジャンル', 'private']) &&
        (await loadLocalFeeds()).find((f) => f.id === FEED_A.id)?.category === '新ジャンル'
    );
    await settleApp();
    expect(errors).toEqual([]);
    expect(categoryChips()).toEqual(['新ジャンル', 'private']);
    expect(articleTitles()).toEqual(['記事A']);
  });
});
