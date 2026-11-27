import { nextTick } from 'vue';

// IndexedDB work can finish in a macrotask; Vue then applies DOM updates.
export async function flushRound() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

// Preserve the round-based contract: check before waiting and once more after
// the last round. Some callers use false to decide whether to try a fallback.
export async function flushUntil(condition, maxRounds = 120) {
  for (let i = 0; i < maxRounds; i += 1) {
    if (await condition()) return true;
    await flushRound();
  }
  return !!(await condition());
}
