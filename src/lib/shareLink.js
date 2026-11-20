// 共有リンク (#share=<token>) の URL 組み立てと、有効期限の表示整形。
// 開く側 (App.vue の tryShareFromHash) はハッシュだけを見るため、
// ベースはアプリの置き場所 (本番 /reader/、ステージングは
// /reader/staging/) に合わせればよい。
import { pad2 } from './format.js';

// token から共有リンクの URL を作る。origin は末尾の '/' なし、
// base はアプリのベースパス (前後に '/' があってもよい)。
export function buildShareUrl(token, { origin = '', base = '/' } = {}) {
  // token は発行応答の文字列が前提。文字列でない値 (壊れた応答の数値や
  // オブジェクト) でリンクを作ると、開けない URL ができてしまうため
  // 空文字にする (文字列化できないオブジェクトは補間で投げる)。
  if (typeof token !== 'string' || !token) return '';
  const o = String(origin || '').replace(/\/+$/, '');
  let b = String(base || '/');
  if (!b.startsWith('/')) b = `/${b}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return `${o}${b}#share=${token}`;
}

// 有効期限の表示 (例: 2026/12/16 5:47)。端末のローカル時刻で出す。
// 解釈できない値は空文字にする (format.js と同じ流儀)。
export function formatShareExpiry(iso) {
  // 期限は ISO 文字列 (または Date) が前提。それ以外の型は空文字にする
  // (formatPublishedAt と同じ理由)。
  if (typeof iso !== 'string' && !(iso instanceof Date)) return '';
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad2(d.getMinutes())}`;
}
