// ネットワーク失敗時の送り直し (api.js と feedFetch.js の共通処理)。
// fn を実行し、isRetryable が真を返す失敗のときだけ retries 回まで
// 送り直す。それ以外の失敗はそのまま投げる。
export async function withRetry(fn, { retries = 1, retryDelayMs = 900, isRetryable = () => false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

// promise が ms 以内に終わらなければ Error('timeout') で reject する。
// 元の promise 自体は止めない (裏で終わればそれでよい)。固まると
// 画面全体が止まる読み込み (起動時のローカル読み直し等) の保険。
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
