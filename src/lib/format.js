// 記事の公開日時の表示整形 (端末のローカル時刻で判定する)。
// 例: 今日 7:05 / 昨日 7:05 / 11/13 / 2025/12/3

function pad2(n) {
  return String(n).padStart(2, '0');
}

function timePart(d) {
  // 時刻は「7:05」の形 (時はゼロ埋めしない、xuexi 等の表示に合わせる)。
  return `${d.getHours()}:${pad2(d.getMinutes())}`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatPublishedAt(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const ref = now instanceof Date ? now : new Date(now);
  if (sameDay(d, ref)) return `今日 ${timePart(d)}`;
  const yesterday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨日 ${timePart(d)}`;
  if (d.getFullYear() === ref.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
