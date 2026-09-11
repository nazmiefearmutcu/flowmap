/**
 * Client-local price alerts (campaign 3, lane CD).
 *
 * A plain module-scoped store OUTSIDE React (the bookStore pattern): the chart
 * overlays subscribe for repaints, an evaluation tick feeds it the last traded /
 * mid price at ~10 Hz (bookStore's throttled flush cadence — never per WS
 * message), and mutations persist straight to localStorage so a user's alerts
 * survive reloads, keyed PER SYMBOL (`market:symbol`). Everything is bounded:
 *   - at most {@link MAX_ALERTS_PER_SYMBOL} alerts per symbol (adding to a full
 *     symbol evicts its OLDEST alert — the ring discipline, not a silent refuse),
 *   - at most {@link LOG_CAP} entries in the triggered log (oldest dropped).
 *
 * Trigger semantics: an alert is `above` (fires when price >= alert price) or
 * `below` (fires when price <= alert price), decided at creation from the live
 * reference price. Firing is edge-triggered with HYSTERESIS: a fired alert
 * records `rearmPx = level ∓ band` and stays `triggered` (no re-fire while price
 * sits beyond it) until price returns PAST that band — then the latch clears and
 * the NEXT crossing fires. `snoozeAlert` is an explicit user mute for
 * {@link SNOOZE_MS}; `rearmAlert` is the explicit re-arm. The automatic path is
 * the band, never a timer.
 *
 * Toast delivery goes through the `window.__flowmapToast?.(msg)` hook ONLY —
 * the Toaster component (another lane) binds to that global; this module never
 * imports UI. Absent hook = silently no toast (the marker + log still fire).
 */

/** One user price alert. */
export interface PriceAlert {
  id: string;
  /** Subscription key, `market:symbol` — the persistence + evaluation scope. */
  key: string;
  /** The alert level. */
  price: number;
  /** true → fires when the price RISES to `price`; false → falls to it. */
  above: boolean;
  /** Creation time, ms epoch (Date.now()). */
  createdAt: number;
  /** Edge-trigger latch: set on the first crossing, cleared by snooze/delete. */
  triggered: boolean;
  /** When it last fired, ms epoch — null while it has never fired. */
  triggeredAt: number | null;
  /** While set (ms epoch), the alert is muted and will not evaluate. */
  snoozedUntil: number | null;
  /**
   * Hysteresis re-arm level, set at fire time to `level ∓ band` (band =
   * {@link REARM_BAND_FRAC} of the level, floored at {@link REARM_BAND_EPS}).
   * While price stays beyond it the alert cannot fire again; once price returns
   * past it, `triggered` clears and the NEXT crossing fires. null while armed.
   */
  rearmPx: number | null;
}

/** One entry in the triggered log (bounded ring, newest LAST). */
export interface AlertLogEntry {
  id: string;
  key: string;
  alertId: string;
  /** The alert level that was crossed. */
  price: number;
  /** The market price that crossed it. */
  crossedAt: number;
  /** Trigger time, ms epoch. */
  at: number;
  /**
   * The alert's direction at fire time (true = fires on a rise). Optional for
   * hand-built fixtures; live entries always carry it so an exact-touch fire
   * is labeled by its own direction instead of price comparison (R2-L4).
   */
  above?: boolean;
}

/** Immutable whole-store view the overlays read. */
export interface AlertsSnapshot {
  version: number;
  /** Per-symbol alert lists (each already sorted oldest → newest). */
  byKey: ReadonlyMap<string, readonly PriceAlert[]>;
  /** Triggered log, newest LAST, capped at {@link LOG_CAP}. */
  log: readonly AlertLogEntry[];
}

/** Max alerts retained per symbol (contract: "max 50 alerts per symbol"). */
export const MAX_ALERTS_PER_SYMBOL = 50;
/** Triggered-log ring capacity. */
export const LOG_CAP = 200;
/** A snoozed alert stays muted this long, then re-arms. */
export const SNOOZE_MS = 60_000;
/** Hysteresis re-arm band as a fraction of the alert level (0.1%). */
export const REARM_BAND_FRAC = 0.001;
/** Smallest re-arm band, so a near-zero level still gets a usable band. */
export const REARM_BAND_EPS = 1e-9;

/**
 * The re-arm level for an alert that just fired: `level ∓ band`, i.e. BELOW the
 * level for an `above` alert and ABOVE it for a `below` alert. Price must return
 * past this line before the alert can fire a second time.
 */
export function rearmPriceFor(level: number, above: boolean): number {
  const band = Math.max(Math.abs(level) * REARM_BAND_FRAC, REARM_BAND_EPS);
  return above ? level - band : level + band;
}

/** localStorage key prefix; the subscription key is appended (`…:<market>:<symbol>`). */
export const STORAGE_PREFIX = 'flowmap.alerts.v1:';

let byKey = new Map<string, PriceAlert[]>();
let log: AlertLogEntry[] = [];
let version = 0;
let idCounter = 0;
let cachedSnapshot: AlertsSnapshot | null = null;

let storage: StorageLike | null | undefined;
const listeners = new Set<() => void>();

/** Minimal Web-Storage subset (mirrors ui/settings.ts StorageLike). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** The default storage (browser localStorage), resolved lazily + guarded. */
function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* localStorage denied (privacy mode) — alerts simply stay session-local */
  }
  return null;
}

function getStorage(): StorageLike | null {
  if (storage === undefined) storage = defaultStorage();
  return storage;
}

/**
 * Enumerate every key in a Storage-shaped backend. `localStorage` exposes
 * `length` + `key(i)`; the test doubles add a `keys()` enumerator. Browsers and
 * doubles both go through the same best-effort guard.
 */
function storageKeys(s: StorageLike): string[] {
  const sweep = s as StorageLike & {
    keys?: () => string[];
    length?: number;
    key?: (i: number) => string | null;
  };
  try {
    if (typeof sweep.keys === 'function') return sweep.keys();
    if (typeof sweep.length === 'number' && typeof sweep.key === 'function') {
      const out: string[] = [];
      for (let i = 0; i < sweep.length; i += 1) {
        const k = sweep.key(i);
        if (typeof k === 'string') out.push(k);
      }
      return out;
    }
  } catch {
    /* enumeration denied — callers degrade to the in-memory set */
  }
  return [];
}

/** Test seam: inject a storage double (or null to disable persistence). */
export function setAlertsStorage(s: StorageLike | null): void {
  storage = s;
}

function nextId(): string {
  idCounter += 1;
  return `al-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function persistKey(key: string): void {
  const s = getStorage();
  if (!s) return;
  try {
    const list = byKey.get(key);
    if (!list || list.length === 0) {
      s.removeItem?.(STORAGE_PREFIX + key);
    } else {
      s.setItem(STORAGE_PREFIX + key, JSON.stringify({ v: 1, alerts: list }));
    }
  } catch {
    /* quota / serialization failure — best-effort, alerts stay in memory */
  }
}

/** Coerce an arbitrary parsed blob into a valid alert list (total, never throws). */
function normalizeAlerts(key: string, raw: unknown): PriceAlert[] {
  if (!Array.isArray(raw)) return [];
  const out: PriceAlert[] = [];
  for (const o of raw.slice(0, MAX_ALERTS_PER_SYMBOL)) {
    const a = (o ?? {}) as Partial<PriceAlert> & Record<string, unknown>;
    const price = typeof a.price === 'number' ? a.price : Number(a.price);
    if (!Number.isFinite(price)) continue;
    const above = a.above !== false;
    const triggered = a.triggered === true;
    const rearmRaw = typeof a.rearmPx === 'number' ? a.rearmPx : Number(a.rearmPx);
    // Legacy payloads (pre-hysteresis) carry a latched `triggered` with no band:
    // adopt the unified re-arm by deriving the band from the level, so an old
    // alert cannot stay stuck beyond its level forever.
    const rearmPx = Number.isFinite(rearmRaw)
      ? rearmRaw
      : triggered
        ? rearmPriceFor(price, above)
        : null;
    out.push({
      id: typeof a.id === 'string' && a.id ? a.id : nextId(),
      key,
      price,
      above,
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
      triggered,
      triggeredAt: typeof a.triggeredAt === 'number' ? a.triggeredAt : null,
      snoozedUntil: typeof a.snoozedUntil === 'number' ? a.snoozedUntil : null,
      rearmPx,
    });
  }
  return out;
}

function loadKey(key: string): PriceAlert[] {
  const existing = byKey.get(key);
  if (existing) return existing;
  let list: PriceAlert[] = [];
  const s = getStorage();
  if (s) {
    try {
      const text = s.getItem(STORAGE_PREFIX + key);
      if (text) list = normalizeAlerts(key, JSON.parse(text).alerts);
    } catch {
      list = [];
    }
  }
  byKey.set(key, list);
  return list;
}

function bump(): void {
  version += 1;
  cachedSnapshot = null;
  for (const cb of listeners) cb();
}

// --- reads -----------------------------------------------------------------------

/** Alerts for one symbol (loads + normalizes from storage on first touch). */
export function alertsFor(key: string): readonly PriceAlert[] {
  return loadKey(key);
}

/**
 * The whole immutable snapshot. Cached between mutations (same object identity)
 * so React `useSyncExternalStore` can diff it — a fresh object per call would
 * re-render subscribers on every poll.
 */
export function getAlertsSnapshot(): AlertsSnapshot {
  if (cachedSnapshot === null) cachedSnapshot = { version, byKey, log };
  return cachedSnapshot;
}

/** Register a change listener; returns an unsubscribe fn. */
export function subscribeAlerts(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Every alert key known in memory OR persisted under {@link STORAGE_PREFIX}
 * (persisted lists are loaded into memory as a side effect). The alert monitor
 * uses this to find symbols it must poll for; the order is stable but
 * unspecified. Empty-list keys are included — callers filter by `alertsFor`.
 */
export function allAlertKeys(): string[] {
  const keys = new Set<string>(byKey.keys());
  const s = getStorage();
  if (s) {
    for (const k of storageKeys(s)) {
      if (k.startsWith(STORAGE_PREFIX) && k.length > STORAGE_PREFIX.length) {
        const key = k.slice(STORAGE_PREFIX.length);
        keys.add(key);
        loadKey(key); // materialize so the monitor + popover see the alerts
      }
    }
  }
  return [...keys];
}

// --- mutations -------------------------------------------------------------------

/**
 * Create an alert at `price` for `key`. `refPx` (the live reference price, e.g.
 * the current mid) decides the direction: an alert ABOVE the reference fires on
 * the way up, one BELOW on the way down. Returns the created alert, or null for
 * a non-finite price. Adding to a FULL symbol (≥ {@link MAX_ALERTS_PER_SYMBOL})
 * evicts that symbol's oldest alert to make room — bounded growth, never a
 * silent refusal.
 */
export function addAlert(key: string, price: number, refPx?: number, now = Date.now()): PriceAlert | null {
  if (!Number.isFinite(price)) return null;
  const list = loadKey(key);
  while (list.length >= MAX_ALERTS_PER_SYMBOL) {
    list.shift(); // oldest first (lists are append-ordered by creation)
  }
  const above =
    typeof refPx === 'number' && Number.isFinite(refPx) ? price >= refPx : true;
  const alert: PriceAlert = {
    id: nextId(),
    key,
    price,
    above,
    createdAt: now,
    triggered: false,
    triggeredAt: null,
    snoozedUntil: null,
    rearmPx: null,
  };
  list.push(alert);
  persistKey(key);
  bump();
  return alert;
}

/** Delete one alert by id. True when it existed. */
export function removeAlert(id: string): boolean {
  for (const [key, list] of byKey) {
    const idx = list.findIndex((a) => a.id === id);
    if (idx >= 0) {
      list.splice(idx, 1);
      if (list.length === 0) byKey.delete(key);
      persistKey(key);
      bump();
      return true;
    }
  }
  return false;
}

/**
 * Snooze: mute the alert for {@link SNOOZE_MS}, after which it evaluates again.
 * This is the explicit user mute and does NOT touch the fired latch/re-arm band
 * — automatic re-arming is the hysteresis band's job (see {@link evaluateAlerts}).
 */
export function snoozeAlert(id: string, now = Date.now()): boolean {
  for (const [key, list] of byKey) {
    const a = list.find((x) => x.id === id);
    if (a) {
      a.snoozedUntil = now + SNOOZE_MS;
      persistKey(key);
      bump();
      return true;
    }
  }
  return false;
}

/**
 * Manual re-arm: clears the mute and, for a FIRED alert, the latch while keeping
 * its hysteresis band — so it still only fires again after price returns past
 * the band (no whipsaw re-fire). Re-arming an alert that is already past its
 * band/armed simply drops the mute. Returns true when the alert existed.
 */
export function rearmAlert(id: string): boolean {
  for (const [key, list] of byKey) {
    const a = list.find((x) => x.id === id);
    if (!a) continue;
    a.snoozedUntil = null;
    if (a.triggered) {
      a.triggered = false;
      if (a.rearmPx === null) a.rearmPx = rearmPriceFor(a.price, a.above);
    }
    persistKey(key);
    bump();
    return true;
  }
  return false;
}

/** Delete every alert for one symbol. */
export function clearAlerts(key: string): void {
  if (!byKey.has(key)) loadKey(key);
  byKey.set(key, []);
  persistKey(key);
  bump();
}

/**
 * Evaluate the alerts of `key` against the latest market price (last trade,
 * else BBO mid — the caller's choice). Fires every alert whose threshold the
 * price has crossed and that is not already triggered or snoozed; appends one
 * log entry per firing (oldest dropped past {@link LOG_CAP}) and notifies the
 * toast hook.
 *
 * Hysteresis: an alert that carries a `rearmPx` never fires — instead the call
 * checks whether price has returned PAST that band, and if so clears the latch
 * (and the band) so the NEXT crossing fires. The clearing itself counts as a
 * change (persisted + listeners notified) but never fires in the same tick.
 *
 * No-op (zero churn, no listener notify) when nothing fires and nothing re-arms,
 * or the price is unusable. Safe to call at the bookStore flush cadence.
 */
export function evaluateAlerts(
  key: string,
  px: number,
  now = Date.now(),
  toast: ((msg: string) => void) | null = defaultToast,
): AlertLogEntry[] {
  if (!Number.isFinite(px)) return [];
  const list = loadKey(key);
  if (list.length === 0) return [];
  const fired: AlertLogEntry[] = [];
  let changed = false;
  for (const a of list) {
    // Pending return-past-band (fired, or manually re-armed while fired): this
    // alert may only FIRE after the band clears, never in the same tick.
    if (a.rearmPx !== null) {
      const returned = a.above ? px <= a.rearmPx : px >= a.rearmPx;
      if (returned) {
        a.triggered = false;
        a.rearmPx = null;
        changed = true;
      }
      continue;
    }
    if (a.triggered) continue; // legacy latch without a band — explicit re-arm only
    if (a.snoozedUntil !== null && now < a.snoozedUntil) continue;
    const hit = a.above ? px >= a.price : px <= a.price;
    if (!hit) continue;
    a.triggered = true;
    a.triggeredAt = now;
    a.rearmPx = rearmPriceFor(a.price, a.above);
    changed = true;
    fired.push({
      id: nextId(),
      key,
      alertId: a.id,
      price: a.price,
      crossedAt: px,
      at: now,
      above: a.above,
    });
  }
  if (!changed) return [];
  if (fired.length > 0) log = log.concat(fired).slice(-LOG_CAP);
  // Persist the new latch / re-armed state: the stored schema carries both, and
  // a reload must not re-fire (toast + log + pulse) an alert whose level the
  // price is still beyond — the store header promises edge-trigger semantics.
  persistKey(key);
  if (toast !== null) {
    for (const e of fired) {
      try {
        toast(alertToastMessage(e));
      } catch {
        /* a broken toast hook must never break the evaluation tick */
      }
    }
  }
  bump();
  return fired;
}

/** Human toast line for a fired alert, e.g. `Alert BTCUSDT · crossed above 60,000 (now 60,012.5)`. */
export function alertToastMessage(e: AlertLogEntry): string {
  const fmt = (n: number): string =>
    n.toLocaleString('en-US', { maximumFractionDigits: 8 });
  // The log entry owns the full `market:symbol` key; the toast must NAME the
  // symbol or a walk-away user cannot tell which chart cried (survey 3 #1).
  // Direction: prefer the entry's own flag (exact-touch fires are unambiguous);
  // hand-built/legacy fixtures without it fall back to the price comparison.
  const colon = e.key.indexOf(':');
  const symbol = colon >= 0 ? e.key.slice(colon + 1) : e.key;
  const above = e.above ?? e.price < e.crossedAt;
  return `Alert ${symbol} · crossed ${above ? 'above' : 'below'} ${fmt(e.price)} (now ${fmt(e.crossedAt)})`;
}

/** The toast hook: `window.__flowmapToast?.(msg)` — bound by the shell lane. */
function defaultToast(msg: string): void {
  if (typeof window === 'undefined') return;
  const hook = (window as unknown as { __flowmapToast?: (msg: string) => void })
    .__flowmapToast;
  hook?.(msg);
}

// --- test seams ------------------------------------------------------------------

/** Reset all in-memory state (NOT localStorage contents). Unit tests only. */
export function resetAlertsForTest(): void {
  byKey = new Map();
  log = [];
  version = 0;
  idCounter = 0;
  cachedSnapshot = null;
  listeners.clear();
}

/** Drop all persisted alerts from storage (test cleanup). */
export function clearPersistedForTest(): void {
  const s = getStorage();
  if (!s) return;
  try {
    for (const k of storageKeys(s)) {
      if (k.startsWith(STORAGE_PREFIX)) s.removeItem?.(k);
    }
  } catch {
    /* best-effort */
  }
}
