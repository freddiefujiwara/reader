// 記事カードの SNS 共有 URL の組み立て。共有先はいずれも公式の
// intent / sharer エンドポイントで、投稿の確定は各 SNS 側で行う
// (API 投稿はしない)。共有するリンクは記事の元リンク (articles の
// link。YouTube なら watch URL、その他は記事 URL)。

// X の投稿画面。タイトルと元リンクを渡す。
export function buildXShareUrl(title, link) {
  if (!link) return '';
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(String(title || ''))}&url=${encodeURIComponent(link)}`;
}

// Facebook のシェア画面。元リンクだけを渡す (タイトルや画像は
// リンク先の OGP から取られる)。
export function buildFacebookShareUrl(link) {
  if (!link) return '';
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`;
}

// Threads の投稿画面。text 1本にタイトルと元リンクを入れる。
export function buildThreadsShareUrl(title, link) {
  if (!link) return '';
  const text = [String(title || ''), link].filter(Boolean).join('\n');
  return `https://www.threads.net/intent/post?text=${encodeURIComponent(text)}`;
}
