import { describe, it, expect, vi } from 'vitest';
import { flushUntil } from './helpers/flush.js';

describe('flushUntil', () => {
  it('returns true without waiting when an async condition already holds', async () => {
    const condition = vi.fn(async () => 'ready');
    expect(await flushUntil(condition, 0)).toBe(true);
    expect(condition).toHaveBeenCalledTimes(1);
  });

  it('lets queued tasks complete and checks after the last allowed round', async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 0);
    const condition = vi.fn(() => ready);
    expect(await flushUntil(condition, 1)).toBe(true);
    expect(condition).toHaveBeenCalledTimes(2);
  });

  it('returns false when the caller-supplied round limit runs out', async () => {
    const condition = vi.fn(() => false);
    expect(await flushUntil(condition, 2)).toBe(false);
    expect(condition).toHaveBeenCalledTimes(3);
  });
});
