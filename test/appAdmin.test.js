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
    lastStatus: '200',
    lastError: '',
    lastFetchedAt: '2026-11-15T01:00:00.000Z',
    unreadCount: 1,
  },
  {
    id: '33452296be85fdbc',
    title: 'X freddie',
    url: 'https://example.com/x.freddie.xml',
    category: 'private',
    lastStatus: '200',
    lastError: '',
    lastFetchedAt: '2026-11-15T01:00:00.000Z',
    unreadCount: 46,
  },
];

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({ ok: true, feeds: FEEDS, articles: [] })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: FEEDS })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
  getStats: vi.fn(async () => ({ ok: true, weekly: [], currentWeek: '', current: [] })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  saveFeed: vi.fn(async () => ({ ok: true, feed: FEEDS[0] })),
}));

vi.mock('../src/lib/feedFetch.js', () => ({
  fetchAllFeeds: vi.fn(async () => []),
  fetchFeedXml: vi.fn(async () => ''),
  fetchOneFeed: vi.fn(async (feed) => ({ feed, ok: false, entries: [], error: new Error('not mocked') })),
}));

import App from '../src/App.vue';
import { saveFeed, listFeeds, reorderFeeds } from '../src/lib/api.js';
import { fetchFeedXml } from '../src/lib/feedFetch.js';

const scrollCalls = [];
const scrollToCalls = [];
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

it('編集・削除ボタンはカード右側の専用領域にあり、本体には無い', async () => {
  await mountAdmin();
  const card = el.querySelector('.feed-card');
  const actions = card.querySelector(':scope > .feed-card-actions');
  expect(actions, 'カード直下の右側領域がある').toBeTruthy();
  expect(findButton(actions, '編集')).toBeTruthy();
  expect(findButton(actions, '削除')).toBeTruthy();
  const main = card.querySelector('.feed-card-main');
  expect(main.querySelector('.feed-card-actions')).toBeNull();
  expect([...main.querySelectorAll('button')].map((b) => b.textContent.trim())).not.toContain('編集');
});

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
  scrollToCalls.length = 0;
  window.scrollTo = function (opts) {
    scrollToCalls.push(opts);
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
    // FEEDS[1] は YouTube フィードで、編集できなくなったため、
    // タイトル未取得の非 YouTube フィードに差し替えて確かめる。
    const untitled = FEEDS.map((f, i) =>
      i === 1 ? { ...f, title: '', url: 'https://example.com/feed.xml' } : f
    );
    listFeeds.mockImplementation(async () => ({ ok: true, feeds: untitled }));
    try {
      await mountAdmin();
      const form = await openEdit(1);
      expect(errors).toEqual([]);
      expect(form, '編集フォームが開く').toBeTruthy();
      expect(form.querySelector('.field-static').textContent).toBe('（未取得）');
      expect(scrollCalls.some((c) => c.el === form)).toBe(true);
    } finally {
      listFeeds.mockImplementation(async () => ({ ok: true, feeds: FEEDS }));
    }
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

describe('管理画面の編集フォームの保存ボタン', () => {
  const saveButton = (form) => form.querySelector('.form-actions .primary');

  async function typeCategoryValue(form, value) {
    const input = form.querySelector('#feed-category');
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flush();
    return input;
  }

  it('開いた直後は保存ボタンが非活性で、未変更のまま送信しても保存されない', async () => {
    await mountAdmin();
    const form = await openEdit(0);
    expect(errors).toEqual([]);
    expect(saveButton(form).disabled, '未変更では非活性').toBe(true);
    // ボタンが非活性でも、入力欄からの Enter 等で submit が飛んだ
    // 場合は保存しない (ボタンの活性条件とそろえる)。
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(saveFeed).not.toHaveBeenCalled();
    expect(el.querySelector('.feed-form'), 'フォームは開いたまま').toBeTruthy();
  });

  it('ジャンルを変更すると活性化し、元に戻すと再び非活性になる', async () => {
    await mountAdmin();
    const form = await openEdit(0);
    const btn = saveButton(form);
    expect(btn.disabled).toBe(true);
    await typeCategoryValue(form, '新しいジャンル');
    expect(btn.disabled, '変更すると活性化').toBe(false);
    await typeCategoryValue(form, 'ポッドキャスト');
    expect(btn.disabled, '元に戻すと再び非活性').toBe(true);
    expect(errors).toEqual([]);
  });

  it('前後に空白を足しただけでは活性化しない', async () => {
    await mountAdmin();
    const form = await openEdit(0);
    await typeCategoryValue(form, 'ポッドキャスト ');
    expect(saveButton(form).disabled).toBe(true);
    expect(errors).toEqual([]);
  });

  it('ジャンル候補チップのタップでも活性化する', async () => {
    await mountAdmin();
    const form = await openEdit(0);
    expect(saveButton(form).disabled).toBe(true);
    await typeCategoryValue(form, '');
    const chip = [...form.querySelectorAll('.genre-suggestions .chip')]
      .find((b) => b.textContent.trim() === '教養・ラジオ');
    expect(chip, '候補チップが出る').toBeTruthy();
    chip.click();
    await flush();
    expect(form.querySelector('#feed-category').value).toBe('教養・ラジオ');
    expect(saveButton(form).disabled, 'チップで変更しても活性化').toBe(false);
    expect(errors).toEqual([]);
  });

  it('追加フォームの保存ボタンは従来どおり最初から押せる', async () => {
    await mountAdmin();
    findButton(el, 'フィードを追加').click();
    await flush();
    const form = el.querySelector('.feed-form');
    expect(form, '追加フォームが開く').toBeTruthy();
    expect(saveButton(form).disabled, '追加では非活性にしない').toBe(false);
    expect(errors).toEqual([]);
  });
});

describe('ヘッダーのブランド (トップへのリンク)', () => {
  const brand = () => el.querySelector('.brand');

  it('ブランドはボタンではなくリンクで、href はアプリのトップ (ベース URL) を指す', async () => {
    await mountAdmin();
    expect(errors).toEqual([]);
    expect(brand(), 'ブランドが出る').toBeTruthy();
    expect(brand().tagName).toBe('A');
    // ベース URL そのもの (本番は /reader/、ステージングは
    // /reader/staging/)。ジャンルやフィードのパスを含まないため、
    // どこから押しても常に素のトップへ飛ぶ。
    expect(brand().getAttribute('href')).toBe('/reader/');
    expect(el.querySelector('button.brand')).toBeNull();
  });

  it('管理画面でブランドを押すと、アプリ内でタイムラインへ戻る', async () => {
    await mountAdmin();
    expect(el.querySelectorAll('.feed-card').length).toBe(FEEDS.length);
    const scrollCountBefore = scrollToCalls.length;
    brand().click();
    await flush();
    expect(errors).toEqual([]);
    // ページを開き直さずにタイムラインへ戻り、先頭へスクロールする
    // (URL は状態 watcher がトップのパスへ書き換える)。
    expect(el.querySelectorAll('.feed-card').length).toBe(0);
    expect(el.querySelector('.view-tabs')).toBeTruthy();
    expect(scrollToCalls.slice(scrollCountBefore)).toEqual([{ top: 0 }]);
  });

  it('管理画面に「← タイムラインに戻る」は無く、トップへ出る手段はブランドだけ', async () => {
    await mountAdmin();
    expect(errors).toEqual([]);
    expect(findButton(el, '← タイムラインに戻る')).toBeUndefined();
    expect(brand(), 'ブランドは常に出ている').toBeTruthy();
    expect(findButton(el, 'フィードを追加'), '追加ボタンは残る').toBeTruthy();
  });

  it('タイムライン表示中にブランドを押すと、先頭へスクロールする', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(App);
    app.config.errorHandler = (err) => { errors.push(err); };
    app.mount(el);
    await flush();
    expect(el.querySelector('.view-tabs'), 'タイムライン表示中').toBeTruthy();
    const scrollCountBefore = scrollToCalls.length;
    brand().click();
    await flush();
    expect(errors).toEqual([]);
    // アプリ内でトップへ戻るため、先頭へスクロールする。
    expect(scrollToCalls.slice(scrollCountBefore)).toEqual([{ top: 0 }]);
    // 画面はタイムラインのまま。
    expect(el.querySelector('.view-tabs')).toBeTruthy();
  });
});

describe('管理画面の非公開表示', () => {
  it('「プライベート」バッジや文言を表示しない', async () => {
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

describe('管理画面の YouTube フィード', () => {
  // FEEDS[1] が YouTube フィード (videos.xml 形式の URL)。
  const youtubeCard = () => el.querySelectorAll('.feed-card')[1];

  it('YouTube フィードには編集・削除ボタンが出ず、代わりに案内文言が出る', async () => {
    await mountAdmin();
    expect(errors).toEqual([]);
    const card = youtubeCard();
    expect(findButton(card, '編集'), '編集ボタンは無い').toBeUndefined();
    expect(findButton(card, '削除'), '削除ボタンは無い').toBeUndefined();
    const note = card.querySelector('.feed-youtube-note');
    expect(note, '案内文言が出る').toBeTruthy();
    expect(note.textContent.trim()).toBe('変更・解除はYouTubeアプリで');
  });

  it('YouTube 以外のフィードには従来どおり編集・削除ボタンが出て、案内文言は出ない', async () => {
    await mountAdmin();
    expect(errors).toEqual([]);
    const card = el.querySelectorAll('.feed-card')[0];
    expect(findButton(card, '編集'), '編集ボタンが出る').toBeTruthy();
    expect(findButton(card, '削除'), '削除ボタンが出る').toBeTruthy();
    expect(card.querySelector('.feed-youtube-note'), '案内文言は出ない').toBeNull();
  });

  it('YouTube フィードでも並び替えハンドルは残る', async () => {
    await mountAdmin();
    expect(errors).toEqual([]);
    expect(youtubeCard().querySelector('button.drag-handle'), 'ドラッグハンドルが出る').toBeTruthy();
  });

  it('ジャンルで絞った先が YouTube フィードだけでも、案内文言が出て編集・削除は出ない', async () => {
    await mountAdmin();
    const tablist = el.querySelector('[aria-label="ジャンルで絞り込み"]');
    findButton(tablist, '教養・ラジオ').click();
    await flush();
    expect(errors).toEqual([]);
    const cards = el.querySelectorAll('.feed-card');
    expect(cards.length).toBe(1);
    expect(findButton(cards[0], '編集')).toBeUndefined();
    expect(findButton(cards[0], '削除')).toBeUndefined();
    expect(cards[0].querySelector('.feed-youtube-note'), '案内文言が出る').toBeTruthy();
  });
});

describe('管理画面のジャンル絞り込み', () => {
  const genreTablist = () => el.querySelector('[aria-label="ジャンルで絞り込み"]');
  const dragHandles = () => el.querySelectorAll('button.drag-handle');
  const cardTitles = () =>
    [...el.querySelectorAll('.feed-card .feed-name')].map((n) => n.textContent.trim());

  it('絞っていないときは全件にドラッグハンドルが出て、矢印ボタンは無い', async () => {
    await mountAdmin();
    expect(genreTablist(), 'ジャンルタブ行が出る').toBeTruthy();
    expect(el.querySelectorAll('.feed-card').length).toBe(FEEDS.length);
    expect(dragHandles().length).toBe(FEEDS.length);
    expect(findButton(el, '↑')).toBeUndefined();
    expect(findButton(el, '↓')).toBeUndefined();
  });

  it('ジャンルタブで絞るとそのジャンルだけになり、ドラッグハンドルが消える (編集・削除は残る)', async () => {
    await mountAdmin();
    findButton(genreTablist(), 'ポッドキャスト').click();
    await flush();
    expect(errors).toEqual([]);
    expect(cardTitles()).toEqual(['Rebuild', 'ゆる言語学ラジオ']);
    expect(dragHandles().length).toBe(0);
    const card = el.querySelector('.feed-card');
    expect(findButton(card, '編集'), '編集ボタンは残る').toBeTruthy();
    expect(findButton(card, '削除'), '削除ボタンは残る').toBeTruthy();
  });

  it('「すべて」チップは無く、未選択 (既定) では全件表示でアクティブなチップも無い', async () => {
    await mountAdmin();
    expect(errors).toEqual([]);
    // タイムラインと同じトグル方式: 「すべて」は置かず、ジャンルだけが並ぶ。
    expect(findButton(genreTablist(), 'すべて')).toBeUndefined();
    const chips = [...genreTablist().querySelectorAll('.chip')].map((b) => b.textContent.trim());
    expect(chips).toEqual(['ポッドキャスト', '教養・ラジオ', 'private']);
    expect(genreTablist().querySelector('.chip.active')).toBeNull();
    expect(el.querySelectorAll('.feed-card').length).toBe(FEEDS.length);
  });

  it('選択中のジャンルを再タップすると解除され、全件とドラッグハンドルが戻る', async () => {
    await mountAdmin();
    findButton(genreTablist(), '教養・ラジオ').click();
    await flush();
    expect(el.querySelectorAll('.feed-card').length).toBe(1);
    expect(dragHandles().length).toBe(0);
    expect(genreTablist().querySelector('.chip.active').textContent.trim()).toBe('教養・ラジオ');
    findButton(genreTablist(), '教養・ラジオ').click();
    await flush();
    expect(errors).toEqual([]);
    expect(genreTablist().querySelector('.chip.active')).toBeNull();
    expect(el.querySelectorAll('.feed-card').length).toBe(FEEDS.length);
    expect(dragHandles().length).toBe(FEEDS.length);
  });

  it('別のジャンルをタップすると、解除ではなくそのジャンルへ切り替わる', async () => {
    await mountAdmin();
    findButton(genreTablist(), 'ポッドキャスト').click();
    await flush();
    expect(el.querySelectorAll('.feed-card').length).toBe(2);
    findButton(genreTablist(), '教養・ラジオ').click();
    await flush();
    expect(errors).toEqual([]);
    expect(genreTablist().querySelector('.chip.active').textContent.trim()).toBe('教養・ラジオ');
    // 教養・ラジオのフィードはタイトル未取得のため、表示名はホスト名になる。
    expect(cardTitles()).toEqual(['www.youtube.com']);
  });

  it('絞り込みは管理画面側の状態として保持され、タイムラインと行き来しても残る', async () => {
    // 行き来はブラウザの戻る (popstate) で行うため、ルーティングが
    // 有効になるようトップの URL で開いたことにする (ブランドは
    // トップへのページ遷移になり、アプリ内の行き来には使わない)。
    window.history.pushState(null, '', '/reader/');
    await mountAdmin();
    findButton(genreTablist(), 'ポッドキャスト').click();
    await flush();
    expect(el.querySelectorAll('.feed-card').length).toBe(2);
    // 戻る手段はヘッダーのブランド (トップへのリンク) のみ。
    expect(findButton(el, '← タイムラインに戻る')).toBeUndefined();
    window.history.pushState(null, '', '/reader/');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await flush();
    findButton(el, '管理').click();
    await flush();
    expect(errors).toEqual([]);
    // タイムラインのカテゴリ選択とは別の状態なので、戻っても絞り込みは維持される。
    expect(el.querySelectorAll('.feed-card').length).toBe(2);
    expect(dragHandles().length).toBe(0);
    const active = genreTablist().querySelector('.chip.active');
    expect(active.textContent.trim()).toBe('ポッドキャスト');
    // 後続のテストへ URL を持ち越さない。
    window.history.pushState(null, '', '/');
  });
});

describe('管理画面のドラッグ並べ替え', () => {
  const cardTitles = () =>
    [...el.querySelectorAll('.feed-card .feed-name')].map((n) => n.textContent.trim());
  const handles = () => [...el.querySelectorAll('button.drag-handle')];
  const cards = () => [...el.querySelectorAll('.feed-card')];

  // jsdom はレイアウトを持たないため、フィードカードの矩形だけを
  // 決め打ちで返す (高さ80・ピッチ100 で縦に並んでいることにする)。
  let origRect = null;
  function stubCardRects() {
    origRect = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList && this.classList.contains('feed-card')) {
        const idx = [...document.querySelectorAll('.feed-card')].indexOf(this);
        const top = idx * 100;
        return { top, bottom: top + 80, height: 80, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) };
      }
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) };
    };
  }

  function pointer(type, target, clientY) {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    ev.clientY = clientY;
    ev.button = 0;
    ev.pointerId = 1;
    target.dispatchEvent(ev);
  }

  beforeEach(() => {
    stubCardRects();
  });

  afterEach(() => {
    if (origRect) window.HTMLElement.prototype.getBoundingClientRect = origRect;
    origRect = null;
  });

  it('ハンドルを下へドラッグして離すと、新しい順序で reorderFeeds が呼ばれ、一覧の並びも変わる', async () => {
    await mountAdmin();
    const handle = handles()[0];
    // 1行目を clientY 40 → 250 へ運ぶ (移動量210)。掴んだ行の中心は
    // 250 になり、2行目 (中点140) と3行目 (中点240) を越えるので
    // 挿入先はインデックス2。
    pointer('pointerdown', handle, 40);
    pointer('pointermove', handle, 250);
    await flush();
    expect(errors).toEqual([]);
    // ドラッグ中: 掴んだ行は指に追随し、間の行はピッチ分だけ詰まる。
    expect(cards()[0].classList.contains('is-dragging')).toBe(true);
    expect(cards()[0].style.transform).toBe('translateY(210px)');
    expect(cards()[1].style.transform).toBe('translateY(-100px)');
    expect(cards()[2].style.transform).toBe('translateY(-100px)');
    expect(cards()[3].style.transform).toBe('');
    pointer('pointerup', handle, 250);
    await flush();
    expect(errors).toEqual([]);
    expect(reorderFeeds).toHaveBeenCalledTimes(1);
    const [token, ids] = reorderFeeds.mock.calls[0];
    expect(token).toBe('tok');
    expect(ids).toEqual([FEEDS[1].id, FEEDS[2].id, FEEDS[0].id, FEEDS[3].id]);
    expect(cardTitles()).toEqual(['www.youtube.com', 'ゆる言語学ラジオ', 'Rebuild', 'X freddie']);
  });

  it('ハンドルを上へドラッグすると、上の位置へ入る', async () => {
    await mountAdmin();
    const handle = handles()[3];
    // 4行目を clientY 340 → 130 へ運ぶ (移動量-210)。中心は130に
    // なり、3行目 (中点240) と2行目 (中点140) を下回るので挿入先は1。
    pointer('pointerdown', handle, 340);
    pointer('pointermove', handle, 130);
    pointer('pointerup', handle, 130);
    await flush();
    expect(errors).toEqual([]);
    expect(reorderFeeds).toHaveBeenCalledTimes(1);
    const [, ids] = reorderFeeds.mock.calls[0];
    expect(ids).toEqual([FEEDS[0].id, FEEDS[3].id, FEEDS[1].id, FEEDS[2].id]);
  });

  it('2行目を一番上まで運ぶと先頭に入り、先頭行が下へどく', async () => {
    await mountAdmin();
    const handle = handles()[1];
    // 2行目 (上端100) を clientY 140 → 0 へ。移動量はクランプで
    // -100 (上端が先頭行の上端に一致) まで。中点の判定だけでは
    // 先頭に入れない位置だが、端まで運んだので挿入先は0。
    pointer('pointerdown', handle, 140);
    pointer('pointermove', handle, 0);
    await flush();
    expect(errors).toEqual([]);
    expect(cards()[1].style.transform).toBe('translateY(-100px)');
    expect(cards()[0].style.transform).toBe('translateY(100px)');
    pointer('pointerup', handle, 0);
    await flush();
    expect(errors).toEqual([]);
    expect(reorderFeeds).toHaveBeenCalledTimes(1);
    const [, ids] = reorderFeeds.mock.calls[0];
    expect(ids).toEqual([FEEDS[1].id, FEEDS[0].id, FEEDS[2].id, FEEDS[3].id]);
  });

  it('3行目を一番下まで運ぶと末尾に入り、末尾行が上へどく', async () => {
    await mountAdmin();
    const handle = handles()[2];
    // 3行目 (上端200・下端280) を大きく下へ。移動量はクランプで
    // +100 (下端が末尾行の下端380に一致) まで。挿入先は末尾の3。
    pointer('pointerdown', handle, 240);
    pointer('pointermove', handle, 1000);
    await flush();
    expect(errors).toEqual([]);
    expect(cards()[2].style.transform).toBe('translateY(100px)');
    expect(cards()[3].style.transform).toBe('translateY(-100px)');
    pointer('pointerup', handle, 1000);
    await flush();
    expect(errors).toEqual([]);
    expect(reorderFeeds).toHaveBeenCalledTimes(1);
    const [, ids] = reorderFeeds.mock.calls[0];
    expect(ids).toEqual([FEEDS[0].id, FEEDS[1].id, FEEDS[3].id, FEEDS[2].id]);
  });

  it('動かさずに離すと保存は呼ばれない', async () => {
    await mountAdmin();
    const handle = handles()[1];
    pointer('pointerdown', handle, 140);
    pointer('pointerup', handle, 140);
    await flush();
    expect(errors).toEqual([]);
    expect(reorderFeeds).not.toHaveBeenCalled();
  });

  it('ドラッグをキャンセルすると保存されず、並びも変わらない', async () => {
    await mountAdmin();
    const handle = handles()[0];
    pointer('pointerdown', handle, 40);
    pointer('pointermove', handle, 250);
    pointer('pointercancel', handle, 250);
    await flush();
    expect(errors).toEqual([]);
    expect(reorderFeeds).not.toHaveBeenCalled();
    expect(cardTitles()).toEqual(['Rebuild', 'www.youtube.com', 'ゆる言語学ラジオ', 'X freddie']);
    expect(cards()[0].classList.contains('is-dragging')).toBe(false);
  });
});

describe('管理画面の編集中表示', () => {
  const genreTablist = () => el.querySelector('[aria-label="ジャンルで絞り込み"]');

  it('編集フォームを開くと、ジャンル選択とフィード一覧が隠れる', async () => {
    await mountAdmin();
    expect(genreTablist(), 'ジャンル選択が出ている').toBeTruthy();
    expect(el.querySelectorAll('.feed-card').length).toBe(FEEDS.length);
    const form = await openEdit(0);
    expect(errors).toEqual([]);
    expect(form, '編集フォームは出る').toBeTruthy();
    expect(genreTablist(), '編集中はジャンル選択を隠す').toBeNull();
    expect(el.querySelectorAll('.feed-card').length, '編集中は一覧を隠す').toBe(0);
  });

  it('ジャンルで絞った状態で編集し、キャンセルすると絞り込みがそのまま戻る', async () => {
    await mountAdmin();
    findButton(genreTablist(), 'ポッドキャスト').click();
    await flush();
    expect(el.querySelectorAll('.feed-card').length).toBe(2);
    const form = await openEdit(0);
    expect(el.querySelectorAll('.feed-card').length).toBe(0);
    findButton(form, 'キャンセル').click();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.feed-form'), 'フォームは閉じる').toBeNull();
    expect(genreTablist(), 'ジャンル選択が戻る').toBeTruthy();
    const active = genreTablist().querySelector('.chip.active');
    expect(active.textContent.trim(), '絞り込みは保持される').toBe('ポッドキャスト');
    expect(el.querySelectorAll('.feed-card').length).toBe(2);
  });

  it('編集を保存するとフォームが閉じて一覧が戻る', async () => {
    await mountAdmin();
    const form = await openEdit(0);
    const input = form.querySelector('#feed-category');
    input.value = '新しいジャンル';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.feed-form'), '保存後はフォームが閉じる').toBeNull();
    expect(genreTablist(), 'ジャンル選択が戻る').toBeTruthy();
    expect(el.querySelectorAll('.feed-card').length, '一覧が戻る').toBe(FEEDS.length);
  });

  it('追加フォームではジャンル選択と一覧は隠さない (対象は編集時のみ)', async () => {
    await mountAdmin();
    findButton(el, 'フィードを追加').click();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.feed-form'), '追加フォームは出る').toBeTruthy();
    expect(genreTablist(), 'ジャンル選択は出たまま').toBeTruthy();
    expect(el.querySelectorAll('.feed-card').length).toBe(FEEDS.length);
  });
});

describe('管理画面の YouTube チャンネル URL 追加', () => {
  // サーバーが返す解決済みフィード: URL は /channel/ の正規形、タイトル補完済み。
  const RESOLVED = {
    id: 'a1b2c3d4e5f60708',
    title: 'rakutentech',
    url: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A',
    category: '',
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

describe('ジャンル候補 (datalist を使わない)', () => {
  const suggestions = () => el.querySelector('.genre-suggestions');
  const suggestionTexts = () =>
    [...el.querySelectorAll('.genre-suggestions .chip')].map((b) => b.textContent.trim());

  async function typeCategory(form, value) {
    const input = form.querySelector('#feed-category');
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flush();
    return input;
  }

  it('追加フォームでは候補がフォーム内の通常フロー (保存ボタンより前) に出て、datalist は無い', async () => {
    await mountAdmin();
    findButton(el, 'フィードを追加').click();
    await flush();
    const form = el.querySelector('.feed-form');
    expect(form, '追加フォームが開く').toBeTruthy();
    // ネイティブ datalist は使わない (iOS Safari のポップアップが
    // 保存ボタンに被るため)。
    expect(form.querySelector('datalist')).toBeNull();
    expect(form.querySelector('#feed-category').getAttribute('list')).toBeNull();
    // 空入力では既存ジャンル全件が候補として出る。
    expect(suggestionTexts()).toEqual(['ポッドキャスト', '教養・ラジオ', 'private']);
    // 候補はフォームの中にあり、保存/キャンセルの並び (.form-actions)
    // より前に置かれる = 通常フローの要素で、重ね表示ではない。
    const box = suggestions();
    const actions = form.querySelector('.form-actions');
    expect(form.contains(box)).toBe(true);
    expect(box.compareDocumentPosition(actions) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(errors).toEqual([]);
  });

  it('入力で候補が絞られ、タップで入力欄に反映され、一致したら候補は消える', async () => {
    await mountAdmin();
    findButton(el, 'フィードを追加').click();
    await flush();
    const form = el.querySelector('.feed-form');
    const input = await typeCategory(form, 'ポッ');
    expect(suggestionTexts()).toEqual(['ポッドキャスト']);

    el.querySelector('.genre-suggestions .chip').click();
    await flush();
    expect(input.value).toBe('ポッドキャスト');
    // 完全一致したので、もう候補は出ない。
    expect(suggestions()).toBeNull();

    // 一致する候補が無ければ候補UI自体が出ない。
    await typeCategory(form, '存在しないジャンル');
    expect(suggestions()).toBeNull();
    expect(errors).toEqual([]);
  });

  it('編集フォームでも候補が出て、フォームを閉じれば候補も消える', async () => {
    await mountAdmin();
    const form = await openEdit(0);
    // 開いた直後は現在のジャンル (ポッドキャスト) と完全一致する
    // ため候補は出ない。空にすると全候補が出る。
    expect(suggestions()).toBeNull();
    const input = await typeCategory(form, '');
    expect(suggestionTexts()).toEqual(['ポッドキャスト', '教養・ラジオ', 'private']);
    const chip = [...el.querySelectorAll('.genre-suggestions .chip')]
      .find((b) => b.textContent.trim() === '教養・ラジオ');
    chip.click();
    await flush();
    expect(input.value).toBe('教養・ラジオ');

    findButton(form, 'キャンセル').click();
    await flush();
    expect(el.querySelector('.feed-form')).toBeNull();
    expect(suggestions()).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe('管理画面のスクロール位置の復元', () => {
  // 過去の不具合: 編集中は一覧が隠れてドキュメントが極端に短くなり、
  // フォームを閉じるとブラウザの位置復元で一覧の最下部へ飛んでいた。
  // 開く前の位置を覚えておき、閉じた後に戻すことをここで固定する。
  let currentScrollY = 0;

  beforeEach(() => {
    currentScrollY = 0;
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => currentScrollY,
    });
  });

  afterEach(() => {
    delete window.scrollY;
  });

  it('編集をキャンセルすると、開く前のスクロール位置へ戻る', async () => {
    currentScrollY = 480;
    await mountAdmin();
    const form = await openEdit(2);
    findButton(form, 'キャンセル').click();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.feed-form'), 'フォームは閉じる').toBeNull();
    expect(el.querySelectorAll('.feed-card').length, '一覧が戻る').toBe(FEEDS.length);
    expect(scrollToCalls).toEqual([{ top: 480 }]);
  });

  it('編集を保存すると、開く前のスクロール位置へ戻る', async () => {
    currentScrollY = 320;
    await mountAdmin();
    const form = await openEdit(0);
    const input = form.querySelector('#feed-category');
    input.value = '新しいジャンル';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.feed-form'), '保存後はフォームが閉じる').toBeNull();
    expect(el.querySelectorAll('.feed-card').length, '一覧が戻る').toBe(FEEDS.length);
    expect(scrollToCalls).toEqual([{ top: 320 }]);
  });

  it('追加フォームをキャンセルしても、開く前の位置へ戻る', async () => {
    currentScrollY = 200;
    await mountAdmin();
    findButton(el, 'フィードを追加').click();
    await flush();
    const form = el.querySelector('.feed-form');
    expect(form, '追加フォームが開く').toBeTruthy();
    findButton(form, 'キャンセル').click();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.feed-form'), 'フォームは閉じる').toBeNull();
    expect(scrollToCalls).toEqual([{ top: 200 }]);
  });

  it('編集中にブランドを押すと、タイムラインへ戻り、位置の復元は走らない', async () => {
    currentScrollY = 480;
    await mountAdmin();
    await openEdit(0);
    const scrollCountBefore = scrollToCalls.length;
    el.querySelector('.brand').click();
    await flush();
    expect(errors).toEqual([]);
    // アプリ内でタイムラインへ戻るためフォームは閉じ、先頭へ
    // スクロールする。開く前の位置 (480) の復元は走らない。
    expect(el.querySelector('.feed-form'), 'フォームは閉じる').toBeNull();
    expect(el.querySelector('.view-tabs')).toBeTruthy();
    expect(scrollToCalls.slice(scrollCountBefore)).toEqual([{ top: 0 }]);
    expect(scrollToCalls.some((c) => c.top === 480)).toBe(false);
  });
});
