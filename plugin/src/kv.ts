// `ctx.storage` behind openclaw's `PluginStateKeyedStore` contract.
//
// WHY THIS ADAPTER EXISTS
//   The capture pipeline stores its landing zone (the `captured` 0/1/2 state
//   machine) through `configureMemoryCoreDreamingState`, which takes an
//   `openKeyedStore(namespace) -> store`. Inside openclaw that opener is backed by
//   SQLite plugin state. OpenCode's equivalent surface is `ctx.storage`: durable
//   JSON, scoped to the plugin, prefix-scan with a cursor. Same operations, so the
//   pipeline needs no change -- only this translation.
//
// VALUE ENCODING
//   `PluginStateEntry` carries `createdAt`, which `ctx.storage` does not store, so
//   each value is wrapped as `{ c, v }`. The wrapper is JSON, which is what
//   `ctx.storage.set` accepts anyway.
//
// KEY LAYOUT
//   `mem-plus/<namespace>/<key>` -- one namespace per capture namespace so a
//   `scan` is exactly one logical store, and `entries()` never has to filter.
import type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MemoryCoreOpenKeyedStore } from "../../extensions/memory-core/src/dreaming-state.js";
import type { PluginContext } from "./opencode.js";

const STORAGE_PREFIX = "mem-plus/";

/** Page size for `ctx.storage.scan`; large enough to drain a namespace in one hop. */
const SCAN_PAGE = 500;

type StoredValue = { readonly c: number; readonly v: unknown };

function namespacePrefix(namespace: string): string {
  return `${STORAGE_PREFIX}${namespace}/`;
}

function isStoredValue(value: unknown): value is StoredValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "c" in value &&
    "v" in value &&
    typeof (value as { c: unknown }).c === "number"
  );
}

/** `ctx.storage.set` takes Effect's `Schema.Json`; capture records are plain JSON. */
function asStorageValue(stored: StoredValue): Parameters<PluginContext["storage"]["set"]>[1] {
  return stored as unknown as Parameters<PluginContext["storage"]["set"]>[1];
}

async function scanNamespace(
  ctx: PluginContext,
  namespace: string,
): Promise<readonly { key: string; value: unknown }[]> {
  const prefix = namespacePrefix(namespace);
  const out: { key: string; value: unknown }[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await ctx.storage.scan({
      prefix,
      limit: SCAN_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    out.push(...page.entries);
    if (!page.next) return out;
    if (page.next === after) return out; // defensive: never spin on a bad cursor
    after = page.next;
  }
}

function keyedStore<T>(ctx: PluginContext, options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> {
  const prefix = namespacePrefix(options.namespace);

  const read = async (key: string): Promise<StoredValue | undefined> => {
    const raw = await ctx.storage.get(prefix + key);
    return isStoredValue(raw) ? raw : undefined;
  };

  return {
    async register(key: string, value: T): Promise<void> {
      await ctx.storage.set(prefix + key, asStorageValue({ c: Date.now(), v: value }));
    },

    async registerIfAbsent(key: string, value: T): Promise<boolean> {
      if ((await ctx.storage.get(prefix + key)) !== undefined) return false;
      await ctx.storage.set(prefix + key, asStorageValue({ c: Date.now(), v: value }));
      return true;
    },

    async lookup(key: string): Promise<T | undefined> {
      const stored = await read(key);
      return stored === undefined ? undefined : (stored.v as T);
    },

    async consume(key: string): Promise<T | undefined> {
      const stored = await read(key);
      if (stored === undefined) return undefined;
      await ctx.storage.remove(prefix + key);
      return stored.v as T;
    },

    async delete(key: string): Promise<boolean> {
      const existed = (await ctx.storage.get(prefix + key)) !== undefined;
      await ctx.storage.remove(prefix + key);
      return existed;
    },

    async entries(): Promise<PluginStateEntry<T>[]> {
      const all = await scanNamespace(ctx, options.namespace);
      const out: PluginStateEntry<T>[] = [];
      for (const entry of all) {
        if (!entry.key.startsWith(prefix) || !isStoredValue(entry.value)) continue;
        out.push({
          key: entry.key.slice(prefix.length),
          value: entry.value.v as T,
          createdAt: entry.value.c,
        });
      }
      return out;
    },

    async clear(): Promise<void> {
      const all = await scanNamespace(ctx, options.namespace);
      for (const entry of all) {
        await ctx.storage.remove(entry.key);
      }
    },
  };
}

/**
 * The opener `configureMemoryCoreDreamingState` expects.
 * Bind it once during `setup`; every landing-zone read/write goes through it.
 */
export function createStorageOpenKeyedStore(ctx: PluginContext): MemoryCoreOpenKeyedStore {
  return <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> =>
    keyedStore<T>(ctx, options);
}
