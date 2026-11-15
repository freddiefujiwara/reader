// URL パス (パーマリンク) と画面状態の対応付け。
// Vue に依存しない純粋関数だけにし、単体テストで振る舞いを固定する。
//
// パスの形 (ベースはアプリの置き場所 '/reader/'):
//   /reader/                        タイムライン (ジャンル・フィード無選択)
//   /reader/<ジャンル>              タイムライン (ジャンル選択)
//   /reader/<ジャンル>/<フィードID>  タイムライン (ジャンル＋フィード)
//   /reader/すべて/<フィードID>      タイムライン (ジャンル無選択＋フィード)
//   /reader/admin                   管理画面 (ジャンル無選択)
//   /reader/admin/<ジャンル>        管理画面 (ジャンル選択)
// ステージングはベースの直後に staging が入る (/reader/staging/...)。
// フィードの指定はタイトルではなくフィード ID (URL の SHA-256 先頭
// 16桁の16進文字列) で行う。タイトル変更に左右されず安定するため。
//
// 予約語: 'すべて' (ジャンル無選択の明示) と 'admin' (管理画面) は
// ジャンル名として扱わない。'staging' もベース直後では環境の印に
// なるため、ジャンル名には使えない。

export const ALL_SEGMENT = 'すべて';
export const ADMIN_SEGMENT = 'admin';
export const STAGING_SEGMENT = 'staging';

// フィード ID の形 (feedHash.js が作る16桁の小文字16進文字列)。
const FEED_ID_PATTERN = /^[0-9a-f]{16}$/;

function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    // 不正なエスケープはそのままの文字列として扱う。
    return raw;
  }
}

// location.pathname から、ベース ('/reader/') より後ろのセグメント
// (デコード済み) を取り出す。ベース配下でなければ null を返す
// (テスト環境などアプリのパスで開かれていない場合に、ルーティング
// 自体を無効化するための印)。
export function routeSegmentsFromPathname(pathname) {
  const parts = String(pathname || '')
    .split('/')
    .filter((s) => s !== '');
  if (parts[0] !== 'reader') return null;
  return parts.slice(1).map(decodeSegment);
}

// セグメント列を画面状態へ解釈する。
// feeds が渡され (1件以上ある) 場合は実在チェックも行い、存在しない
// ジャンルは無選択に、存在しないフィード ID は絞り込みなしに倒す。
// feeds が空・未指定なら検証せず、セグメントの形だけで解釈する
// (起動直後は一覧がまだ無いため、検証は一覧が揃ってから呼び出し側が
// 改めて行う)。ジャンルの照合は前後の空白を除いて行う
// (feedCategories や shouldClearCategorySelection と同じ流儀)。
export function parseRoute(segments, feeds) {
  const list = Array.isArray(segments) ? segments.slice() : [];
  let staging = false;
  if (list[0] === STAGING_SEGMENT) {
    staging = true;
    list.shift();
  }
  const known = Array.isArray(feeds) && feeds.length > 0 ? feeds : null;
  const knownCategory = (category) =>
    !known || known.some((f) => String(f?.category || '').trim() === category);

  if (list[0] === ADMIN_SEGMENT) {
    const genre = list[1] || '';
    const category = genre === ALL_SEGMENT ? '' : genre;
    return {
      staging,
      view: 'feeds',
      category: knownCategory(category) ? category : '',
      feedId: '',
    };
  }

  const genre = list[0] || '';
  const category = genre === ALL_SEGMENT ? '' : genre;
  const feedSegment = list[1] || '';
  const feedId = FEED_ID_PATTERN.test(feedSegment) ? feedSegment : '';
  return {
    staging,
    view: 'timeline',
    category: knownCategory(category) ? category : '',
    feedId:
      feedId && known && !known.some((f) => f.id === feedId) ? '' : feedId,
  };
}

// 画面状態から URL パスを作る。parseRoute と往復させる:
// buildRoutePath で作ったパスを routeSegmentsFromPathname +
// parseRoute に通すと、元の状態 (検証で落ちる分を除く) に戻る。
// ジャンルは encodeURIComponent でエンコードする ('/' を含む
// ジャンル名でも1セグメントに収まる)。
export function buildRoutePath(route) {
  const base = ['reader'];
  if (route?.staging) base.push(STAGING_SEGMENT);
  const category = String(route?.category || '').trim();

  if (route?.view === 'feeds') {
    const segments = [...base, ADMIN_SEGMENT];
    if (category) segments.push(encodeURIComponent(category));
    return `/${segments.join('/')}`;
  }

  const feedId = FEED_ID_PATTERN.test(route?.feedId || '') ? route.feedId : '';
  if (!category && !feedId) return `/${base.join('/')}/`;
  const segments = [...base, encodeURIComponent(category || ALL_SEGMENT)];
  if (feedId) segments.push(feedId);
  return `/${segments.join('/')}`;
}
