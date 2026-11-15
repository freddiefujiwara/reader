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
