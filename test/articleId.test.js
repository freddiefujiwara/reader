import { describe, it, expect } from 'vitest';
import { articleId, sha256Hex } from '../src/lib/articleId.js';

// reader-gas の articleId と同じ値になることを固定するベクトル。
// サーバー保存分の記事とクライアント取得分が同じIDで一致するために必要。
describe('articleId', () => {
  it('YouTube フィード (guid = 動画ID)', async () => {
    await expect(articleId('yt-rakutentech', 'dQw4w9WgXcQ'))
      .resolves.toBe('1a21143fa6ef191a6d44e6886664e1bdbc90c0b340ed06325377b6653a8a35fa');
  });
  it('通常フィード (guid = リンク)', async () => {
    await expect(articleId('nhk', 'https://example.com/a/123'))
      .resolves.toBe('6a63526efcd0798267c25c96afdc5678f9e96ea568baf211bfc0b561cc99ee9b');
  });
  it('sha256Hex は UTF-8 で計算する', async () => {
    // 'abc' の SHA-256 として知られた値。
    await expect(sha256Hex('abc')).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
