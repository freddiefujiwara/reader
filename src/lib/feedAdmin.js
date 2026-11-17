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
  const parsed = tryParseUrl(url);
  if (!parsed) {
    return 'URLの形式が正しくありません。';
  }
  if (parsed.protocol !== 'https:') {
    return 'URLは https:// で始まるものにしてください。';
  }
  return '';
}

// URL として解釈できなければ null を返す (URL 判定系の共通入口)。
function tryParseUrl(url) {
  try {
    return new URL(String(url || '').trim());
  } catch {
    return null;
  }
}

const YOUTUBE_HOSTS = ['www.youtube.com', 'youtube.com', 'm.youtube.com'];

// YouTube 疑似フィード URL (youtube.com/feeds/videos.xml?channel_id=...)。
// 公式 RSS は 404 のため追加時に直接は読めず、タイトルはサーバーが
// 定期取得の際に Data API から補完する。追加時はタイトル '' で保存する。
export function isYouTubeFeedUrl(url) {
  const parsed = tryParseUrl(url);
  if (!parsed) return false;
  return (
    YOUTUBE_HOSTS.includes(parsed.hostname) &&
    parsed.pathname === '/feeds/videos.xml' &&
    !!parsed.searchParams.get('channel_id')
  );
}

// YouTube チャンネルページの URL (youtube.com/channel/UC... または
// youtube.com/@handle)。末尾のパス (/@handle/videos など) も許す。
// チャンネル ID の形はサーバー側の判定 (UC + 10文字以上) に合わせる。
export function isYouTubeChannelUrl(url) {
  const parsed = tryParseUrl(url);
  if (!parsed || !YOUTUBE_HOSTS.includes(parsed.hostname)) return false;
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
  const parsed = tryParseUrl(url);
  if (!parsed || !YOUTUBE_HOSTS.includes(parsed.hostname)) return '';
  if (parsed.pathname === '/feeds/videos.xml') {
    const id = parsed.searchParams.get('channel_id') || '';
    return /^UC[\w-]{10,}$/.test(id) ? id : '';
  }
  const m = parsed.pathname.match(/^\/channel\/(UC[\w-]{10,})(\/.*)?$/);
  return m ? m[1] : '';
}

// プレイリストを受け付けるホスト (music.youtube.com を含む)。
const YOUTUBE_PLAYLIST_HOSTS = [...YOUTUBE_HOSTS, 'music.youtube.com'];

// YouTube プレイリストの URL (youtube.com/playlist?list=...) かどうか。
// music.youtube.com の形や、list 以外のパラメータ (si など) が付いた
// 形も対象にする。
export function isYouTubePlaylistUrl(url) {
  return youtubePlaylistIdFromUrl(url) !== '';
}

// YouTube のプレイリスト ID を URL から取り出す。プレイリストの
// ページ (/playlist?list=...) だけを対象にし、取り出せなければ '' を
// 返す。ID の形は英数・ハイフン・アンダースコア10文字以上にそろえる
// (チャンネル ID の判定と同じ流儀)。
export function youtubePlaylistIdFromUrl(url) {
  const parsed = tryParseUrl(url);
  if (!parsed || !YOUTUBE_PLAYLIST_HOSTS.includes(parsed.hostname)) return '';
  if (parsed.pathname !== '/playlist') return '';
  const id = parsed.searchParams.get('list') || '';
  return /^[\w-]{10,}$/.test(id) ? id : '';
}

// プレイリスト URL の保存正規形。ホストの揺れと余分なパラメータを
// 落とし、https://www.youtube.com/playlist?list=<ID> にそろえる
// (サーバー側の保存形と同じ)。プレイリスト URL でなければ ''。
// フィード ID は URL 文字列のハッシュで決まるため、揺れは保存前に
// ここで吸収しないと別フィードになってしまう。
export function normalizeYouTubePlaylistUrl(url) {
  const id = youtubePlaylistIdFromUrl(url);
  return id ? `https://www.youtube.com/playlist?list=${id}` : '';
}

// YouTube の動画 ID を記事リンクから取り出す。watch?v= と youtu.be/ と
// /shorts/ に対応し、取り出せなければ '' を返す。記事 ID の付け替え
// (ID = ハッシュ(フィードID + 動画ID)) に使う。
export function youtubeVideoIdFromLink(link) {
  const parsed = tryParseUrl(link);
  if (!parsed) return '';
  const hosts = [...YOUTUBE_HOSTS, 'music.youtube.com'];
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
// プレイリストも同様に取得を省いてタイトル '' で保存する
// ('playlist': 取り込みとタイトル補完はサーバーが行う)。
// それ以外は保存前にフィードを取得してタイトルを取る ('fetch')。
export function planFeedAdd(form) {
  if (isYouTubePlaylistUrl(form?.url)) return { mode: 'playlist' };
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
// 編集 (base あり): ID / タイトル / URL は元のフィードのまま、
// ジャンルだけをフォームから反映する。
export function buildSaveFeedPayload(form, base = null) {
  if (base) {
    return {
      id: base.id,
      title: base.title || '',
      url: base.url || '',
      category: String(form?.category || '').trim(),
    };
  }
  const url = String(form?.url || '').trim();
  return {
    title: String(form?.title || '').trim(),
    // プレイリスト URL は保存正規形にそろえてから送る (フィード ID が
    // URL ハッシュで決まるため、揺れをここで吸収する)。
    url: normalizeYouTubePlaylistUrl(url) || url,
    category: String(form?.category || '').trim(),
  };
}

// 編集フォームが編集開始時点から変わっているか (保存ボタンの
// 活性化判定)。比べるのは保存される値 (タイトルとジャンル) で、
// 前後の空白を取り除いてから比べる (保存時にも trim されるため、
// 空白だけの差は変更に数えない)。値を変えて元に戻せば未変更に
// 戻る。original が無い場合は比べようがないので、保存を妨げない
// よう変更ありとして扱う。
export function isFeedFormDirty(original, form) {
  if (!original || !form) return true;
  const norm = (v) => String(v ?? '').trim();
  return (
    norm(original.title) !== norm(form.title) ||
    norm(original.category) !== norm(form.category)
  );
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

// フォームのジャンル候補: 既存ジャンルのうち、入力中の文字列を
// 含むものを出現順のまま返す。空入力なら全候補。入力と完全一致
// する候補は、選んでも値が変わらないので出さない。候補の表示は
// フォーム内の通常フローに置く (ネイティブ datalist のポップ
// アップは iOS Safari で保存ボタンに被って押せなくなるため使わ
// ない)。
export function genreSuggestions(options, input) {
  const list = (Array.isArray(options) ? options : [])
    .filter((c) => typeof c === 'string' && c !== '');
  const q = typeof input === 'string' ? input.trim() : '';
  if (!q) return list;
  const lower = q.toLowerCase();
  return list.filter((c) => c !== q && c.toLowerCase().includes(lower));
}

// 並び替え: list の fromIndex の要素を toIndex へ動かした新しい配列を
// 返す。範囲外・同じ位置 (動かない) の場合は null。元の配列は変えない。
export function moveItemToIndex(list, fromIndex, toIndex) {
  const items = Array.isArray(list) ? list : [];
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return null;
  if (fromIndex < 0 || fromIndex >= items.length) return null;
  if (toIndex < 0 || toIndex >= items.length) return null;
  if (fromIndex === toIndex) return null;
  const out = [...items];
  const [moved] = out.splice(fromIndex, 1);
  out.splice(toIndex, 0, moved);
  return out;
}

// ドラッグ中の行のピッチ (自分の上端から次の行の上端までの距離)。
// 掴んだ行を取り除くと後続はこの量だけ詰まる (行の高さ＋行間)。
// 末尾の行には次の行が無いので、自分の高さ＋行間で求める。行間は
// 直前の行ペアから取る。1つ前の行のピッチで代用すると、高さの違う
// 行では詰め量が自分の高さとずれて、空いた場所と掴んだ行が重なる。
// 1行だけなら高さそのもの。
export function dragRowPitch(rects, index) {
  const rows = Array.isArray(rects) ? rects : [];
  if (index < 0 || index >= rows.length) return 0;
  if (index + 1 < rows.length) return rows[index + 1].top - rows[index].top;
  if (index > 0) {
    const prev = rows[index - 1];
    const gap = rows[index].top - (prev.top + prev.height);
    return rows[index].height + gap;
  }
  return rows[index].height;
}

// ドラッグ中の挿入位置: 各行の { top, height } (文書座標) と、掴んだ行の
// 開始位置からの移動量 offsetY から、掴んだ行が最終的に入る
// インデックスを返す。掴んだ行の中心が、進む方向にある行の
// (ドラッグ開始時点の) 中点を越えた分だけ進み/戻る。中心が中点
// ちょうどの場合は越えた数に入れない。基準は開始時点の並びで固定
// するため、途中で他の行が詰めて動いても判定は揺れない。
// ただし両端だけは例外: 呼び出し側は移動量を「掴んだ行の端が一覧の
// 端に届く位置」でクランプするため、高さが均一だと中心は端の行の
// 中点とちょうど重なって (越えたことにならず) 永遠に端へ入れない。
// 掴んだ行より端の行が低ければ、中心は中点にすら届かない。その
// 場合、端の行はどかず、掴んだ行がその上に重なって表示が崩れる。
// そこで、移動量がクランプの下限/上限 (掴んだ行の上端が先頭行の
// 上端、下端が末尾行の下端に一致する量) に達したら、端のインデッ
// クスを返す。クランプと同じ式で比べるので、ちょうど端に届いた
// ときに確実に一致する。
export function dragInsertIndex(rects, fromIndex, offsetY) {
  const rows = Array.isArray(rects) ? rects : [];
  if (fromIndex < 0 || fromIndex >= rows.length) return fromIndex;
  const dragged = rows[fromIndex];
  const minOffset = rows[0].top - dragged.top;
  if (offsetY <= minOffset) return 0;
  const last = rows[rows.length - 1];
  const maxOffset = last.top + last.height - (dragged.top + dragged.height);
  if (offsetY >= maxOffset) return rows.length - 1;
  const center = dragged.top + dragged.height / 2 + offsetY;
  let target = fromIndex;
  if (offsetY > 0) {
    for (let i = fromIndex + 1; i < rows.length; i += 1) {
      if (rows[i].top + rows[i].height / 2 < center) target = i;
      else break;
    }
  } else if (offsetY < 0) {
    for (let i = fromIndex - 1; i >= 0; i -= 1) {
      if (rows[i].top + rows[i].height / 2 > center) target = i;
      else break;
    }
  }
  return target;
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
