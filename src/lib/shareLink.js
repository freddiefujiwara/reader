// 共有リンク (#share=<token>) の URL 組み立てと、有効期限の表示整形。
// 開く側 (App.vue の tryShareFromHash) はハッシュだけを見るため、
// ベースはアプリの置き場所 (本番 /reader/、ステージングは
// /reader/staging/) に合わせればよい。
import { pad2 } from './format.js';

// token から共有リンクの URL を作る。origin は末尾の '/' なし、
// base はアプリのベースパス (前後に '/' があってもよい)。
export function buildShareUrl(token, { origin = '', base = '/' } = {}) {
  if (!token) return '';
  const o = String(origin || '').replace(/\/+$/, '');
  let b = String(base || '/');
  if (!b.startsWith('/')) b = `/${b}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return `${o}${b}#share=${token}`;
}

// 有効期限の表示 (例: 2026/12/16 5:47)。端末のローカル時刻で出す。
// 解釈できない値は空文字にする (format.js と同じ流儀)。
export function formatShareExpiry(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad2(d.getMinutes())}`;
}
