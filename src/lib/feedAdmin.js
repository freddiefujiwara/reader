// フィード管理の純粋な補助 (フォーム検証・保存ペイロード組み立て・状態表示)。
// Vue に依存しない関数だけにし、単体テストで振る舞いを固定する。
// 検証ルールはサーバー側 (reader-gas) と揃える: id はスラッグ、URL は https。
import { formatPublishedAt } from './format.js';
import { parseFeedMeta } from './feedParse.js';
import { generateFeedId } from './feedId.js';

// サーバー側 (reader-gas の FEED_ID_PATTERN) と完全一致させる:
// アンダースコア不可、先頭含め最大64文字。
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

// URL だけの検証 (自動入力では他の項目より先に URL を確かめる)。
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

// クライアント側の事前検証 (サーバー側でも同じ観点で検証される)。
// 問題が無ければ ''、あれば画面に出す文言を返す。
export function validateFeedForm(form, { isEdit = false } = {}) {
  if (!isEdit && !SLUG_RE.test(String(form?.id || '').trim())) {
    return 'IDは半角英小文字・数字・ハイフンで、先頭は英数字、64文字以内にしてください。';
  }
  if (!String(form?.title || '').trim()) {
    return 'タイトルを入力してください。';
  }
  return validateFeedUrl(form?.url);
}

// 新規追加で ID / タイトルのどちらかが空欄なら「URL だけの登録」に
// なり、保存前にフィードの取得が要る。両方埋まっていれば従来どおり
// 取得なしで保存する。
export function planFeedAdd(form) {
  const needTitle = !String(form?.title || '').trim();
  const needId = !String(form?.id || '').trim();
  return { auto: needTitle || needId, needTitle, needId };
}

// 取得したフィード XML から空欄を埋めたフォームを返す。タイトルが
// フィードからも取れなければ ok:false で理由を返す (呼び出し側は
// 保存せず、手入力を促す)。ID は URL から生成し、takenIds と
// 重なる場合は連番で避ける。
export function resolveFeedAddForm(form, { xml = '', takenIds = [] } = {}) {
  const base = {
    id: String(form?.id || '').trim(),
    title: String(form?.title || '').trim(),
    url: String(form?.url || '').trim(),
    category: String(form?.category || '').trim(),
  };
  const plan = planFeedAdd(base);
  if (!plan.auto) return { ok: true, form: base };
  let { id, title } = base;
  if (plan.needTitle) {
    title = parseFeedMeta(xml).title;
    if (!title) {
      return { ok: false, message: 'タイトルを自動で取得できませんでした。タイトルを入力してください。' };
    }
  }
  if (plan.needId) id = generateFeedId(base.url, takenIds);
  return { ok: true, form: { ...base, id, title } };
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
