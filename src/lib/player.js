// ポッドキャストプレイヤーの純粋な補助関数 (DOM / Audio 要素の操作は
// App.vue 側)。時間表示の形は blog のプレイヤー (musicPlayer.js の
// formatTime) に揃え、1時間以上のエピソードだけ H:MM:SS にする。

export const SPEEDS = [1, 1.25, 1.5, 2];

// 秒 → "M:SS" (1時間以上は "H:MM:SS")。NaN や負数は "0:00"。
export function formatTime(sec) {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const seconds = String(total % 60).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  if (hours > 0) {
    const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }
  return `${Math.floor(total / 60)}:${seconds}`;
}

// 再生速度の循環: 1 → 1.25 → 1.5 → 2 → 1。未知の値は先頭 (1) へ。
export function nextSpeed(current) {
  const idx = SPEEDS.indexOf(current);
  return SPEEDS[(idx + 1) % SPEEDS.length];
}

// シーク先を [0, duration] へ丸める。duration が不明なら下限だけ守る。
export function clampSeek(sec, duration) {
  const value = Number.isFinite(sec) ? sec : 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, value);
  return Math.min(Math.max(0, value), duration);
}

// 進み具合 (0..1)。duration が不明・ゼロなら 0。
export function progressRatio(current, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(current) || current <= 0) return 0;
  return Math.min(1, current / duration);
}
