// フィード ID の自動生成。サーバー側のスラッグ規則
// (/^[a-z0-9][a-z0-9-]{0,63}$/) に合う ID をフィード URL から決める。
// タイトルは日本語のことが多くスラッグ化できないため、URL のホスト名と
// パスの特徴的な部分から組み立てる。クエリ文字列は見ない。

const SLUG_MAX = 64;
// ホスト名・パスに頻出するが識別に役立たない語 (この一覧だけに絞る)。
const NOISE_TOKENS = new Set(['www', 'feeds', 'feed', 'rss', 'podcast', 'api', 'v1']);
// ホスト名の末尾ラベルがこれなら TLD とみなして落とす (2ラベル以上ある場合のみ)。
const TLD_TOKENS = new Set(['com', 'net', 'org', 'io', 'fm', 'jp', 'tv', 'me', 'info', 'biz']);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hostTokens(hostname) {
  const labels = String(hostname || '')
    .toLowerCase()
    .split('.')
    .filter(Boolean);
  if (labels.length >= 2 && TLD_TOKENS.has(labels[labels.length - 1])) labels.pop();
  const out = [];
  labels.forEach((label) => {
    tokenize(label).forEach((t) => {
      if (!NOISE_TOKENS.has(t)) out.push(t);
    });
  });
  return out;
}

function pathTokens(pathname, hostToks) {
  const out = [];
  String(pathname || '')
    .split('/')
    .filter(Boolean)
    .forEach((segment) => {
      // 末尾の拡張子 (.xml など) は識別に使わない。
      const noExt = segment.replace(/\.[a-z0-9]+$/i, '');
      tokenize(noExt).forEach((t) => {
        if (t.length < 2) return; // 's' のような1文字は識別に使えない
        if (NOISE_TOKENS.has(t)) return;
        // ホスト側の語を含む/含まれる語は二重になるので落とす
        // (例: feeds.rebuild.fm のパス 'rebuildfm')。
        if (hostToks.some((h) => t.includes(h) || h.includes(t))) return;
        out.push(t);
      });
    });
  return out;
}

// スラッグの上限に収める。途中で切れる場合は '-' の境界で切り、
// 末尾の '-' は落とす。
function truncateSlug(slug, max) {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const idx = cut.lastIndexOf('-');
  return (idx > 0 ? cut.slice(0, idx) : cut).replace(/-+$/, '');
}

// URL からフィード ID を生成する。takenIds に含まれる場合は
// '-2', '-3', ... を付けて重ならないようにする。URL から何も
// 取り出せなければ 'feed' を下地にする。
export function generateFeedId(url, takenIds) {
  const taken = new Set(Array.isArray(takenIds) ? takenIds : []);
  let base = '';
  try {
    const parsed = new URL(String(url || '').trim());
    const hosts = hostTokens(parsed.hostname);
    base = [...hosts, ...pathTokens(parsed.pathname, hosts)].join('-');
  } catch {
    base = '';
  }
  base = truncateSlug(base, SLUG_MAX);
  if (!base) base = 'feed';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = truncateSlug(base, SLUG_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
