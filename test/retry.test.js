import { describe, it, expect } from 'vitest';
import { withTimeout } from '../src/lib/retry.js';

describe('withTimeout', () => {
  it('制限時間内に終われば、その結果を返す', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('元の promise の失敗はそのまま伝える', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('制限時間を過ぎたら timeout で reject する', async () => {
    const never = new Promise(() => {});
    await expect(withTimeout(never, 10)).rejects.toThrow('timeout');
  });

  it('タイムアウト後に元の promise が終わっても結果は変わらない', async () => {
    let resolveLater;
    const slow = new Promise((resolve) => { resolveLater = resolve; });
    const result = withTimeout(slow, 10);
    await expect(result).rejects.toThrow('timeout');
    resolveLater(1);
    await expect(result).rejects.toThrow('timeout');
  });
});
