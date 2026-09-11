/**
 * FlowMap WebSocket client — binary transport + connection/session state.
 *
 * Owns one WebSocket to the server's `/ws` endpoint and:
 * - sends the encoded Subscribe on every (re)connect and swaps subscriptions
 *   (Unsubscribe → Subscribe) in place;
 * - decodes each binary frame (proto/decode.decodeFrame) and routes the messages:
 *   Hello / EpochStart / Status feed low-frequency session state via callbacks;
 *   Ping is auto-answered with Pong; DepthColumn / BarColumn / Trade / BBO /
 *   Marker are forwarded to a single high-frequency `onStream` consumer (columns
 *   deduped by (epoch, col_seq)); HistoryResponse resolves the matching
 *   requestHistory() promise;
 * - reconnects on unexpected close with EXPONENTIAL BACKOFF + FULL JITTER
 *   (base 500ms, cap 15s: delay = random() · min(cap, base·2^n)) — the jitter
 *   spreads simultaneous dropouts (sidecar restart, network blip) instead of
 *   synchronizing every client on the same retry tick. The attempt counter
 *   resets once a Hello handshake lands (a completed session attach, not merely
 *   a TCP/WS open); a clean server close (1000/1001) and an abnormal transport
 *   death are both recorded on `lastClose` and both reconnect with backoff.
 *
 * Everything the renderer needs at frame rate (the columns/trades/BBO stream)
 * flows through `onStream`, deliberately NOT through React state, so a live feed
 * never triggers a re-render. Only the low-frequency session metadata is surfaced
 * to the store.
 *
 * The WebSocket factory and the timer functions are injectable so tests can drive
 * a FakeWebSocket and a deterministic clock without real sockets or wall time.
 */

import { decodeFrame } from '../proto/decode';
import { wsUrl } from './serverBase';
import {
  encodeHistoryRequest,
  encodePause,
  encodePong,
  encodeResume,
  encodeSeek,
  encodeSetSpeed,
  encodeSubscribe,
  encodeUnsubscribe,
} from '../proto/encode';
import {
  MsgType,
  type BarColumn,
  type BBO,
  type DepthColumn,
  type EpochParams,
  type EpochStart,
  type Hello,
  type HistoryResponse,
  type Marker,
  type Msg,
  type Ping,
  type Status,
  type StreamMode,
  type Trade,
} from '../proto/types';

/** Connection lifecycle state (distinct from the server's Status.feed_state). */
export type ConnStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed';

/** How a socket closed, as the browser reported it. */
export interface CloseInfo {
  code: number | null;
  wasClean: boolean;
}

/** The high-frequency messages forwarded to the renderer (never React state). */
export type StreamMsg = DepthColumn | BarColumn | Trade | BBO | Marker;

/**
 * Structural subset of the browser WebSocket that the Connection drives. A
 * FakeWebSocket in tests implements exactly this; the real WebSocket satisfies it
 * structurally (via the default factory's cast).
 */
export interface SocketLike {
  binaryType: string;
  send(data: ArrayBufferLike | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

type SetTimeoutFn = (handler: () => void, timeoutMs: number) => unknown;
type ClearTimeoutFn = (handle: unknown) => void;

export interface ConnectionHandlers {
  /** High-frequency stream: deduped columns + trades/BBO/markers. */
  onStream?: (msg: StreamMsg) => void;
  onHello?: (hello: Hello) => void;
  onEpochStart?: (ev: EpochStart) => void;
  onStatus?: (status: Status) => void;
  /** Connection lifecycle transitions. */
  onConnStatus?: (status: ConnStatus) => void;
  /**
   * The socket closed unexpectedly — carries how (close code / clean flag) for
   * the reconnect banner's reason text. Fires on every non-intentional close.
   */
  onCloseInfo?: (info: CloseInfo) => void;
  /**
   * A reconnect backoff tick was scheduled; `attempt` is 1-based. Fired on EVERY
   * schedule (not gated on status change — consecutive reconnects stay
   * 'reconnecting') so the banner's attempt counter never goes stale.
   */
  onReconnectScheduled?: (attempt: number) => void;
  /**
   * The server refused the current subscription with the unsupported close code
   * (1003) — today only mode=replay against a session with no recording (§7:
   * the server refuses honestly instead of steering nothing). The store uses
   * this to surface "replay unavailable" and fall back to live instead of
   * reconnect-looping into the same refusal forever.
   */
  onReplayRefused?: () => void;
  /**
   * The server refused the subscription with a pre-close Status naming
   * feed_state='closed' (server ws.py: NotImplementedError → Status{closed} +
   * 1003): NO feed exists for this market at all. Terminal — the transport does
   * NOT schedule a reconnect (the same subscribe would be refused forever); a
   * NEW subscription from the user is what opens the next socket.
   */
  onNoFeed?: () => void;
}

export interface ConnectionOptions extends ConnectionHandlers {
  /** Endpoint; defaults to `ws(s)://<host>/ws` derived from window.location. */
  url?: string;
  /** WebSocket factory; defaults to `(url) => new WebSocket(url)`. */
  wsFactory?: (url: string) => SocketLike;
  setTimeout?: SetTimeoutFn;
  clearTimeout?: ClearTimeoutFn;
  /** Wall-clock ms source for Pong.client_recv_ns; defaults to Date.now. */
  now?: () => number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /**
   * Uniform random source for FULL-JITTER backoff, `() => number` in [0, 1).
   * The reconnect delay is `jitter() · min(cap, base · 2^attempt)`, so a hundred
   * clients that dropped together retry spread out instead of in a synchronized
   * herd against a restarting sidecar. Injectable so tests pin deterministic
   * delays (`() => 1` reproduces the bare exponential ceiling).
   */
  jitter?: () => number;
  historyTimeoutMs?: number;
}

/**
 * OPTIONAL replay subscribe window (contract P6; server `Subscribe.start_t` /
 * `Subscribe.end_t`). `startNs` is inclusive, `endNs` EXCLUSIVE. Both default to
 * null → the pre-P6 unbounded subscribe (today's behavior, byte-identical on
 * the wire). The window is part of the stream's IDENTITY: changing it detects
 * as a new server session (Unsubscribe → Subscribe, cursors reset), because the
 * server builds a different recording slice whose grid restarts at epoch 0.
 */
export interface SubscribeWindow {
  startNs?: bigint | null;
  endNs?: bigint | null;
}

interface Subscription {
  market: string;
  symbol: string;
  mode: StreamMode;
  /** Server price-grid coverage preset — part of the stream's IDENTITY, since
   *  it changes the grid geometry the columns arrive in. */
  band: string;
  /** Replay window (P6): part of the identity, nullable for "unbounded". */
  startNs: bigint | null;
  endNs: bigint | null;
}

interface HistoryWaiter {
  resolve: (resp: HistoryResponse) => void;
  reject: (err: unknown) => void;
  timer: unknown;
}

function defaultUrl(): string {
  // Absolute `http(s)://…/ws` from the Tauri-injected server origin in the
  // packaged app; same-origin (`window.location`, vite-proxied) in dev.
  return wsUrl();
}

const defaultWsFactory = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;
const defaultSetTimeout: SetTimeoutFn = (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs);
const defaultClearTimeout: ClearTimeoutFn = (handle) =>
  globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);

function sameSub(a: Subscription, b: Subscription): boolean {
  return (
    a.market === b.market &&
    a.symbol === b.symbol &&
    a.mode === b.mode &&
    a.band === b.band &&
    a.startNs === b.startNs &&
    a.endNs === b.endNs
  );
}

export class Connection {
  private readonly url: string;
  private readonly wsFactory: (url: string) => SocketLike;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly now: () => number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly jitterFn: () => number;
  private readonly historyTimeoutMs: number;
  private readonly handlers: ConnectionHandlers;

  private socket: SocketLike | null = null;
  private socketOpen = false;
  private intentionalClose = false;
  private connStatus: ConnStatus = 'idle';

  /** The subscription we want; survives reconnects. */
  private desiredSub: Subscription | null = null;
  /** The subscription actually sent on the current socket; reset per socket. */
  private activeSub: Subscription | null = null;

  private backoffAttempt = 0;
  private reconnectTimer: unknown = null;
  /**
   * feed_state of the last Status frame received on the CURRENT socket. The
   * server's refusal contract (ws.py `_refuse`) sends Status BEFORE closing:
   * 'closed' = no feed for this market (terminal), 'degraded' = no replayable
   * recording (recoverable by re-subscribing live). Reset per socket.
   */
  private lastStatusFeedState: Status['feed_state'] | null = null;
  /**
   * How the LAST socket closed (`null` until one does). `wasClean` distinguishes
   * a server-initiated close frame (1000 normal / 1001 going away — a sidecar
   * shutting down) from an abnormal transport death (no code / 1006-style). Both
   * reconnect with backoff; the flag exists so the stall watchdog / UI can tell
   * "the server said goodbye" from "the wire died" without sniffing events.
   */
  private lastClose: CloseInfo | null = null;

  /** Latest col_seq forwarded per epoch — the (epoch, col_seq) dedup cursor. */
  private readonly lastColSeq = new Map<number, number>();
  private readonly epochMap = new Map<number, EpochParams>();

  private nextReqId = 1;
  private readonly historyWaiters = new Map<number, HistoryWaiter>();

  private sessionId: string | null = null;

  constructor(options: ConnectionOptions = {}) {
    this.url = options.url ?? defaultUrl();
    this.wsFactory = options.wsFactory ?? defaultWsFactory;
    this.setTimeoutFn = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? defaultClearTimeout;
    this.now = options.now ?? (() => Date.now());
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.backoffCapMs = options.backoffCapMs ?? 15_000;
    this.jitterFn = options.jitter ?? (() => Math.random());
    this.historyTimeoutMs = options.historyTimeoutMs ?? 10_000;
    this.handlers = {
      onStream: options.onStream,
      onHello: options.onHello,
      onEpochStart: options.onEpochStart,
      onStatus: options.onStatus,
      onConnStatus: options.onConnStatus,
      onCloseInfo: options.onCloseInfo,
      onReconnectScheduled: options.onReconnectScheduled,
      onReplayRefused: options.onReplayRefused,
      onNoFeed: options.onNoFeed,
    };
  }

  // --- public API --------------------------------------------------------------

  get status(): ConnStatus {
    return this.connStatus;
  }

  get session(): string | null {
    return this.sessionId;
  }

  /** How the last socket closed (see `lastClose`), or null if none has. */
  get closeInfo(): CloseInfo | null {
    return this.lastClose;
  }

  /** 1-based reconnect attempts since the last completed handshake. */
  get attempts(): number {
    return this.backoffAttempt;
  }

  /** Read-only view of the epoch geometry gathered from Hello / EpochStart. */
  get epochs(): ReadonlyMap<number, EpochParams> {
    return this.epochMap;
  }

  /** Open the socket if not already connecting/connected. */
  connect(): void {
    if (this.socket !== null) return;
    this.intentionalClose = false;
    this.openSocket('connecting');
  }

  /**
   * Set the desired subscription. If the socket is open the swap happens now
   * (Unsubscribe → Subscribe when it differs); otherwise it is sent on the next
   * open. Connects automatically when there is no socket yet.
   *
   * `window` (contract P6) narrows a replay subscription to `[startNs, endNs)`;
   * omitted/null keeps the unbounded behavior and the byte-identical wire form.
   */
  subscribe(
    market: string,
    symbol: string,
    mode: StreamMode = 'live',
    band = 'native',
    window?: SubscribeWindow,
  ): void {
    const next: Subscription = {
      market,
      symbol,
      mode,
      band,
      startNs: window?.startNs ?? null,
      endNs: window?.endNs ?? null,
    };
    // A different stream is a different SERVER session, and this is the only
    // place that knows it: reconnects re-enter through sendSubscribe(), where a
    // rewind would be WRONG (same session, and the cursor is exactly what
    // swallows the reconnect snapshot's re-sends). Gated on the identity so an
    // idempotent re-subscribe — which sends nothing — changes nothing either.
    if (this.desiredSub === null || !sameSub(this.desiredSub, next)) {
      this.resetSessionState();
    }
    this.desiredSub = next;
    if (this.socket !== null && this.socketOpen) {
      this.sendSubscribe();
    } else {
      this.connect();
    }
  }

  /**
   * Drop everything scoped to the session we are leaving. The replacement's grid
   * restarts at `epoch = 0` with a low `col_seq` and its attach snapshot arrives
   * `final=true`, so a surviving dedup cursor would discard the new symbol's
   * whole history and leave only the forming right edge on screen; surviving
   * epoch params would let the new grid decode against the old symbol's price
   * frame; and an in-flight history page would splice the OLD symbol's columns
   * into the new symbol's ring.
   */
  private resetSessionState(): void {
    this.lastColSeq.clear();
    this.epochMap.clear();
    this.sessionId = null;
    this.lastStatusFeedState = null; // the refused stream's verdict dies with it
    this.failHistoryWaiters(
      new Error('flowmap: history request abandoned — subscription changed'),
    );
  }

  /** Reject every pending history request (timer cleared) and drop the waiters. */
  private failHistoryWaiters(err: Error): void {
    for (const waiter of this.historyWaiters.values()) {
      this.clearTimeoutFn(waiter.timer);
      waiter.reject(err);
    }
    this.historyWaiters.clear();
  }

  /**
   * Request a page of history. Resolves when the HistoryResponse with the
   * assigned req_id arrives, rejects on timeout (or if not connected).
   */
  requestHistory(before_t: bigint, n: number): Promise<HistoryResponse> {
    return new Promise<HistoryResponse>((resolve, reject) => {
      if (this.socket === null || !this.socketOpen) {
        reject(new Error('flowmap: cannot request history — not connected'));
        return;
      }
      const reqId = this.nextReqId;
      this.nextReqId = this.nextReqId >= 0xffff_ffff ? 1 : this.nextReqId + 1;

      const timer = this.setTimeoutFn(() => {
        this.historyWaiters.delete(reqId);
        reject(new Error(`flowmap: history request ${reqId} timed out`));
      }, this.historyTimeoutMs);
      this.historyWaiters.set(reqId, { resolve, reject, timer });

      try {
        this.rawSend(encodeHistoryRequest({ req_id: reqId, before_t, n_cols: n }));
      } catch (err) {
        this.clearTimeoutFn(timer);
        this.historyWaiters.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // --- replay transport control (§9 / §11) -------------------------------------
  // Cold control messages for a replay session: the server owns the replay clock
  // and honours these live. Each returns whether the frame ACTUALLY went out —
  // a closed socket silently drops the send, and the UI must not claim a state
  // the server never received. No-ops (false) when the socket is not open — the
  // UI guards on mode/status, and a closed socket has nothing to steer.

  /** Seek the replay clock to absolute ns `t` (server bumps epoch + resnapshots). */
  seek(t: bigint): boolean {
    return this.sendControl(encodeSeek(t));
  }

  /** Set the replay playback speed multiplier (1–100×). */
  setSpeed(x: number): boolean {
    return this.sendControl(encodeSetSpeed(x));
  }

  /** Pause the replay clock. */
  pause(): boolean {
    return this.sendControl(encodePause());
  }

  /** Resume the replay clock. */
  resume(): boolean {
    return this.sendControl(encodeResume());
  }

  private sendControl(bytes: Uint8Array): boolean {
    if (this.socket === null || !this.socketOpen) return false;
    try {
      this.rawSend(bytes);
      return true;
    } catch (err) {
      console.warn('[flowmap] failed to send control message', err);
      return false;
    }
  }

  /**
   * Retry NOW (the reconnect banner's button) instead of waiting out the armed
   * backoff tick. openSocket clears any pending timer FIRST, so a click can
   * never double-track with a scheduled tick — exactly one replacement socket.
   */
  reconnectNow(): void {
    if (this.intentionalClose || this.socket !== null) return;
    this.openSocket('reconnecting');
  }

  /** Intentional close: no reconnect; pending history waiters are rejected. */
  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failHistoryWaiters(new Error('flowmap: connection closed'));

    const sock = this.socket;
    this.socket = null;
    this.socketOpen = false;
    this.activeSub = null;
    if (sock !== null) {
      try {
        sock.close();
      } catch {
        /* already closing */
      }
    }
    this.setConnStatus('closed');
  }

  // --- socket lifecycle --------------------------------------------------------

  private openSocket(status: ConnStatus): void {
    // Cancel any pending reconnect timer FIRST: otherwise a manual connect()
    // (e.g. subscribe() with no socket) opens a socket and the armed timer
    // then opens a SECOND one, overwriting this.socket — the orphan keeps its
    // handlers alive, both sockets subscribe, trades/BBO arrive twice, and the
    // orphan's eventual close nulls this.socket out from under the live one.
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setConnStatus(status);
    const sock = this.wsFactory(this.url);
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => this.onSocketOpen();
    sock.onmessage = (ev) => this.onSocketMessage(ev);
    sock.onclose = (ev) =>
      this.onSocketClose(ev as { code?: number } | undefined);
    sock.onerror = () => {
      // WebSocket errors arrive just before close; the close handler drives
      // reconnect. Nothing actionable here beyond a breadcrumb.
      console.warn('[flowmap] websocket error');
    };
    this.socket = sock;
    this.socketOpen = false;
  }

  private onSocketOpen(): void {
    this.socketOpen = true;
    this.activeSub = null; // fresh socket: nothing subscribed yet
    this.lastStatusFeedState = null; // …and no Status has arrived on it yet
    this.sendSubscribe();
  }

  /** Browser close code the server uses for "subscription not supported here". */
  private static readonly CLOSE_UNSUPPORTED = 1003;

  /** Browser close code for "the server said goodbye cleanly". */
  private static readonly CLEAN_CLOSE_CODES = new Set([1000, 1001]);

  private onSocketClose(ev?: { code?: number }): void {
    const code = (ev as { code?: number } | undefined)?.code;
    // A 1003 while a REPLAY subscribe is the active subscription is the server's
    // honest refusal of a replay against a session with no recording. Compute it
    // BEFORE resetting activeSub. It must NOT outrank our own intentional close:
    // when close() already ran, nothing here may fire callbacks or reconnect.
    const refusedReplay =
      this.activeSub?.mode === 'replay' && code === Connection.CLOSE_UNSUPPORTED;
    // The refusal contract (ws.py `_refuse`) sends a Status BEFORE the close
    // frame: feed_state 'closed' = NO FEED EXISTS for this market at all — a
    // terminal refusal no reconnect can cure. 'degraded' (no replay recording)
    // stays the recoverable `refusedReplay` path above.
    const noFeed =
      code === Connection.CLOSE_UNSUPPORTED && this.lastStatusFeedState === 'closed';
    this.lastClose = {
      code: code ?? null,
      wasClean: code !== undefined && Connection.CLEAN_CLOSE_CODES.has(code),
    };
    this.socketOpen = false;
    this.activeSub = null;
    this.socket = null;
    this.lastStatusFeedState = null;
    // The socket is gone either way: fail in-flight history requests NOW rather
    // than letting them coast to their 10 s timeout, so the HistoryLoader's next
    // pan retries on the replacement socket instead of stalling through the
    // whole backoff window.
    this.failHistoryWaiters(new Error('flowmap: history request abandoned — connection lost'));
    if (this.intentionalClose) {
      this.setConnStatus('closed');
      return;
    }
    this.handlers.onCloseInfo?.(this.lastClose);
    if (noFeed) {
      // Terminal: do NOT schedule a reconnect — re-sending the same subscribe
      // would be refused forever. Surface the state; a NEW subscription (the
      // user picking another market) is what may open the next socket.
      this.handlers.onNoFeed?.();
      this.setConnStatus('closed');
      return;
    }
    if (refusedReplay) {
      this.handlers.onReplayRefused?.();
      // STILL schedule the reconnect — the store is expected to have
      // re-subscribed live; the transport must not silently swallow the socket.
      this.scheduleReconnect();
      return;
    }
    // Clean (server shutdown) and abnormal (wire death) closes both reconnect:
    // a sidecar that said goodbye is exactly the one worth waiting for. The
    // distinction rides on `closeInfo` for whoever needs it.
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    // A handler (the store's replay-refusal fallback) may have opened the
    // replacement socket SYNCHRONOUSLY inside onReplayRefused. Scheduling then
    // would arm a ghost tick that later clobbers that live socket with a second
    // one — the orphan-socket double-subscribe openSocket's header warns about.
    if (this.socket !== null) return;
    const exp = Math.min(this.backoffAttempt, 20); // guard 2**n overflow
    // Exponential growth, capped, then FULL JITTER: the delay is a uniform draw
    // from [0, ceiling). Without the draw, every client that dropped together
    // retries on the same tick — a herd against a just-restarting sidecar. The
    // ceiling still grows exponentially so a dead endpoint is polled gently.
    const ceiling = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** exp);
    const delay = Math.round(this.jitterFn() * ceiling);
    // Increment BEFORE the status transition so the handlers observe the 1-based
    // attempt number of the attempt being scheduled (and the dedicated
    // onReconnectScheduled fires even when the status stays 'reconnecting').
    this.backoffAttempt += 1;
    this.setConnStatus('reconnecting');
    this.handlers.onReconnectScheduled?.(this.backoffAttempt);
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;
      this.openSocket('reconnecting');
    }, delay);
  }

  private sendSubscribe(): void {
    const next = this.desiredSub;
    if (next === null) return;
    if (this.activeSub !== null) {
      if (sameSub(this.activeSub, next)) return; // already on this exact stream
      this.rawSend(encodeUnsubscribe());
    }
    this.rawSend(
      encodeSubscribe({
        market: next.market,
        symbol: next.symbol,
        mode: next.mode,
        source: null,
        start_t: next.startNs,
        band: next.band,
        end_t: next.endNs,
      }),
    );
    this.activeSub = next;
  }

  // --- inbound frames ----------------------------------------------------------

  private onSocketMessage(ev: { data: unknown }): void {
    const { data } = ev;
    let frame: ArrayBuffer | Uint8Array;
    if (data instanceof ArrayBuffer) {
      frame = data;
    } else if (ArrayBuffer.isView(data)) {
      frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      // Text/Blob: the protocol is binary; ignore anything else.
      return;
    }

    let msgs: Msg[];
    try {
      msgs = decodeFrame(frame);
    } catch (err) {
      // A malformed frame is dropped — it must never tear down the connection.
      console.warn('[flowmap] dropping malformed frame', err);
      return;
    }
    for (const msg of msgs) {
      this.route(msg);
    }
  }

  private route(msg: Msg): void {
    switch (msg.type) {
      case MsgType.HELLO:
        this.handleHello(msg);
        return;
      case MsgType.EPOCH_START:
        this.epochMap.set(msg.epoch, msg.epoch_params);
        this.handlers.onEpochStart?.(msg);
        return;
      case MsgType.PING:
        this.sendPong(msg);
        return;
      case MsgType.STATUS:
        // Remember the feed_state on THIS socket: the refusal contract sends a
        // Status immediately before closing, and the close handler needs it to
        // tell a terminal no-feed refusal from a recoverable one.
        this.lastStatusFeedState = msg.feed_state;
        this.handlers.onStatus?.(msg);
        return;
      case MsgType.HISTORY_RESP:
        this.resolveHistory(msg);
        return;
      case MsgType.DEPTH_COL:
        // Forming columns (final=false) are re-sent every flush for the live
        // right edge — always forward them. Only a FINALIZED depth column that
        // we've already finalized (a reconnect snapshot re-send) is a true
        // duplicate. The renderer keys tiles by (epoch, col_seq), so any
        // forwarded re-delivery overwrites idempotently.
        if (this.isDuplicateFinalizedDepth(msg)) return;
        this.handlers.onStream?.(msg);
        return;
      case MsgType.BAR_COL:
        // BarColumn has no `final` flag; forming + final + reconnect all resolve
        // idempotently at the renderer (same (epoch, col_seq) series slot), and
        // forming bars carry the live CVD/VWAP edge — forward unconditionally.
        this.handlers.onStream?.(msg);
        return;
      case MsgType.TRADE:
      case MsgType.BBO:
      case MsgType.MARKER:
        this.handlers.onStream?.(msg);
        return;
      default:
        // Pong / Subscribe / control echoes are never sent server→client.
        return;
    }
  }

  private handleHello(hello: Hello): void {
    // A Hello carrying a DIFFERENT session_id than the one we already
    // attached to means the process behind the socket was replaced (sidecar
    // crash + respawn keeps this webview — and this Connection — alive). The
    // replacement session's column sequence restarts at col_seq 0, so a
    // surviving lastColSeq cursor would swallow every finalized column of the
    // new session as a "reconnect re-send" until col_seq crawls past the old
    // cursor — heatmap/DOM dead for minutes (survey-4 H-1). Per-session dedup
    // state dies with the session; the attach snapshot re-asserts an
    // EpochStart for EVERY epoch its columns reference before any column
    // flows (session.py `_snapshot_frames`/`_epoch_start_msgs`), and history
    // responses do the same, so clearing the epoch map here is safe. An
    // in-flight history page belongs to the OLD grid — fail its waiters
    // rather than splice old-session columns into the new session's ring.
    if (this.sessionId !== null && this.sessionId !== hello.session_id) {
      this.lastColSeq.clear();
      this.epochMap.clear();
      this.failHistoryWaiters(
        new Error('flowmap: history request abandoned — server session changed'),
      );
    }
    this.backoffAttempt = 0; // a completed handshake resets the backoff
    this.sessionId = hello.session_id;
    this.epochMap.set(hello.epoch_params.epoch, hello.epoch_params);
    this.setConnStatus('live');
    this.handlers.onHello?.(hello);
  }

  private isDuplicateFinalizedDepth(msg: DepthColumn): boolean {
    if (!msg.final) return false; // forming edge — never a duplicate
    const last = this.lastColSeq.get(msg.epoch);
    if (last !== undefined && msg.col_seq <= last) return true; // reconnect re-send
    this.lastColSeq.set(msg.epoch, msg.col_seq);
    return false;
  }

  private sendPong(ping: Ping): void {
    const clientRecvNs = BigInt(this.now()) * 1_000_000n;
    try {
      this.rawSend(encodePong(ping.server_send_ns, clientRecvNs));
    } catch (err) {
      console.warn('[flowmap] failed to send Pong', err);
    }
  }

  private resolveHistory(resp: HistoryResponse): void {
    const waiter = this.historyWaiters.get(resp.req_id);
    if (waiter === undefined) return; // unmatched / late response
    this.clearTimeoutFn(waiter.timer);
    this.historyWaiters.delete(resp.req_id);
    waiter.resolve(resp);
  }

  // --- helpers -----------------------------------------------------------------

  private rawSend(bytes: Uint8Array): void {
    if (this.socket === null) {
      throw new Error('flowmap: send with no socket');
    }
    this.socket.send(bytes);
  }

  private setConnStatus(status: ConnStatus): void {
    if (this.connStatus === status) return;
    this.connStatus = status;
    this.handlers.onConnStatus?.(status);
  }
}
