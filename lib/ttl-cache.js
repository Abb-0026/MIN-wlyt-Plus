'use strict';

/**
 * 依存なしの小さな TTL + LRU キャッシュ。
 *
 * メタデータ取得で効く3つの性質だけを持つ:
 *   1. TTL（期限付き）
 *   2. single-flight（同じキーの同時計算を1本に束ね、上流への往復を1回にする）
 *   3. stale 読み（期限切れでも中身を返せる = stale-while-revalidate 用）
 */
class TtlCache {
  constructor({ max = 500, ttl = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max;
    this.ttl = ttl;
    this.now = now;
    this.map = new Map();
    this._inflight = new Map();
  }

  _expired(entry) {
    return !entry || (entry.exp !== 0 && entry.exp < this.now());
  }

  get(key) {
    const entry = this.map.get(key);
    if (this._expired(entry)) {
      this.map.delete(key);
      return undefined;
    }
    // Map は挿入順なので、読み直したキーを末尾へ移して LRU の最新にする
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** 期限切れを無視して返す（上流が死んでいるときの最後の一手） */
  getStale(key) {
    const entry = this.map.get(key);
    return entry ? entry.value : undefined;
  }

  /** 期限切れエントリを「経過ms」付きで返す。新鮮・不在なら null */
  getExpired(key) {
    const entry = this.map.get(key);
    if (!entry || !this._expired(entry)) return null;
    return { value: entry.value, age: this.now() - entry.exp };
  }

  set(key, value, ttl) {
    const exp = ttl === 0 ? 0 : this.now() + (ttl === undefined ? this.ttl : ttl);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, exp });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  /**
   * キャッシュ・アサイド。同じキーの同時呼び出しは1回だけ計算し、
   * 全員がその結果（Promise）を共有する。
   */
  async wrap(key, ttl, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const inflight = this._inflight.get(key);
    if (inflight) return inflight;

    const job = (async () => {
      try {
        const value = await fn();
        if (value !== undefined && value !== null) this.set(key, value, ttl);
        return value;
      } finally {
        this._inflight.delete(key);
      }
    })();

    this._inflight.set(key, job);
    return job;
  }

  /** 期限切れエントリの掃除 */
  sweep() {
    const now = this.now();
    for (const [key, entry] of this.map) {
      if (entry.exp !== 0 && entry.exp < now) this.map.delete(key);
    }
  }
}

module.exports = { TtlCache };
