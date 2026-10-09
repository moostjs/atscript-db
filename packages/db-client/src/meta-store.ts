/** Options for {@link MetaStore}. */
export interface MetaStoreOptions {
  /**
   * How many `/meta` bodies the store keeps (least recently used are dropped
   * first). Default `50`.
   */
  maxEntries?: number;
  /**
   * After a conditional `/meta` request fails at the transport level (e.g. a
   * CORS preflight refusing `If-None-Match`) while the plain retry succeeds,
   * how long (ms) that store key is loaded without `If-None-Match` before a
   * conditional request is tried again. Default `300000` (5 minutes).
   */
  unconditionalMs?: number;
}

/** ETags remembered per store key (most recent first). */
const CANDIDATES_PER_KEY = 4;

interface KeyEntry {
  /** ETags seen for this key, most recent first. */
  etags: string[];
  /**
   * Until when (epoch ms) this key is loaded without `If-None-Match`: a
   * conditional request for it failed at the transport level (e.g. a CORS
   * preflight refusing `If-None-Match`).
   */
  unconditionalUntil?: number;
}

/**
 * Content-addressed cache of `GET /meta` responses, keyed by the server's
 * `ETag`, used by {@link Client.meta} to revalidate instead of downloading.
 *
 * For each store key (the meta URL, or `ClientOptions.metaKey`) the store
 * remembers the ETags it has seen. `meta()` sends them as `If-None-Match`;
 * when the server answers `304 Not Modified` the client reuses the body
 * stored under the returned `ETag`. Several keys that serve the same bytes
 * — e.g. one parametric controller mounted at `/api/tenant/:id/todos` —
 * therefore share one stored body, and the first visit to a new key costs a
 * `304` instead of the full `/meta`.
 *
 * It is a pure cache: the server decides on every request whether the body
 * is still valid. Failures are never stored.
 *
 * @since 0.1.153
 */
export class MetaStore {
  private readonly _maxEntries: number;
  private readonly _unconditionalMs: number;
  /** Raw JSON body by opaque ETag (`W/` stripped — `If-None-Match` compares weakly). */
  private readonly _bodies = new Map<string, string>();
  private readonly _keys = new Map<string, KeyEntry>();

  constructor(options?: MetaStoreOptions) {
    this._maxEntries = Math.max(1, options?.maxEntries ?? 50);
    this._unconditionalMs = Math.max(0, options?.unconditionalMs ?? 300_000);
  }

  /** Number of stored `/meta` bodies. */
  get size(): number {
    return this._bodies.size;
  }

  /**
   * The ETags this store would send as `If-None-Match` for `key` — those seen
   * for it whose body is still stored, most recent first.
   */
  candidates(key: string): string[] {
    const entry = this._keys.get(key);
    if (!entry) return [];
    return entry.etags.filter((etag) => this._bodies.has(opaque(etag)));
  }

  /** Drops every stored body and remembered ETag. */
  clear(): void {
    this._bodies.clear();
    this._keys.clear();
  }

  /**
   * Stored body for `etag` (weak comparison), marking it — and `etag` as the
   * latest candidate for `key` — as recently used.
   *
   * @internal used by `Client`
   */
  _reuse(key: string, etag: string): string | undefined {
    const id = opaque(etag);
    const text = this._bodies.get(id);
    if (text === undefined) return undefined;
    this._bodies.delete(id);
    this._bodies.set(id, text);
    this._remember(key, etag);
    return text;
  }

  /**
   * Stores a `200` body under its ETag and remembers the ETag for `key`.
   *
   * @internal used by `Client`
   */
  _put(key: string, etag: string, text: string): void {
    const id = opaque(etag);
    this._bodies.delete(id);
    this._bodies.set(id, text);
    while (this._bodies.size > this._maxEntries) {
      this._bodies.delete(this._bodies.keys().next().value!);
    }
    this._remember(key, etag);
  }

  /**
   * Whether `key` is in its no-`If-None-Match` window; an expired window is
   * cleared, so the next request is conditional again.
   *
   * @internal used by `Client`
   */
  _isUnconditional(key: string): boolean {
    const entry = this._keys.get(key);
    const until = entry?.unconditionalUntil;
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    delete entry!.unconditionalUntil;
    return false;
  }

  /** @internal used by `Client` */
  _markUnconditional(key: string): void {
    this._touchKey(key).unconditionalUntil = Date.now() + this._unconditionalMs;
  }

  private _remember(key: string, etag: string): void {
    const entry = this._touchKey(key);
    const id = opaque(etag);
    entry.etags = [etag, ...entry.etags.filter((e) => opaque(e) !== id)].slice(
      0,
      CANDIDATES_PER_KEY,
    );
  }

  /** The entry for `key`, created if needed and moved to most recently used. */
  private _touchKey(key: string): KeyEntry {
    const entry = this._keys.get(key) ?? { etags: [] };
    this._keys.delete(key);
    this._keys.set(key, entry);
    // Keys are cheap (a few short strings) but still bounded.
    while (this._keys.size > this._maxEntries * 4) {
      this._keys.delete(this._keys.keys().next().value!);
    }
    return entry;
  }
}

function opaque(etag: string): string {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

/**
 * The store every {@link Client} uses unless `ClientOptions.metaStore` says
 * otherwise, so all clients in a page share revalidated `/meta` bodies.
 */
export const defaultMetaStore = new MetaStore();

/**
 * Clears the shared default {@link MetaStore}. Call it on sign-out or any
 * identity change (together with `Client.invalidateMeta()` on live clients).
 *
 * @since 0.1.153
 */
export function clearMetaStore(): void {
  defaultMetaStore.clear();
}
