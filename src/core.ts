import {
  type ErrorContext,
  normalizeError,
  generateFingerprint,
  parseStackTrace,
  shouldIgnoreError,
  ErrorDeduplicator,
} from "./errors";
import { getEventDeviceInfo } from "./device";

export type { ErrorContext };
export { type DeviceInfo, getDeviceInfo } from "./device";

export type TrackionJSON =
  | string
  | number
  | boolean
  | null
  | { [key: string]: TrackionJSON }
  | TrackionJSON[];

export interface RuntimePayload {
  flags: Record<string, boolean>;
  config: Record<string, TrackionJSON>;
}

export interface TrackionPageContext {
  path?: string;
  title?: string;
  referrer?: string;
}

export interface TrackionUTMContext {
  source?: string;
  medium?: string;
  campaign?: string;
}

export interface TrackionTrackContext extends TrackionPageContext {
  sessionId?: string;
  utm?: TrackionUTMContext;
}

export interface TrackionPageOptions extends TrackionPageContext {
  utm?: TrackionUTMContext;
  properties?: Record<string, TrackionJSON>;
}

export interface TrackionReplayOptions {
  enabled?: boolean;
  sampleRate?: number;
}

export interface TrackionClientOptions {
  serverUrl: string;
  apiKey: string;
  autoPageview?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  sessionId?: string;
  userId?: string;
  runtimeTTLms?: number;
  replay?: TrackionReplayOptions;
}

export interface RefreshRuntimeOptions {
  force?: boolean;
}

export type RuntimeListener = (runtime: RuntimePayload) => void;

interface RuntimeStorageRecord {
  ts: number;
  data: RuntimePayload;
}

interface EventPayload {
  project_key: string;
  event: string;
  type?: string;
  session_id: string;
  user_id?: string;
  user_agent: string;
  device?: string;
  platform?: string;
  browser?: string;
  page: {
    title: string;
    path: string;
    referrer: string;
  };
  utm: {
    source: string;
    medium: string;
    campaign: string;
  };
  properties: Record<string, TrackionJSON>;
  timestamp: string;
}

interface ReplayPayload {
  project_key: string;
  session_id: string;
  events: unknown[];
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_RUNTIME_TTL_MS = 60_000;
const DEFAULT_REPLAY_SAMPLE_RATE = 1;
const REPLAY_FLUSH_INTERVAL_MS = 2000;
const REPLAY_MAX_BUFFER_EVENTS = 5000;
const REPLAY_MAX_DURATION_MS = 10 * 60 * 1000;
const REPLAY_MOUSEMOVE_SAMPLING_MS = 120;
const REPLAY_IDLE_START_DELAY_MS = 500;
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_STORAGE_KEY = "trackion.session";

let cachedUTMSearch = "";
let cachedUTM: Required<TrackionUTMContext> = {
  source: "",
  medium: "",
  campaign: "",
};

interface SessionStorageRecord {
  id: string;
  exp: number;
}

const EVENTS = {
  PAGE_VIEW: "page.view",
  PAGE_LEAVE: "page.leave",
  TIME_SPENT: "page.time_spent",
  CLICK: "page.click",
  HEARTBEAT: "session.active",
} as const;

type TrackingConfig = {
  autoPageview: boolean;
  trackTimeSpent: boolean;
  trackClicks: boolean;
};

type ReplayConfig = {
  enabled: boolean;
  sampleRate: number;
};

type ReplayControl = {
  start: () => void;
  stop: () => void;
};

type RRWebEmit = (event: unknown) => void;
type RRWebStopFn = () => void;
type RRWebRecordFn = (options: {
  emit: RRWebEmit;
  maskAllInputs: boolean;
  blockClass: string;
  maskTextClass: string;
  sampling: { mousemove: boolean | number };
}) => RRWebStopFn;

function randomId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeServerUrl(serverUrl: string): string {
  if (!serverUrl || typeof serverUrl !== "string") {
    throw new Error("Trackion SDK: serverUrl is required");
  }

  return serverUrl.replace(/\/+$/, "");
}

function persistSessionId(sessionId: string): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    const payload: SessionStorageRecord = {
      id: sessionId,
      exp: Date.now() + SESSION_TTL_MS,
    };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage write failures.
  }
}

function readSessionRecord(): SessionStorageRecord | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as { id?: string; exp?: number } | null;
    if (
      parsed &&
      typeof parsed.id === "string" &&
      typeof parsed.exp === "number"
    ) {
      return {
        id: parsed.id,
        exp: parsed.exp,
      };
    }
  } catch {
    // Ignore malformed session cache.
  }

  return null;
}

function getOrCreateSessionId(seed?: string): string {
  if (seed && typeof seed === "string") {
    persistSessionId(seed);
    return seed;
  }

  const existing = readSessionRecord();
  if (existing && Date.now() < existing.exp) {
    // Renew TTL for active sessions to avoid unnecessary churn.
    persistSessionId(existing.id);
    return existing.id;
  }

  const id = randomId();
  persistSessionId(id);

  return id;
}

function getCurrentPage(): Required<TrackionPageContext> {
  if (typeof window === "undefined") {
    return { path: "", title: "", referrer: "" };
  }

  return {
    path: window.location?.pathname || "",
    title: typeof document !== "undefined" ? document.title || "" : "",
    referrer: typeof document !== "undefined" ? document.referrer || "" : "",
  };
}

function getCurrentUTM(): Required<TrackionUTMContext> {
  if (typeof window === "undefined") {
    return { source: "", medium: "", campaign: "" };
  }

  const search = window.location?.search || "";
  if (search === cachedUTMSearch) {
    return cachedUTM;
  }

  const params = new URLSearchParams(search);
  cachedUTMSearch = search;
  cachedUTM = {
    source: params.get("utm_source") || "",
    medium: params.get("utm_medium") || "",
    campaign: params.get("utm_campaign") || "",
  };

  return cachedUTM;
}

async function postBatch(
  serverUrl: string,
  apiKey: string,
  events: EventPayload[],
  _useBeacon: boolean,
): Promise<void> {
  const payload = {
    project_key: apiKey,
    events,
  };

  const endpoint = `${serverUrl}/events/batch`;

  const response = await postJSON(endpoint, apiKey, payload);

  if (!response.ok) {
    throw new Error(
      `Trackion SDK: request failed with status ${response.status}`,
    );
  }
}

async function postReplay(
  serverUrl: string,
  apiKey: string,
  payload: ReplayPayload,
): Promise<void> {
  const endpoint = `${serverUrl}/replay`;
  const response = await postJSON(endpoint, apiKey, payload);

  if (!response.ok) {
    throw new Error(
      `Trackion SDK: replay request failed with status ${response.status}`,
    );
  }
}

async function postJSON(
  endpoint: string,
  apiKey: string,
  payload: unknown,
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Project-Key": apiKey,
    },
    body: JSON.stringify(payload),
    keepalive: true,
  });
}

class ReplayRecorder {
  private readonly apiKey: string;
  private readonly serverUrl: string;
  private readonly getSessionId: () => string;
  private readonly config: ReplayConfig;

  private buffer: unknown[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stopRecording: RRWebStopFn | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private started = false;
  private sampledIn = false;
  private loading = false;
  private limitWindowStartedAt = 0;
  private limitReached = false;
  private activeSessionId = "";

  constructor(options: {
    apiKey: string;
    serverUrl: string;
    getSessionId: () => string;
    config: ReplayConfig;
  }) {
    this.apiKey = options.apiKey;
    this.serverUrl = options.serverUrl;
    this.getSessionId = options.getSessionId;
    this.config = options.config;
  }

  start(): void {
    const sessionId = this.getSessionId();
    this._syncSessionState(sessionId);

    if (this.started || !this._canStart() || this.limitReached) {
      return;
    }

    if (!this.sampledIn) {
      this.sampledIn = Math.random() < this.config.sampleRate;
    }

    if (!this.sampledIn || this.loading) {
      return;
    }

    this.loading = true;
    void this._startRecorder().finally(() => {
      this.loading = false;
    });
  }

  stop(): void {
    if (this.stopRecording) {
      this.stopRecording();
      this.stopRecording = null;
    }

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    void this.flush();
    this.started = false;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return Promise.resolve();
    }

    this.flushing = true;

    const events = this.buffer.splice(0, this.buffer.length);
    const payload: ReplayPayload = {
      project_key: this.apiKey,
      session_id: this.getSessionId(),
      events,
    };

    try {
      try {
        return await postReplay(this.serverUrl, this.apiKey, payload);
      } catch {
        // Requeue failed events ahead of newly captured ones.
        this.buffer = events.concat(this.buffer);
      }
    } finally {
      this.flushing = false;
      if (this.started && this.buffer.length > 0) {
        void this.flush();
      }
    }
  }

  private _canStart(): boolean {
    return (
      this.config.enabled &&
      typeof window !== "undefined" &&
      typeof document !== "undefined"
    );
  }

  private async _startRecorder(): Promise<void> {
    const record = await this._loadRecord();
    if (!record || this.stopRecording) {
      return;
    }

    const remainingMs = this._remainingLimitMs();
    if (remainingMs <= 0) {
      this.limitReached = true;
      return;
    }

    this.stopRecording = record({
      emit: (event) => {
        if (this._remainingLimitMs() <= 0) {
          this._stopForLimit();
          return;
        }

        this.buffer.push(event);
        if (this.buffer.length > REPLAY_MAX_BUFFER_EVENTS) {
          this.buffer.splice(0, this.buffer.length - REPLAY_MAX_BUFFER_EVENTS);
        }
      },
      maskAllInputs: true,
      blockClass: "trk-block",
      maskTextClass: "trk-mask",
      sampling: {
        mousemove: REPLAY_MOUSEMOVE_SAMPLING_MS,
      },
    });

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, REPLAY_FLUSH_INTERVAL_MS);

    this.maxDurationTimer = setTimeout(() => {
      this._stopForLimit();
    }, remainingMs);

    this.started = true;
  }

  private _syncSessionState(sessionId: string): void {
    if (this.activeSessionId === sessionId) {
      return;
    }

    this.activeSessionId = sessionId;
    this.sampledIn = false;
    this.limitReached = false;
    this.limitWindowStartedAt = 0;
  }

  private _remainingLimitMs(): number {
    if (!this.limitWindowStartedAt) {
      this.limitWindowStartedAt = Date.now();
    }

    const elapsed = Date.now() - this.limitWindowStartedAt;
    return Math.max(0, REPLAY_MAX_DURATION_MS - elapsed);
  }

  private _stopForLimit(): void {
    if (this.limitReached) {
      return;
    }

    this.limitReached = true;
    this.stop();
  }

  private async _loadRecord(): Promise<RRWebRecordFn | null> {
    try {
      const rrweb = (await import("rrweb")) as {
        record?: RRWebRecordFn;
      };
      return rrweb.record || null;
    } catch {
      return null;
    }
  }
}

export class TrackionClient {
  private readonly apiKey: string;
  private readonly serverUrl: string;
  private readonly autoPageview: boolean;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly runtimeTTLms: number;
  private readonly runtimeStorageKey: string;
  private readonly replayRecorder: ReplayRecorder;
  private readonly deviceInfo = getEventDeviceInfo();
  private readonly userAgent =
    typeof navigator !== "undefined" ? navigator.userAgent : "";
  private replayStartTimer: ReturnType<typeof setTimeout> | null = null;

  private userId: string;
  private queue: EventPayload[] = [];
  private sessionId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private flushing = false;
  private pageStartedAt = Date.now();
  private lastLeaveAt = 0;
  private lastHeartbeatAt = 0;

  public readonly replay: ReplayControl;

  private runtime: RuntimePayload = {
    flags: {},
    config: {},
  };
  private scriptConfig: Partial<{
    auto_pageview: boolean;
    track_time_spent: boolean;
    track_clicks: boolean;
  }> = {};

  private runtimeFetchedAt = 0;
  private runtimeListeners = new Set<RuntimeListener>();

  private errorDeduplicator = new ErrorDeduplicator(5000);
  private originalOnError: OnErrorEventHandler | null = null;
  private originalOnUnhandledRejection:
    | ((event: PromiseRejectionEvent) => void)
    | null = null;

  constructor(options: TrackionClientOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("Trackion SDK: options are required");
    }

    if (!options.apiKey) {
      throw new Error("Trackion SDK: apiKey is required");
    }

    this.apiKey = options.apiKey;
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.autoPageview = options.autoPageview !== false;
    this.batchSize =
      Number.isInteger(options.batchSize) && (options.batchSize ?? 0) > 0
        ? (options.batchSize as number)
        : DEFAULT_BATCH_SIZE;
    this.flushIntervalMs =
      Number.isInteger(options.flushIntervalMs) &&
      (options.flushIntervalMs ?? 0) > 0
        ? (options.flushIntervalMs as number)
        : DEFAULT_FLUSH_INTERVAL_MS;
    this.runtimeTTLms =
      Number.isInteger(options.runtimeTTLms) && (options.runtimeTTLms ?? 0) > 0
        ? (options.runtimeTTLms as number)
        : DEFAULT_RUNTIME_TTL_MS;
    this.userId =
      typeof options.userId === "string" ? options.userId.trim() : "";

    const replayConfig: ReplayConfig = {
      enabled: Boolean(options.replay?.enabled),
      sampleRate:
        typeof options.replay?.sampleRate === "number" &&
        Number.isFinite(options.replay.sampleRate)
          ? Math.max(0, Math.min(1, options.replay.sampleRate))
          : DEFAULT_REPLAY_SAMPLE_RATE,
    };

    this.sessionId = getOrCreateSessionId(options.sessionId);
    this.runtimeStorageKey = this.apiKey
      ? `trackion.runtime.${this.apiKey}`
      : "";

    this.replayRecorder = new ReplayRecorder({
      apiKey: this.apiKey,
      serverUrl: this.serverUrl,
      getSessionId: () => this.sessionId,
      config: replayConfig,
    });
    this.replay = {
      start: () => {
        this.replayRecorder.start();
      },
      stop: () => {
        this.replayRecorder.stop();
      },
    };

    this._hydrateRuntimeFromStorage();
    this._setupErrorHandlers();
  }

  /**
   * Setup automatic error capture hooks
   * @private
   */
  private _setupErrorHandlers(): void {
    if (typeof window === "undefined") return;

    // Hook window.onerror for uncaught errors
    this.originalOnError = window.onerror;
    window.onerror = (message, source, lineno, colno, error) => {
      // Capture the error
      void this.captureError(
        error ||
          ({
            message: String(message),
            filename: source,
            lineno,
            colno,
          } as ErrorEvent),
      );

      // Call original handler if it exists
      if (this.originalOnError) {
        return this.originalOnError(message, source, lineno, colno, error);
      }

      return false;
    };

    // Hook window.onunhandledrejection for unhandled promise rejections
    this.originalOnUnhandledRejection = window.onunhandledrejection;
    window.onunhandledrejection = (event: PromiseRejectionEvent) => {
      // Capture the rejection as an error
      void this.captureError(event.reason);

      // Call original handler if it exists
      if (this.originalOnUnhandledRejection) {
        this.originalOnUnhandledRejection(event);
      }
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.pageStartedAt = Date.now();
    this.timer = setInterval(() => {
      this.flush().catch(() => {
        // Ignore transient network errors; events stay queued for later flush.
      });
    }, this.flushIntervalMs);

    if (typeof window !== "undefined") {
      this.heartbeatTimer = setInterval(() => {
        this._sendHeartbeat();
      }, 30_000);

      window.addEventListener("pagehide", this._onPageHide);
      window.addEventListener("beforeunload", this._onPageHide);
      window.addEventListener("beforeunload", this._onReplayBeforeUnload);
      document.addEventListener("visibilitychange", this._onVisibilityChange);
      document.addEventListener("click", this._onTrackedClick);
    }

    this._scheduleReplayStart();

    if (this._getTrackingConfig().autoPageview) {
      this.page();
    }

    void this.refreshRuntime().catch(() => {
      // Runtime fetch is optional for automatic event flows.
    });
    void this._refreshScriptConfig().catch(() => {
      // Script config endpoint is optional; fallback defaults still apply.
    });
  }

  shutdown(): void {
    if (this.replayStartTimer) {
      clearTimeout(this.replayStartTimer);
      this.replayStartTimer = null;
    }

    this.replayRecorder.stop();

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this._onPageHide);
      window.removeEventListener("beforeunload", this._onPageHide);
      window.removeEventListener("beforeunload", this._onReplayBeforeUnload);
      document.removeEventListener(
        "visibilitychange",
        this._onVisibilityChange,
      );
      document.removeEventListener("click", this._onTrackedClick);

      // Restore original error handlers
      if (this.originalOnError !== null) {
        window.onerror = this.originalOnError;
        this.originalOnError = null;
      }
      if (this.originalOnUnhandledRejection !== null) {
        window.onunhandledrejection = this.originalOnUnhandledRejection;
        this.originalOnUnhandledRejection = null;
      }
    }

    this.started = false;
  }

  setSessionId(sessionId: string): void {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Trackion SDK: sessionId must be a non-empty string");
    }

    const nextSessionId = sessionId.trim();
    if (!nextSessionId) {
      throw new Error("Trackion SDK: sessionId must be a non-empty string");
    }

    this.sessionId = nextSessionId;
    persistSessionId(this.sessionId);
  }

  setUserId(userId: string): void {
    this.userId = typeof userId === "string" ? userId.trim() : "";
  }

  getSessionId(): string {
    return this.sessionId;
  }

  track(
    eventName: string,
    properties: Record<string, TrackionJSON> = {},
    context: TrackionTrackContext = {},
  ): void {
    if (!eventName || typeof eventName !== "string") {
      throw new Error("Trackion SDK: event name must be a non-empty string");
    }

    const page = getCurrentPage();
    const utm = getCurrentUTM();
    const deviceInfo = this.deviceInfo;

    // Merge user properties with device information
    const enrichedProperties = {
      ...deviceInfo,
      tz:
        typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone || ""
          : "",
      ...properties, // User properties take precedence
    };

    this._enqueue({
      project_key: this.apiKey,
      event: eventName,
      session_id: context.sessionId || this.sessionId,
      user_id: this.userId || undefined,
      user_agent: this.userAgent,
      device: String(deviceInfo.device || ""),
      platform: String(deviceInfo.platform || ""),
      browser: String(deviceInfo.browser || ""),
      page: {
        title: context.title || page.title,
        path: context.path || page.path,
        referrer: context.referrer || page.referrer,
      },
      utm: {
        source: context.utm?.source || utm.source,
        medium: context.utm?.medium || utm.medium,
        campaign: context.utm?.campaign || utm.campaign,
      },
      properties: enrichedProperties,
      timestamp: new Date().toISOString(),
    });
  }

  page(data: TrackionPageOptions = {}): void {
    const page = getCurrentPage();
    const utm = getCurrentUTM();
    const deviceInfo = this.deviceInfo;

    // Merge user properties with device information
    const enrichedProperties = {
      ...deviceInfo,
      tz:
        typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone || ""
          : "",
      ...(data.properties || {}), // User properties take precedence
    };

    this._enqueue({
      project_key: this.apiKey,
      event: EVENTS.PAGE_VIEW,
      session_id: this.sessionId,
      user_id: this.userId || undefined,
      user_agent: this.userAgent,
      device: String(deviceInfo.device || ""),
      platform: String(deviceInfo.platform || ""),
      browser: String(deviceInfo.browser || ""),
      page: {
        title: data.title || page.title,
        path: data.path || page.path,
        referrer: data.referrer || page.referrer,
      },
      utm: {
        source: data.utm?.source || utm.source,
        medium: data.utm?.medium || utm.medium,
        campaign: data.utm?.campaign || utm.campaign,
      },
      properties: enrichedProperties,
      timestamp: new Date().toISOString(),
    });
  }

  identify(userId: string, traits: Record<string, TrackionJSON> = {}): void {
    this.track("user.identify", { user_id: userId, traits });
  }

  /**
   * Capture an error for error tracking
   * @param error - Error object, string, or ErrorEvent
   * @param context - Additional context data
   */
  async captureError(
    error: Error | string | ErrorEvent | unknown,
    context: ErrorContext = {},
  ): Promise<void> {
    try {
      // Normalize the error
      const normalized = normalizeError(error);

      // Check if we should ignore this error
      if (shouldIgnoreError(normalized)) {
        return;
      }

      // Generate fingerprint for grouping
      const fingerprint = await generateFingerprint(
        normalized.message,
        normalized.stack,
      );

      // Check if this is a duplicate within the deduplication window
      if (!this.errorDeduplicator.shouldCapture(fingerprint)) {
        return;
      }

      // Parse stack trace for file location
      const location = parseStackTrace(normalized.stack);

      // Get current page URL
      const url =
        typeof window !== "undefined" ? window.location.href : "unknown";

      // Build error metadata
      const errorMetadata: Record<string, TrackionJSON> = {
        error_message: normalized.message,
        stack_trace: normalized.stack,
        fingerprint: fingerprint,
        url: url,
        user_agent:
          typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      };

      // Add line/column numbers if available
      if (normalized.lineno !== undefined || location?.line !== undefined) {
        errorMetadata.line_number = normalized.lineno || location?.line || 0;
      }
      if (normalized.colno !== undefined || location?.column !== undefined) {
        errorMetadata.column_number = normalized.colno || location?.column || 0;
      }

      // Add custom context
      if (Object.keys(context).length > 0) {
        errorMetadata.context = context;
      }

      // Track the error event with type="error"
      const page = getCurrentPage();
      const utm = getCurrentUTM();
      const deviceInfo = this.deviceInfo;

      // Merge device info with error metadata
      const enrichedErrorMetadata = {
        ...deviceInfo,
        ...errorMetadata, // Error metadata takes precedence
      };

      this._enqueue({
        project_key: this.apiKey,
        event: "error",
        type: "error",
        session_id: this.sessionId,
        user_id: this.userId || undefined,
        user_agent: this.userAgent,
        device: String(deviceInfo.device || ""),
        platform: String(deviceInfo.platform || ""),
        browser: String(deviceInfo.browser || ""),
        page: {
          title: page.title,
          path: page.path,
          referrer: page.referrer,
        },
        utm: {
          source: utm.source,
          medium: utm.medium,
          campaign: utm.campaign,
        },
        properties: enrichedErrorMetadata,
        timestamp: new Date().toISOString(),
      });
    } catch (captureError) {
      // Never throw errors from error capture - fail silently
      console.error("[Trackion] Failed to capture error:", captureError);
    }
  }

  async flush({
    useBeacon = false,
  }: { useBeacon?: boolean } = {}): Promise<void> {
    if (this.flushing || this.queue.length === 0) {
      return;
    }

    this.flushing = true;
    const chunk = this.queue.slice(0, this.batchSize);

    try {
      await postBatch(this.serverUrl, this.apiKey, chunk, useBeacon);
      this.queue.splice(0, chunk.length);
    } finally {
      this.flushing = false;
    }
  }

  async refreshRuntime({
    force = false,
  }: RefreshRuntimeOptions = {}): Promise<RuntimePayload> {
    const now = Date.now();
    if (!force && now - this.runtimeFetchedAt < this.runtimeTTLms) {
      return this.runtime;
    }

    const runtimeUrl = new URL(`${this.serverUrl}/v1/runtime`);

    if (this.userId) {
      runtimeUrl.searchParams.set("user_id", this.userId);
    }

    const response = await fetch(runtimeUrl.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Trackion SDK: runtime request failed with status ${response.status}`,
      );
    }

    const payload: { status?: boolean; data?: RuntimePayload } =
      await response.json();
    if (!payload.status) {
      throw new Error("Trackion SDK: runtime response is invalid");
    }

    const data = payload.data || { flags: {}, config: {} };
    this.runtime = {
      flags: data.flags || {},
      config: data.config || {},
    };

    this.runtimeFetchedAt = now;
    this._persistRuntimeToStorage();
    this._emitRuntimeUpdate();

    return this.runtime;
  }

  subscribeRuntime(listener: RuntimeListener): () => void {
    this.runtimeListeners.add(listener);
    return () => {
      this.runtimeListeners.delete(listener);
    };
  }

  isEnabled(flagKey: string): boolean {
    return Boolean(this.runtime.flags?.[flagKey]);
  }

  getConfig<T extends TrackionJSON = TrackionJSON>(
    configKey: string,
    fallback?: T,
  ): T | undefined {
    if (Object.prototype.hasOwnProperty.call(this.runtime.config, configKey)) {
      return this.runtime.config[configKey] as T;
    }

    return fallback;
  }

  getRuntimeSnapshot(): RuntimePayload {
    return {
      flags: { ...this.runtime.flags },
      config: { ...this.runtime.config },
    };
  }

  private _enqueue(event: EventPayload): void {
    this.queue.push(event);

    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  private _onPageHide = (): void => {
    this._trackPageLeave();
    void this.flush({ useBeacon: true });
  };

  private _onVisibilityChange = (): void => {
    if (typeof document === "undefined") {
      return;
    }

    if (document.visibilityState === "hidden") {
      this._trackPageLeave();
      void this.flush({ useBeacon: true });
    }
  };

  private _onReplayBeforeUnload = (): void => {
    this.replayRecorder.stop();
  };

  private _onTrackedClick = (event: MouseEvent): void => {
    const cfg = this._getTrackingConfig();
    if (!cfg.trackClicks) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const el = target.closest("[data-track]") as HTMLElement | null;
    if (!el) {
      return;
    }

    this.track(EVENTS.CLICK, {
      tag: el.tagName,
      id: el.id || null,
      text: (el.textContent || "").slice(0, 50),
    });
  };

  private _scheduleReplayStart(): void {
    if (typeof window === "undefined") {
      this.replayRecorder.start();
      return;
    }

    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      idleWindow.requestIdleCallback(
        () => {
          if (!this.started) {
            return;
          }
          this.replayRecorder.start();
        },
        { timeout: 1000 },
      );
      return;
    }

    this.replayStartTimer = setTimeout(() => {
      this.replayStartTimer = null;
      if (!this.started) {
        return;
      }
      this.replayRecorder.start();
    }, REPLAY_IDLE_START_DELAY_MS);
  }

  private _trackPageLeave(): void {
    const now = Date.now();
    if (now - this.lastLeaveAt < 1000) {
      return;
    }

    const cfg = this._getTrackingConfig();
    if (cfg.trackTimeSpent) {
      this.track(EVENTS.TIME_SPENT, {
        duration_ms: now - this.pageStartedAt,
      });
    }

    this.track(EVENTS.PAGE_LEAVE);

    this.lastLeaveAt = now;
    this.pageStartedAt = now;
  }

  private _sendHeartbeat(): void {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }

    const now = Date.now();
    if (now - this.lastHeartbeatAt < 25_000) {
      return;
    }

    this.lastHeartbeatAt = now;
    this.track(EVENTS.HEARTBEAT);
  }

  private _readBooleanConfig(keys: string[], fallback: boolean): boolean {
    const scriptCfg = this.scriptConfig as Record<string, unknown>;

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(scriptCfg, key)) {
        const value = scriptCfg[key];
        if (typeof value === "boolean") {
          return value;
        }
      }
    }

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(this.runtime.config, key)) {
        const value = this.runtime.config[key];
        if (typeof value === "boolean") {
          return value;
        }
        if (typeof value === "string") {
          const normalized = value.toLowerCase().trim();
          if (normalized === "true") return true;
          if (normalized === "false") return false;
        }
      }
    }

    return fallback;
  }

  private _getTrackingConfig(): TrackingConfig {
    return {
      autoPageview:
        this.autoPageview && this._readBooleanConfig(["auto_pageview"], true),
      trackTimeSpent: this._readBooleanConfig(
        ["track_time_spent", "time_spent"],
        true,
      ),
      trackClicks: this._readBooleanConfig(["track_clicks", "clicks"], false),
    };
  }

  private async _refreshScriptConfig(): Promise<void> {
    const response = await fetch(`${this.serverUrl}/events/config`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Project-Key": this.apiKey,
      },
    });

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as {
      data?: {
        auto_pageview?: boolean;
        track_time_spent?: boolean;
        track_clicks?: boolean;
      };
    };

    if (!payload || !payload.data) {
      return;
    }

    this.scriptConfig = {
      auto_pageview: payload.data.auto_pageview,
      track_time_spent: payload.data.track_time_spent,
      track_clicks: payload.data.track_clicks,
    };
  }

  private _hydrateRuntimeFromStorage(): void {
    if (!this.runtimeStorageKey || typeof localStorage === "undefined") {
      return;
    }

    try {
      const raw = localStorage.getItem(this.runtimeStorageKey);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as RuntimeStorageRecord | null;
      if (!parsed || typeof parsed !== "object") {
        return;
      }

      if (typeof parsed.ts === "number") {
        this.runtimeFetchedAt = parsed.ts;
      }

      if (parsed.data && typeof parsed.data === "object") {
        this.runtime = {
          flags: parsed.data.flags || {},
          config: parsed.data.config || {},
        };
      }
    } catch {
      // Ignore invalid local cache and proceed.
    }
  }

  private _persistRuntimeToStorage(): void {
    if (!this.runtimeStorageKey || typeof localStorage === "undefined") {
      return;
    }

    try {
      const payload: RuntimeStorageRecord = {
        ts: this.runtimeFetchedAt,
        data: this.runtime,
      };
      localStorage.setItem(this.runtimeStorageKey, JSON.stringify(payload));
    } catch {
      // Ignore storage write errors (quota/private mode).
    }
  }

  private _emitRuntimeUpdate(): void {
    const snapshot = this.getRuntimeSnapshot();
    this.runtimeListeners.forEach((listener) => listener(snapshot));
  }
}

export function createTrackionClient(
  options: TrackionClientOptions,
): TrackionClient {
  const client = new TrackionClient(options);
  client.start();
  return client;
}
