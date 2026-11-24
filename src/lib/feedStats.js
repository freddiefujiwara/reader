// 管理画面のフィード行に出す利用状況の1行を作る。入力はサーバーの
// feed_stats 応答の1フィード分 { plays, playSeconds, opens, expands,
// views, lastAt } (記録が無いフィードは undefined で渡ってくる)。
// 削除候補の判断に使うものだけを出す: 再生 (回数と累計時間)、
// 記事を開いた回数、要約の展開、フィード表示、最終活動日。
// 集計の窓はサーバー側の生ログ保持と同じ直近90日。

function formatPlayDuration(playSeconds) {
  const sec = Math.max(0, Math.round(Number(playSeconds) || 0));
  if (sec < 60) return `${sec}秒`;
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `約${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `約${hours}時間${rest}分` : `約${hours}時間`;
}

function formatLastAt(iso, now) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

export function formatFeedUsage(stat, now = new Date()) {
  if (!stat) return '直近90日の記録なし';
  const parts = [];
  if (stat.plays > 0) parts.push(`再生 ${stat.plays}回（${formatPlayDuration(stat.playSeconds)}）`);
  if (stat.opens > 0) parts.push(`開く ${stat.opens}回`);
  if (stat.expands > 0) parts.push(`展開 ${stat.expands}回`);
  if (stat.views > 0) parts.push(`表示 ${stat.views}回`);
  const last = formatLastAt(stat.lastAt, now);
  if (last) parts.push(`最終 ${last}`);
  return parts.length ? parts.join(' ・ ') : '直近90日の記録なし';
}
