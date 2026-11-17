// URL パーマリンク (パス) と画面状態の対応付けの単体テスト。
// パスの形・予約語・実在チェック・ステージング接頭辞・エンコードの
// 往復を固定する。404.html / index.html の脚本同士の約束 (深リンクの
// 畳み込みと復元) も、既知の落とし穴 (ステージングで先頭1セグメント
// だけ残すと本番へ書き換わる) を含めてここで押さえる。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildRoutePath,
  parseRoute,
  routeSegmentsFromPathname,
} from '../src/lib/route.js';

const FEEDS = [
  { id: 'b81e59da11f890d2', category: 'ポッドキャスト' },
  { id: '33452296be85fdbc', category: 'private' },
  { id: '85ce0e8df21fc1c6', category: '音楽' },
];
const ID_A = 'b81e59da11f890d2';
const ID_C = '85ce0e8df21fc1c6';

describe('routeSegmentsFromPathname', () => {
  it('ベース配下のセグメントを取り出す', () => {
    expect(routeSegmentsFromPathname('/reader/')).toEqual([]);
    expect(routeSegmentsFromPathname('/reader')).toEqual([]);
    expect(routeSegmentsFromPathname('/reader/音楽')).toEqual(['音楽']);
    expect(routeSegmentsFromPathname(`/reader/音楽/${ID_C}`)).toEqual(['音楽', ID_C]);
    expect(routeSegmentsFromPathname('/reader/staging/音楽')).toEqual(['staging', '音楽']);
  });

  it('パーセントエンコードされた日本語をデコードする', () => {
    expect(routeSegmentsFromPathname(`/reader/${encodeURIComponent('音楽')}`)).toEqual(['音楽']);
  });

  it('ベース配下でなければ null (ルーティング無効の印)', () => {
    expect(routeSegmentsFromPathname('/')).toBeNull();
    expect(routeSegmentsFromPathname('/blog/音楽')).toBeNull();
    expect(routeSegmentsFromPathname('')).toBeNull();
  });
});

describe('parseRoute', () => {
  it('ルートはタイムラインの無選択', () => {
    expect(parseRoute([])).toEqual({ staging: false, view: 'timeline', category: '', feedId: '', unread: false });
    expect(parseRoute(['すべて'])).toEqual({ staging: false, view: 'timeline', category: '', feedId: '', unread: false });
  });

  it('ジャンルだけの指定', () => {
    expect(parseRoute(['音楽'])).toEqual({ staging: false, view: 'timeline', category: '音楽', feedId: '', unread: false });
  });

  it('ジャンル＋フィード ID の指定', () => {
    expect(parseRoute(['音楽', ID_C])).toEqual({ staging: false, view: 'timeline', category: '音楽', feedId: ID_C, unread: false });
  });

  it('「すべて」＋フィード ID はジャンル無選択＋フィード絞り込み', () => {
    expect(parseRoute(['すべて', ID_A])).toEqual({ staging: false, view: 'timeline', category: '', feedId: ID_A, unread: false });
  });

  it('管理画面の指定 (ジャンルなし・あり)', () => {
    expect(parseRoute(['admin'])).toEqual({ staging: false, view: 'feeds', category: '', feedId: '', unread: false });
    expect(parseRoute(['admin', 'private'])).toEqual({ staging: false, view: 'feeds', category: 'private', feedId: '', unread: false });
    expect(parseRoute(['admin', 'すべて'])).toEqual({ staging: false, view: 'feeds', category: '', feedId: '', unread: false });
  });

  it('ステージング接頭辞を読み替える', () => {
    expect(parseRoute(['staging'])).toEqual({ staging: true, view: 'timeline', category: '', feedId: '', unread: false });
    expect(parseRoute(['staging', '音楽', ID_C])).toEqual({ staging: true, view: 'timeline', category: '音楽', feedId: ID_C, unread: false });
    expect(parseRoute(['staging', 'admin', 'private'])).toEqual({ staging: true, view: 'feeds', category: 'private', feedId: '', unread: false });
  });

  it('末尾の unread は未読のみ表示の印', () => {
    expect(parseRoute(['音楽', 'unread'])).toEqual({ staging: false, view: 'timeline', category: '音楽', feedId: '', unread: true });
    expect(parseRoute(['音楽', ID_C, 'unread'])).toEqual({ staging: false, view: 'timeline', category: '音楽', feedId: ID_C, unread: true });
    expect(parseRoute(['すべて', 'unread'])).toEqual({ staging: false, view: 'timeline', category: '', feedId: '', unread: true });
    expect(parseRoute(['すべて', ID_A, 'unread'])).toEqual({ staging: false, view: 'timeline', category: '', feedId: ID_A, unread: true });
    expect(parseRoute(['staging', '音楽', 'unread'])).toEqual({ staging: true, view: 'timeline', category: '音楽', feedId: '', unread: true });
  });

  it('/reader/unread はジャンル無選択＋未読のみとして受理する', () => {
    expect(parseRoute(['unread'])).toEqual({ staging: false, view: 'timeline', category: '', feedId: '', unread: true });
    expect(parseRoute(['staging', 'unread'])).toEqual({ staging: true, view: 'timeline', category: '', feedId: '', unread: true });
    // 先頭の unread の後ろにフィード ID が続く形も、ジャンル無選択として読む。
    expect(parseRoute(['unread', ID_A])).toEqual({ staging: false, view: 'timeline', category: '', feedId: ID_A, unread: true });
  });

  it('フィード ID の形でないセグメントはフィード指定として扱わない', () => {
    expect(parseRoute(['音楽', 'not-an-id']).feedId).toBe('');
    expect(parseRoute(['音楽', 'B81E59DA11F890D2']).feedId).toBe(''); // 大文字は ID の形ではない
    expect(parseRoute(['音楽', 'b81e59da11f890d']).feedId).toBe(''); // 15桁
  });

  it('feeds があれば存在しないジャンル・フィードを落とす', () => {
    expect(parseRoute(['未知'], FEEDS)).toEqual({ staging: false, view: 'timeline', category: '', feedId: '', unread: false });
    expect(parseRoute(['音楽', '0123456789abcdef'], FEEDS)).toEqual({ staging: false, view: 'timeline', category: '音楽', feedId: '', unread: false });
    expect(parseRoute(['未知', ID_A], FEEDS)).toEqual({ staging: false, view: 'timeline', category: '', feedId: ID_A, unread: false });
    expect(parseRoute(['admin', '未知'], FEEDS).category).toBe('');
  });

  it('unread が付いていても実在チェックは同じに効く', () => {
    expect(parseRoute(['未知', 'unread'], FEEDS)).toEqual({ staging: false, view: 'timeline', category: '', feedId: '', unread: true });
    expect(parseRoute(['音楽', '0123456789abcdef', 'unread'], FEEDS)).toEqual({ staging: false, view: 'timeline', category: '音楽', feedId: '', unread: true });
  });

  it('feeds が空なら検証しない (起動直後の取り込み用)', () => {
    expect(parseRoute(['未知'], [])).toEqual({ staging: false, view: 'timeline', category: '未知', feedId: '', unread: false });
    expect(parseRoute(['音楽', '0123456789abcdef'], [])).toEqual({ staging: false, view: 'timeline', category: '音楽', feedId: '0123456789abcdef', unread: false });
    expect(parseRoute(['未知'])).toEqual({ staging: false, view: 'timeline', category: '未知', feedId: '', unread: false });
  });

  it('余分なセグメントは無視する', () => {
    expect(parseRoute(['音楽', ID_C, 'extra'])).toEqual({ staging: false, view: 'timeline', category: '音楽', feedId: ID_C, unread: false });
  });
});

describe('buildRoutePath', () => {
  it('タイムラインの各形', () => {
    expect(buildRoutePath({ view: 'timeline', category: '', feedId: '' })).toBe('/reader/');
    expect(buildRoutePath({ view: 'timeline', category: '音楽', feedId: '' })).toBe(`/reader/${encodeURIComponent('音楽')}`);
    expect(buildRoutePath({ view: 'timeline', category: '音楽', feedId: ID_C })).toBe(`/reader/${encodeURIComponent('音楽')}/${ID_C}`);
    expect(buildRoutePath({ view: 'timeline', category: '', feedId: ID_A })).toBe(`/reader/${encodeURIComponent('すべて')}/${ID_A}`);
  });

  it('管理画面の各形', () => {
    expect(buildRoutePath({ view: 'feeds', category: '', feedId: '' })).toBe('/reader/admin');
    expect(buildRoutePath({ view: 'feeds', category: 'private', feedId: '' })).toBe('/reader/admin/private');
  });

  it('ステージングはベースの直後に staging が入る', () => {
    expect(buildRoutePath({ staging: true, view: 'timeline', category: '', feedId: '' })).toBe('/reader/staging/');
    expect(buildRoutePath({ staging: true, view: 'timeline', category: '音楽', feedId: ID_C })).toBe(`/reader/staging/${encodeURIComponent('音楽')}/${ID_C}`);
    expect(buildRoutePath({ staging: true, view: 'feeds', category: '', feedId: '' })).toBe('/reader/staging/admin');
  });

  it('フィード ID の形でない値はパスに入れない', () => {
    expect(buildRoutePath({ view: 'timeline', category: '', feedId: 'bogus' })).toBe('/reader/');
  });

  it('未読のみ表示は末尾に /unread が付く', () => {
    expect(buildRoutePath({ view: 'timeline', category: '音楽', feedId: '', unread: true })).toBe(`/reader/${encodeURIComponent('音楽')}/unread`);
    expect(buildRoutePath({ view: 'timeline', category: '音楽', feedId: ID_C, unread: true })).toBe(`/reader/${encodeURIComponent('音楽')}/${ID_C}/unread`);
    expect(buildRoutePath({ view: 'timeline', category: '', feedId: ID_A, unread: true })).toBe(`/reader/${encodeURIComponent('すべて')}/${ID_A}/unread`);
    // ジャンル・フィード無選択＋未読のみは 'すべて' を明示した形が正規形。
    expect(buildRoutePath({ view: 'timeline', category: '', feedId: '', unread: true })).toBe(`/reader/${encodeURIComponent('すべて')}/unread`);
    expect(buildRoutePath({ staging: true, view: 'timeline', category: '', feedId: '', unread: true })).toBe(`/reader/staging/${encodeURIComponent('すべて')}/unread`);
  });

  it('管理画面のパスには /unread を付けない', () => {
    expect(buildRoutePath({ view: 'feeds', category: 'private', feedId: '', unread: true })).toBe('/reader/admin/private');
    expect(buildRoutePath({ view: 'feeds', category: '', feedId: '', unread: true })).toBe('/reader/admin');
  });
});

describe('parseRoute と buildRoutePath の往復', () => {
  const cases = [
    { staging: false, view: 'timeline', category: '', feedId: '', unread: false },
    { staging: false, view: 'timeline', category: '音楽', feedId: '', unread: false },
    { staging: false, view: 'timeline', category: '音楽', feedId: ID_C, unread: false },
    { staging: false, view: 'timeline', category: '', feedId: ID_A, unread: false },
    { staging: false, view: 'feeds', category: '', feedId: '', unread: false },
    { staging: false, view: 'feeds', category: 'private', feedId: '', unread: false },
    { staging: true, view: 'timeline', category: '', feedId: '', unread: false },
    { staging: true, view: 'timeline', category: 'ポッドキャスト', feedId: ID_A, unread: false },
    { staging: true, view: 'feeds', category: '音楽', feedId: '', unread: false },
    { staging: false, view: 'timeline', category: '', feedId: '', unread: true },
    { staging: false, view: 'timeline', category: '音楽', feedId: '', unread: true },
    { staging: false, view: 'timeline', category: '音楽', feedId: ID_C, unread: true },
    { staging: false, view: 'timeline', category: '', feedId: ID_A, unread: true },
    { staging: true, view: 'timeline', category: 'ポッドキャスト', feedId: ID_A, unread: true },
  ];
  cases.forEach((route) => {
    it(`${JSON.stringify(route)} が往復で一致する`, () => {
      const path = buildRoutePath(route);
      const parsed = parseRoute(routeSegmentsFromPathname(path), FEEDS);
      expect(parsed).toEqual(route);
    });
  });

  it('日本語ジャンルがエンコードを往復しても一致する', () => {
    const route = { staging: false, view: 'timeline', category: '音楽', feedId: ID_C, unread: false };
    const path = buildRoutePath(route);
    expect(path).not.toContain('音楽'); // パス上はエンコードされている
    expect(parseRoute(routeSegmentsFromPathname(path), FEEDS)).toEqual(route);
  });
});

describe('404.html と index.html の深リンク受け渡し', () => {
  // (jsdom 環境では import.meta.url が file スキームにならないため、
  // 実行ディレクトリ基準で読む。layoutCss.test.js と同じ流儀。)
  const notFound = readFileSync(resolve(process.cwd(), 'public/404.html'), 'utf8');
  const index = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

  it('404.html はパスを ?/ の形へ畳んで入り口へ送る', () => {
    expect(notFound).toContain("'?/'");
    expect(notFound).toContain('~and~');
    expect(notFound).toContain('l.hash');
  });

  it('404.html はステージングの深リンクで2セグメント残す', () => {
    // 1セグメントだけ残すと /reader/staging/... が本番へ書き換わる。
    expect(notFound).toContain("segments[1] === 'staging' ? 2 : 1");
  });

  it('index.html は ?/ の形から元のパスへ復元する', () => {
    expect(index).toContain("l.search[1] === '/'");
    expect(index).toContain('~and~');
    expect(index).toContain('replaceState');
    expect(index).toContain('l.hash');
  });

  // 両ファイルの脚本はセグメント数に依存しない作りのはずで、3セグメント
  // 目 (unread) まで含む深リンクが畳み込み→復元で元に戻ることを、
  // 脚本そのものを偽の window で実行して固定する。
  const firstScript = (html) => html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const run404 = (url) => {
    const u = new URL(url);
    let replaced = null;
    const fakeWindow = {
      location: {
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
        replace: (target) => { replaced = target; },
      },
    };
    new Function('window', firstScript(notFound))(fakeWindow);
    return replaced;
  };
  const runIndexRestore = (pathWithQuery) => {
    const u = new URL(pathWithQuery, 'https://example.com');
    let restored = null;
    const fakeWindow = {
      location: { pathname: u.pathname, search: u.search, hash: u.hash },
      history: { replaceState: (_state, _title, target) => { restored = target; } },
    };
    new Function('window', firstScript(index))(fakeWindow);
    return restored;
  };

  it('3セグメントの深リンク (フィード＋unread) が 404→復元で元に戻る', () => {
    const original = `/reader/${encodeURIComponent('すべて')}/${ID_A}/unread`;
    const via404 = run404(`https://example.com${original}`);
    expect(via404).toContain('?/');
    expect(runIndexRestore(via404)).toBe(original);
  });

  it('ステージングの3セグメント深リンクも 404→復元で元に戻る', () => {
    const original = `/reader/staging/${encodeURIComponent('音楽')}/${ID_C}/unread`;
    const via404 = run404(`https://example.com${original}`);
    expect(via404).toContain('/reader/staging/?/');
    expect(runIndexRestore(via404)).toBe(original);
  });

  it('深リンクの復元で #share= ハッシュを引き継ぐ', () => {
    const original = `/reader/${encodeURIComponent('すべて')}/${ID_A}/unread`;
    const via404 = run404(`https://example.com${original}#share=dummy-token`);
    expect(runIndexRestore(via404)).toBe(`${original}#share=dummy-token`);
  });
});
