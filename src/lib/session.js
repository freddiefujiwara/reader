// セッション ({token, role, expiresAt}) の端末ローカル保存。
// 本番とステージングで localStorage キーを分ける (blog で起きた
// 本番キャッシュをステージングが読む混線の再発防止)。
import { isStagingBuild } from '../staging-banner.js';

export function sessionKey(env) {
  return isStagingBuild(env) ? 'reader:session:v1:staging' : 'reader:session:v1';
}

export function saveSession(session, storage = localStorage, env) {
  if (!session || !session.token) return;
  try {
    storage.setItem(
      sessionKey(env),
      JSON.stringify({
        token: session.token,
        role: session.role || 'owner',
        expiresAt: session.expiresAt || null,
      })
    );
  } catch {
    // 保存できなくても、その場のセッション自体は使える。
  }
}

export function loadSession(storage = localStorage, env, now = Date.now()) {
  try {
    const raw = storage.getItem(sessionKey(env));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.token) return null;
    if (parsed.expiresAt) {
      const exp = Date.parse(parsed.expiresAt);
      if (!Number.isNaN(exp) && exp <= now) {
        storage.removeItem(sessionKey(env));
        return null;
      }
    }
    return { token: parsed.token, role: parsed.role || 'owner', expiresAt: parsed.expiresAt || null };
  } catch {
    return null;
  }
}

export function clearSession(storage = localStorage, env) {
  try {
    storage.removeItem(sessionKey(env));
  } catch {
    // 消せなくても致命的ではない。
  }
}
