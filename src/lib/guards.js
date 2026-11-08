// Small in-memory helpers: per-key mutex, attempt limiter, and TTL store.

const chains = new Map();
/** Run fn after any earlier fn with the same key has finished. */
export const withLock = (key, fn) => {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
};

const hits = new Map();
/** Returns true if the caller is over the limit (max attempts per window). */
export const rateLimited = (key, max = 6, windowMs = 10 * 60 * 1000) => {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
};
export const clearRateLimit = (key) => hits.delete(key);
export const resetRateLimits = () => hits.clear();

export class TtlMap {
  constructor(ttlMs) {
    this.ttl = ttlMs;
    this.map = new Map();
  }
  set(key, value) {
    this.map.set(key, { value, exp: Date.now() + this.ttl });
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  delete(key) {
    this.map.delete(key);
  }
}
