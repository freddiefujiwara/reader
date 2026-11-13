import { describe, it, expect } from 'vitest';
import { sessionKey, saveSession, loadSession, clearSession } from '../src/lib/session.js';

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

describe('sessionKey', () => {
  it('本番とステージングでキーが分かれる', () => {
    expect(sessionKey({})).toBe('reader:session:v1');
    expect(sessionKey({ VITE_STAGING: '1' })).toBe('reader:session:v1:staging');
    expect(sessionKey({ VITE_STAGING: '0' })).toBe('reader:session:v1');
  });
});

describe('save/load/clear', () => {
  it('保存したセッションを読み戻せる', () => {
    const s = fakeStorage();
    saveSession({ token: 'tok123', role: 'owner', expiresAt: '2999-01-01T00:00:00.000Z' }, s, {});
    expect(loadSession(s, {})).toEqual({ token: 'tok123', role: 'owner', expiresAt: '2999-01-01T00:00:00.000Z' });
  });
  it('ステージングで保存したセッションは本番キーでは読めない', () => {
    const s = fakeStorage();
    saveSession({ token: 'stg', role: 'readonly' }, s, { VITE_STAGING: '1' });
    expect(loadSession(s, {})).toBeNull();
    expect(loadSession(s, { VITE_STAGING: '1' }).token).toBe('stg');
  });
  it('期限切れのセッションは null を返し削除する', () => {
    const s = fakeStorage();
    saveSession({ token: 'old', role: 'owner', expiresAt: '2020-01-01T00:00:00.000Z' }, s, {});
    expect(loadSession(s, {}, Date.parse('2026-11-14T00:00:00Z'))).toBeNull();
    expect(s.getItem('reader:session:v1')).toBeNull();
  });
  it('clearSession で消える', () => {
    const s = fakeStorage();
    saveSession({ token: 'tok', role: 'owner' }, s, {});
    clearSession(s, {});
    expect(loadSession(s, {})).toBeNull();
  });
  it('壊れた JSON は null', () => {
    const s = fakeStorage();
    s.setItem('reader:session:v1', '{oops');
    expect(loadSession(s, {})).toBeNull();
  });
});
