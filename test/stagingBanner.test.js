import { describe, it, expect } from 'vitest';
import { productionUrl } from '../src/staging-banner.js';

// staging-banner.js は全アプリでバイト単位に同一を保つファイル。
// ここでは reader 側の前提 (base が /reader/ と /reader/staging/) で
// productionUrl の導出だけを固定する。
describe('productionUrl', () => {
  it('ステージングの base から末尾の staging/ を外して本番 URL にする', () => {
    expect(productionUrl({ BASE_URL: '/reader/staging/' })).toBe('/reader/');
  });
  it('ステージングでない base はそのまま返す', () => {
    expect(productionUrl({ BASE_URL: '/reader/' })).toBe('/reader/');
    expect(productionUrl({ BASE_URL: '/' })).toBe('/');
  });
  it('BASE_URL が無ければ / を返す', () => {
    expect(productionUrl({})).toBe('/');
  });
});
