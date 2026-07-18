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
 * - reconnects on unexpected close with exponential backoff (base 500ms, cap 10s),
 *   resetting the backoff once a Hello handshake lands.
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
  historyTimeoutMs?: number;
}

interface Subscription {
  market: string;
  symbol: string;
  mode: StreamMode;
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
  return a.market === b.market && a.symbol === b.symbol && a.mode === b.mode;
}

export class Connection {
  private readonly url: string;
  private readonly wsFactory: (url: string) => SocketLike;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly now: () => number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
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
    this.backoffCapMs = options.backoffCapMs ?? 10_000;
    this.historyTimeoutMs = options.historyTimeoutMs ?? 10_000;
    this.handlers = {
      onStream: options.onStream,
      onHello: options.onHello,
      onEpochStart: options.onEpochStart,
      onStatus: options.onStatus,
      onConnStatus: options.onConnStatus,
    };
  }

  // --- public API --------------------------------------------------------------

  get status(): ConnStatus {
    return this.connStatus;
  }

  get session(): string | null {
    return this.sessionId;
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
   */
  subscribe(market: string, symbol: string, mode: StreamMode = 'live'): void {
    this.desiredSub = { market, symbol, mode };
    if (this.socket !== null && this.socketOpen) {
      this.sendSubscribe();
    } else {
      this.connect();
    }
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
  // and honours these live. No-ops (dropped) when the socket is not open — the UI
  // guards on mode/status, and a closed socket has nothing to steer.

  /** Seek the replay clock to absolute ns `t` (server bumps epoch + resnapshots). */
  seek(t: bigint): void {
    this.sendControl(encodeSeek(t));
  }

  /** Set the replay playback speed multiplier (1–100×). */
  setSpeed(x: number): void {
    this.sendControl(encodeSetSpeed(x));
  }

  /** Pause the replay clock. */
  pause(): void {
    this.sendControl(encodePause());
  }

  /** Resume the replay clock. */
  resume(): void {
    this.sendControl(encodeResume());
  }

  private sendControl(bytes: Uint8Array): void {
    if (this.socket === null || !this.socketOpen) return;
    try {
      this.rawSend(bytes);
    } catch (err) {
      console.warn('[flowmap] failed to send control message', err);
    }
  }

  /** Intentional close: no reconnect; pending history waiters are rejected. */
  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const waiter of this.historyWaiters.values()) {
      this.clearTimeoutFn(waiter.timer);
      waiter.reject(new Error('flowmap: connection closed'));
    }
    this.historyWaiters.clear();

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
    this.setConnStatus(status);
    const sock = this.wsFactory(this.url);
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => this.onSocketOpen();
    sock.onmessage = (ev) => this.onSocketMessage(ev);
    sock.onclose = () => this.onSocketClose();
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
    this.sendSubscribe();
  }

  private onSocketClose(): void {
    this.socketOpen = false;
    this.activeSub = null;
    this.socket = null;
    if (this.intentionalClose) {
      this.setConnStatus('closed');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setConnStatus('reconnecting');
    const exp = Math.min(this.backoffAttempt, 20); // guard 2**n overflow
    const delay = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** exp);
    this.backoffAttempt += 1;
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
      encodeSubscribe({ market: next.market, symbol: next.symbol, mode: next.mode, source: null, start_t: null }),
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
