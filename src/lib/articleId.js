// 記事ID: reader-gas と同じ規則で SHA-256(feedId + '\n' + (guid || link))。
// サーバー保存分の記事とクライアント取得分が同じIDになるよう、
// テストベクトルで固定している (test/articleId.test.js)。

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function articleId(feedId, guidOrLink) {
  return sha256Hex(String(feedId) + '\n' + String(guidOrLink));
}
