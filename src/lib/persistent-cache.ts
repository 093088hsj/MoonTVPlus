/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

/**
 * 跨实例持久缓存
 *
 * 背景：项目里多处用模块级变量做缓存（`let xxxCache = ...`）。在传统 Node 服务器上
 * 这没问题，但部署到 Cloudflare Workers / EdgeOne Pages 这类无状态运行时后，
 * 实例随时被回收、每个边缘节点各自独立，模块级缓存的命中率极低，
 * 结果是本该 3 小时才算一次的聚合请求几乎每次都在走冷路径。
 *
 * 这里在内存缓存（L1）之外补一层落库缓存（L2），复用 D1/SQLite 的 global_config 表，
 * 不需要新增迁移。存储层不提供 hash 适配器时（如 localstorage 模式）自动退化为纯内存，
 * 不影响功能。
 */

import { getStorage } from './db';

interface CacheEntry<T> {
  data: T;
  ts: number;
}

interface HashAdapter {
  hGet(hashKey: string, field: string): Promise<string | null>;
  hSet(hashKey: string, field: string, value: string): Promise<void>;
}

const HASH_KEY = 'moontv:api-cache';
const memoryCache = new Map<string, CacheEntry<unknown>>();

function resolveHashAdapter(): HashAdapter | null {
  try {
    const storage = getStorage() as any;
    const adapter = storage?.adapter;
    if (
      adapter &&
      typeof adapter.hGet === 'function' &&
      typeof adapter.hSet === 'function'
    ) {
      return adapter as HashAdapter;
    }
  } catch {
    // 存储不可用（localstorage 模式或绑定缺失）时退化为纯内存缓存
  }
  return null;
}

/**
 * 读缓存，未命中或已过期时调用 fetcher 并回写。
 * fetcher 抛错时不写缓存，直接把错误抛给调用方。
 */
export async function getCached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const now = Date.now();

  const hit = memoryCache.get(key) as CacheEntry<T> | undefined;
  if (hit && now - hit.ts < ttlMs) {
    return hit.data;
  }

  const adapter = resolveHashAdapter();

  if (adapter) {
    try {
      const raw = await adapter.hGet(HASH_KEY, key);
      if (raw) {
        const parsed = JSON.parse(raw) as CacheEntry<T>;
        if (
          parsed &&
          typeof parsed.ts === 'number' &&
          now - parsed.ts < ttlMs
        ) {
          memoryCache.set(key, parsed);
          return parsed.data;
        }
      }
    } catch (error) {
      console.warn(`[persistent-cache] 读取 ${key} 失败，回退到重新获取:`, error);
    }
  }

  const data = await fetcher();
  const entry: CacheEntry<T> = { data, ts: now };
  memoryCache.set(key, entry);

  if (adapter) {
    try {
      await adapter.hSet(HASH_KEY, key, JSON.stringify(entry));
    } catch (error) {
      console.warn(`[persistent-cache] 写入 ${key} 失败（仅内存生效）:`, error);
    }
  }

  return data;
}

/** 手动失效某个缓存键（内存 + 落库）。 */
export async function invalidateCached(key: string): Promise<void> {
  memoryCache.delete(key);
  const adapter = resolveHashAdapter();
  if (!adapter) return;
  try {
    await adapter.hSet(HASH_KEY, key, JSON.stringify({ data: null, ts: 0 }));
  } catch (error) {
    console.warn(`[persistent-cache] 失效 ${key} 失败:`, error);
  }
}
