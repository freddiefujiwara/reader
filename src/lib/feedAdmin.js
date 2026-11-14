// フィード管理の純粋な補助 (フォーム検証・保存ペイロード組み立て・状態表示)。
// Vue に依存しない関数だけにし、単体テストで振る舞いを固定する。
// 検証ルールはサーバー側 (reader-gas) と揃える: id はスラッグ、URL は https。
import { formatPublishedAt } from './format.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function createFeedForm() {
  return { id: '', title: '', url: '', category: '' };
}

// 編集フォーム初期値。id は編集時そのまま (入力欄は無効化される)。
export function feedFormFromFeed(feed) {
  return {
    id: feed?.id || '',
    title: feed?.title || '',
    url: feed?.url || '',
    category: feed?.category || '',
  };
}

// クライアント側の事前検証 (サーバー側でも同じ観点で検証される)。
// 問題が無ければ ''、あれば画面に出す文言を返す。
export function validateFeedForm(form, { isEdit = false } = {}) {
  if (!isEdit && !SLUG_RE.test(String(form?.id || '').trim())) {
    return 'IDは半角英小文字・数字・ハイフン・アンダースコアで、先頭は英数字にしてください。';
  }
  if (!String(form?.title || '').trim()) {
    return 'タイトルを入力してください。';
  }
  const url = String(form?.url || '').trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'URLの形式が正しくありません。';
  }
  if (parsed.protocol !== 'https:') {
    return 'URLは https:// で始まるものにしてください。';
  }
  return '';
}

// saveFeed へ送る feed オブジェクトを組み立てる。
// enabled / isPrivate はフォームに無いため、編集時は元のフィードから引き継ぎ、
// 新規時は enabled=true / isPrivate=false (isPrivate はサーバーが URL から決める)。
export function buildSaveFeedPayload(form, base = null) {
  return {
    id: String(form?.id || '').trim(),
    title: String(form?.title || '').trim(),
    url: String(form?.url || '').trim(),
    category: String(form?.category || '').trim(),
    enabled: base ? base.enabled !== false : true,
    isPrivate: base ? base.isPrivate === true : false,
  };
}

// 有効/無効トグルの保存ペイロード (他フィールドはそのまま、enabled だけ反転)。
export function toggleEnabledPayload(feed) {
  return {
    id: feed.id,
    title: feed.title || '',
    url: feed.url || '',
    category: feed.category || '',
    enabled: feed.enabled === false,
    isPrivate: feed.isPrivate === true,
  };
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
