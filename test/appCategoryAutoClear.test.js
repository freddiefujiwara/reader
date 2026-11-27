// カテゴリ (ジャンル) 選択中に、そのカテゴリのフィードが1つも
// 無くなったら選択を自動で解除する振る舞いの回帰テスト。
//
// 最後の1件を別ジャンルへ編集・削除するとカテゴリのチップ自体が
// 消え、選択が残ったままでは手で解除できず、一覧が空表示のままに
// なる (管理では「そのジャンルのフィードはありません。」)。
// タイムラインと管理の両方で、フィード一覧の変化を watcher が拾い、
// 選択を '' へ戻して全件表示に戻ることを固定する。あわせて、
// カテゴリがまだ存在する間は選択が維持されることも確認する。
import 'fake-indexeddb/auto';
import { flushRound, flushUntil } from './helpers/flush.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from 'vue';

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

// サーバー側の正本。saveFeed / deleteFeed で書き換わり、list 系は
// ここから返す。
let serverFeeds = [];

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async (token, id) => {
    serverFeeds = serverFeeds.filter((f) => f.id !== id);
    return { ok: true };
  }),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({
    ok: true,
    feeds: serverFeeds.map((f) => ({ ...f })),
    articles: [],
  })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: serverFeeds.map((f) => ({ ...f })) })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  getFeedStats: vi.fn(async () => ({ ok: true, stats: {} })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
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
// 止まってしまうため、値が入った形に差し替える (appGenreReflect と同様)。
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

// 条件が成り立つまで flush を繰り返す (appGenreReflect と同じ理由:
// 非同期チェーンの完了タイミングはマシンの負荷で変わるため、
// 固定回数の flush では CI で完了前に検証へ進んでしまう)。
// ヘッダーの更新ボタンは背景更新の実行中だけ「更新中…」になる。
const isRefreshingShown = () =>
  !!el && [...el.querySelectorAll('button')].some((b) => b.textContent.includes('更新中'));

// 背景更新が落ち着くまで待つ (テストをまたいだ書き込みで次のテストの
// 前提を壊さないため)。
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
  [...el.querySelectorAll('[aria-label="カテゴリで絞り込み"] .chip')];
const genreChips = () =>
  [...el.querySelectorAll('[aria-label="ジャンルで絞り込み"] .chip')];
const articleTitles = () =>
  [...el.querySelectorAll('.article-card .article-title')].map((n) => n.textContent.trim());
const feedCards = () => [...el.querySelectorAll('.feed-card')];
const emptyGenreNote = () =>
  [...el.querySelectorAll('.empty-note')].some((n) =>
    n.textContent.includes('そのジャンルのフィードはありません')
  );

async function seedAndMount() {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([rec('art-a', FEED_A.id, '記事A'), rec('art-b', FEED_B.id, '記事B')]);
  // トップの URL で開いたことにしてルーティングを有効にする (戻る
  // 操作でタイムラインへ戻る経路を使うため)。
  window.history.pushState(null, '', '/reader/');
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(
    () =>
      JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']) &&
      JSON.stringify(categoryChips().map((b) => b.textContent.trim())) ===
        JSON.stringify(['ポッドキャスト', 'private'])
  );
  expect(articleTitles(), 'タイムラインに記事が2件出る').toEqual(['記事A', '記事B']);
}

async function openAdmin() {
  findButton(el, '管理').click();
  await flushUntil(() => feedCards().length === serverFeeds.length);
}

// タイムラインへ戻る (ブラウザの戻る相当)。ブランドはトップへの
// ページ遷移になったため、アプリ内で戻る経路は履歴だけになった。
// 戻り先は管理へ入る前にいたタイムラインの URL を指定する。
function backToTimelineByHistory(path) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new window.PopStateEvent('popstate'));
}

// フィードカード (index 番目) のジャンルを編集して保存する。
async function editFeedCategoryAt(index, category) {
  const card = feedCards()[index];
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

describe('管理画面のジャンル選択の自動解除', () => {
  it('選択中ジャンルの最後のフィードを別ジャンルへ編集すると、全件表示に戻る', async () => {
    await seedAndMount();
    await openAdmin();
    // ポッドキャストで絞る (該当は FEED_A の1件だけ)。
    findButton(el.querySelector('[aria-label="ジャンルで絞り込み"]'), 'ポッドキャスト').click();
    await flushUntil(() => feedCards().length === 1);
    expect(feedCards().length).toBe(1);
    // その1件を別ジャンルへ編集して保存する。
    await editFeedCategoryAt(0, 'ニュース');
    // 一覧の取り直しでポッドキャストが消え、選択が自動解除されて
    // 全件 (2件) が出る。空表示の文言は出ない。
    await flushUntil(() => feedCards().length === 2 && !emptyGenreNote());
    expect(errors).toEqual([]);
    expect(feedCards().length).toBe(2);
    expect(emptyGenreNote()).toBe(false);
    expect(genreChips().map((b) => b.textContent.trim())).toEqual(['ニュース', 'private']);
    expect(genreChips().some((b) => b.classList.contains('active'))).toBe(false);
    await settleApp();
  });

  it('選択中ジャンルの最後のフィードを削除すると、全件表示に戻る', async () => {
    await seedAndMount();
    await openAdmin();
    findButton(el.querySelector('[aria-label="ジャンルで絞り込み"]'), 'ポッドキャスト').click();
    await flushUntil(() => feedCards().length === 1);
    // 残っている1件 (FEED_A) を削除する。
    findButton(feedCards()[0], '削除').click();
    await flushUntil(() => !!findButton(el, '本当に削除'));
    findButton(el, '本当に削除').click();
    // 削除でポッドキャストが消え、選択が自動解除されて残りの
    // フィード (FEED_B) が出る。空表示の文言は出ない。
    // (絞り込み中も「1件・文言なし」になるため、残ったカードが
    // FEED_B で確認UIも消えた状態を完了の条件にする。)
    await flushUntil(
      () =>
        feedCards().length === 1 &&
        feedCards()[0].textContent.includes('X freddie') &&
        !findButton(el, '本当に削除') &&
        !emptyGenreNote()
    );
    expect(errors).toEqual([]);
    expect(feedCards().length).toBe(1);
    expect(emptyGenreNote()).toBe(false);
    expect(feedCards()[0].textContent).toContain('X freddie');
    expect(genreChips().some((b) => b.classList.contains('active'))).toBe(false);
    await settleApp();
  });
});

describe('タイムラインのカテゴリ選択の自動解除', () => {
  it('選択中カテゴリの最後のフィードを管理で別ジャンルへ編集すると、全件表示に戻る', async () => {
    await seedAndMount();
    // タイムラインでポッドキャストを選ぶ (記事Aだけになる)。
    findButton(el.querySelector('[aria-label="カテゴリで絞り込み"]'), 'ポッドキャスト').click();
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A']));
    expect(articleTitles()).toEqual(['記事A']);
    // 管理で FEED_A のジャンルを変える。保存時の即時反映で共有状態の
    // フィード一覧が変わり、タイムライン側の選択も自動解除される。
    await openAdmin();
    await editFeedCategoryAt(0, 'ニュース');
    backToTimelineByHistory(`/reader/${encodeURIComponent('ポッドキャスト')}`);
    // 戻る際の背景更新 (実行中だった更新の上書き→追随更新) が
    // 落ち着いた最終状態まで待つ。途中の状態 (選択は解除されたが
    // 一覧が旧ジャンルで上書きされた瞬間など) を掴まないため。
    await flushUntil(
      () =>
        JSON.stringify(articleTitles()) === JSON.stringify(['記事A', '記事B']) &&
        JSON.stringify(categoryChips().map((b) => b.textContent.trim())) ===
          JSON.stringify(['ニュース', 'private']) &&
        !isRefreshingShown()
    );
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A', '記事B']);
    expect(categoryChips().map((b) => b.textContent.trim())).toEqual(['ニュース', 'private']);
    expect(categoryChips().some((b) => b.classList.contains('active'))).toBe(false);
    await settleApp();
  });

  it('選択中カテゴリがまだ存在する間は、他のフィードの編集では解除されない', async () => {
    await seedAndMount();
    findButton(el.querySelector('[aria-label="カテゴリで絞り込み"]'), 'ポッドキャスト').click();
    await flushUntil(() => JSON.stringify(articleTitles()) === JSON.stringify(['記事A']));
    // 管理で FEED_B (private) のジャンルだけを変える。
    // ポッドキャスト (FEED_A) は残るので選択は維持される。
    await openAdmin();
    await editFeedCategoryAt(1, 'ニュース');
    backToTimelineByHistory(`/reader/${encodeURIComponent('ポッドキャスト')}`);
    await flushUntil(
      () =>
        JSON.stringify(articleTitles()) === JSON.stringify(['記事A']) &&
        categoryChips().some(
          (b) => b.textContent.trim() === 'ポッドキャスト' && b.classList.contains('active')
        ) &&
        !isRefreshingShown()
    );
    expect(errors).toEqual([]);
    expect(articleTitles()).toEqual(['記事A']);
    const active = categoryChips().find((b) => b.classList.contains('active'));
    expect(active?.textContent.trim()).toBe('ポッドキャスト');
    await settleApp();
  });
});
