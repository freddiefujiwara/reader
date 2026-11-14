// フィード管理の純粋な補助 (フォーム検証・保存ペイロード組み立て・状態表示)。
// Vue に依存しない関数だけにし、単体テストで振る舞いを固定する。
// フィード ID は URL のハッシュ (サーバーが決める) になったため、
// フォームが扱うのは URL とジャンル (サーバー側の category) だけ。
// タイトルはフィードからの自動取得のみで、人は入力しない。
import { formatPublishedAt } from './format.js';
import { parseFeedMeta } from './feedParse.js';

// 新規追加フォームの初期値。扱うのは URL とジャンルだけ。
export function createFeedForm() {
  return { url: '', category: '' };
}

// 編集フォーム初期値。ID / タイトル / URL は表示専用 (変更できない)、
// ジャンルだけが編集対象。
export function feedFormFromFeed(feed) {
  return {
    id: feed?.id || '',
    title: feed?.title || '',
    url: feed?.url || '',
    category: feed?.category || '',
  };
}

// URL だけの検証 (追加では他の項目より先に URL を確かめる)。
export function validateFeedUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return 'URLの形式が正しくありません。';
  }
  if (parsed.protocol !== 'https:') {
    return 'URLは https:// で始まるものにしてください。';
  }
  return '';
}

// YouTube 疑似フィード URL (youtube.com/feeds/videos.xml?channel_id=...)。
// 公式 RSS は 404 のため追加時に直接は読めず、タイトルはサーバーが
// 定期取得の際に Data API から補完する。追加時はタイトル '' で保存する。
export function isYouTubeFeedUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return false;
  }
  const hosts = ['www.youtube.com', 'youtube.com', 'm.youtube.com'];
  return (
    hosts.includes(parsed.hostname) &&
    parsed.pathname === '/feeds/videos.xml' &&
    !!parsed.searchParams.get('channel_id')
  );
}

// YouTube チャンネルページの URL (youtube.com/channel/UC... または
// youtube.com/@handle)。末尾のパス (/@handle/videos など) も許す。
// チャンネル ID の形はサーバー側の判定 (UC + 10文字以上) に合わせる。
export function isYouTubeChannelUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return false;
  }
  const hosts = ['www.youtube.com', 'youtube.com', 'm.youtube.com'];
  if (!hosts.includes(parsed.hostname)) return false;
  return (
    /^\/channel\/UC[\w-]{10,}(\/.*)?$/.test(parsed.pathname) ||
    /^\/@[\w.-]+(\/.*)?$/.test(parsed.pathname)
  );
}

// YouTube のチャンネル ID を URL から取り出す。疑似フィード形式
// (videos.xml?channel_id=...) とチャンネルページ形式 (/channel/UC...)
// の両方に対応し、どちらでもなければ '' を返す。ID の形は
// isYouTubeChannelUrl と同じ (UC + 10文字以上) にそろえる。
export function youtubeChannelIdFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return '';
  }
  const hosts = ['www.youtube.com', 'youtube.com', 'm.youtube.com'];
  if (!hosts.includes(parsed.hostname)) return '';
  if (parsed.pathname === '/feeds/videos.xml') {
    const id = parsed.searchParams.get('channel_id') || '';
    return /^UC[\w-]{10,}$/.test(id) ? id : '';
  }
  const m = parsed.pathname.match(/^\/channel\/(UC[\w-]{10,})(\/.*)?$/);
  return m ? m[1] : '';
}

// YouTube の動画 ID を記事リンクから取り出す。watch?v= と youtu.be/ と
// /shorts/ に対応し、取り出せなければ '' を返す。記事 ID の付け替え
// (ID = ハッシュ(フィードID + 動画ID)) に使う。
export function youtubeVideoIdFromLink(link) {
  let parsed;
  try {
    parsed = new URL(String(link || '').trim());
  } catch {
    return '';
  }
  const hosts = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'];
  if (parsed.hostname === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0];
    return /^[\w-]+$/.test(id) ? id : '';
  }
  if (!hosts.includes(parsed.hostname)) return '';
  if (parsed.pathname === '/watch') {
    const id = parsed.searchParams.get('v') || '';
    return /^[\w-]+$/.test(id) ? id : '';
  }
  const m = parsed.pathname.match(/^\/shorts\/([\w-]+)(\/.*)?$/);
  return m ? m[1] : '';
}

// 追加時にプロキシ取得をせず、タイトル '' で保存する YouTube 入力
// (チャンネルページ / @ハンドル) かどうか。
// URL の正規形 (/channel/UC...) への解決とタイトル補完はサーバーが行う。
export function isYouTubeFeedInput(url) {
  return isYouTubeChannelUrl(url);
}

// 新規追加の進め方を決める。YouTube の入力 (チャンネルページ・
// @ハンドル) は取得を省いてタイトル '' で保存し ('youtube')、
// それ以外は保存前にフィードを取得してタイトルを取る ('fetch')。
export function planFeedAdd(form) {
  return { mode: isYouTubeFeedInput(form?.url) ? 'youtube' : 'fetch' };
}

// 取得したフィード XML からタイトルを決めた保存用フォームを返す。
// タイトルがフィードから取れなければ ok:false で理由を返す
// (呼び出し側は保存しない)。ID は含めない (サーバーが URL から決める)。
export function resolveFeedAddForm(form, { xml = '' } = {}) {
  const base = {
    url: String(form?.url || '').trim(),
    category: String(form?.category || '').trim(),
  };
  const title = parseFeedMeta(xml).title;
  if (!title) {
    return { ok: false, message: 'タイトルを自動で取得できませんでした。このフィードは登録できません。' };
  }
  return { ok: true, form: { ...base, title } };
}

// saveFeed へ送る feed オブジェクトを組み立てる。
// 新規 (base なし): ID は送らない (サーバーが URL から決める)。
// isPrivate=false (isPrivate はサーバーが URL から決める)。
// 編集 (base あり): ID / タイトル / URL は元のフィードのまま、
// ジャンルだけをフォームから反映する。
export function buildSaveFeedPayload(form, base = null) {
  if (base) {
    return {
      id: base.id,
      title: base.title || '',
      url: base.url || '',
      category: String(form?.category || '').trim(),
      isPrivate: base.isPrivate === true,
    };
  }
  return {
    title: String(form?.title || '').trim(),
    url: String(form?.url || '').trim(),
    category: String(form?.category || '').trim(),
    isPrivate: false,
  };
}

// 管理画面のジャンル (カテゴリ) 絞り込み。カテゴリは前後の空白を除いて
// 完全一致で比べる (タイムラインのカテゴリ絞り込みと同じ意味)。
// カテゴリ未指定 (空) は全件をそのまま返す。
export function filterAdminFeeds(feeds, category) {
  const list = Array.isArray(feeds) ? feeds : [];
  const c = String(category || '').trim();
  if (!c) return list.slice();
  return list.filter((f) => String(f?.category || '').trim() === c);
}

// 並び替え: feeds の中で feedId を direction (-1=上, +1=下) へ1つ動かした
// 新しい配列を返す。端で動かせない場合と対象が無い場合は null。
export function moveFeedOrder(feeds, feedId, direction) {
  const idx = feeds.findIndex((f) => f.id === feedId);
  if (idx < 0) return null;
  const next = idx + direction;
  if (next < 0 || next >= feeds.length) return null;
  const out = [...feeds];
  [out[idx], out[next]] = [out[next], out[idx]];
  return out;
}

// 一覧の状態行: 最終取得時刻＋ステータス (エラーがあればエラーを優先)。
export function formatFeedStatus(feed, now) {
  if (!feed) return '';
  const parts = [];
  if (feed.lastFetchedAt) parts.push(`最終取得 ${formatPublishedAt(feed.lastFetchedAt, now)}`);
  else parts.push('未取得');
  if (feed.lastError) parts.push(`エラー: ${feed.lastError}`);
  else if (feed.lastStatus) parts.push(`状態 ${feed.lastStatus}`);
  return parts.join('／');
}

// 並び替え保存の直列化＋合体 (coalesce)。送信中に新しい順序が来たら、
// 進行中の送信が終わった後に「最新の順序だけ」を送る (途中の順序は送らない)。
// submit の Promise は、その順序か、それを上書きした新しい順序の保存が
// 完了した時点で解決する。保存に失敗したら、その送信分に対応する
// submit が reject する (後続の送信は続けて試みる)。
export function createOrderSender(send) {
  let inFlight = false;
  let pending = null; // { ids, waiters: [{ resolve, reject }] }

  async function pump() {
    inFlight = true;
    while (pending) {
      const current = pending;
      pending = null;
      try {
        await send(current.ids);
        current.waiters.forEach((w) => w.resolve());
      } catch (e) {
        current.waiters.forEach((w) => w.reject(e));
      }
    }
    inFlight = false;
  }

  return {
    submit(ids) {
      return new Promise((resolve, reject) => {
        if (pending) {
          pending.ids = [...ids];
          pending.waiters.push({ resolve, reject });
        } else {
          pending = { ids: [...ids], waiters: [{ resolve, reject }] };
        }
        if (!inFlight) pump();
      });
    },
  };
}
