type ReplayConfig = {
  enabled: boolean;
  sampleRate: number;
};

type ReplayPayload = {
  project_key: string;
  session_id: string;
  events: unknown[];
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

const REPLAY_FLUSH_INTERVAL_MS = 2000;
const REPLAY_MAX_BUFFER_EVENTS = 5000;
const REPLAY_MAX_DURATION_MS = 10 * 60 * 1000;
const REPLAY_MOUSEMOVE_SAMPLING_MS = 120;

export type ReplayControl = {
  start: () => void;
  stop: () => void;
};

async function postReplay(
  serverUrl: string,
  apiKey: string,
  payload: ReplayPayload,
): Promise<void> {
  const endpoint = `${serverUrl}/replay`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Project-Key": apiKey,
    },
    body: JSON.stringify(payload),
    keepalive: true,
  });

  if (!response.ok) {
    throw new Error(
      `Trackion SDK: replay request failed with status ${response.status}`,
    );
  }
}

export class ReplayRecorder {
  private readonly apiKey: string;
  private readonly serverUrl: string;
  private readonly getSessionId: () => string;
  private readonly config: ReplayConfig;
  private readonly debug: (msg: string, data?: unknown) => void;

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
  private retryCount = 0;
  private lastRetryTime = 0;
  private readonly maxRetries = 5;
  private readonly baseRetryDelayMs = 1000;

  constructor(options: {
    apiKey: string;
    serverUrl: string;
    getSessionId: () => string;
    config: ReplayConfig;
    debug?: (msg: string, data?: unknown) => void;
  }) {
    this.apiKey = options.apiKey;
    this.serverUrl = options.serverUrl;
    this.getSessionId = options.getSessionId;
    this.config = options.config;
    this.debug = options.debug ?? (() => {});
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
    this.debug(`Replay sampled: ${this.sampledIn}`);

    if (!this.sampledIn || this.loading) {
      return;
    }

    this.debug("Starting replay recorder");
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
      return;
    }

    // Check if we should back off from retrying
    const now = Date.now();
    if (
      this.retryCount > 0 &&
      now - this.lastRetryTime < this.getRetryDelayMs()
    ) {
      return;
    }

    this.flushing = true;
    this.lastRetryTime = now;

    const events = this.buffer.splice(0, this.buffer.length);
    const payload: ReplayPayload = {
      project_key: this.apiKey,
      session_id: this.getSessionId(),
      events,
    };

    this.debug(
      `Flushing ${events.length} replay events (retry: ${this.retryCount})`,
    );

    try {
      try {
        await postReplay(this.serverUrl, this.apiKey, payload);
        this.debug("Replay events flushed successfully");
        // Reset retry count on success
        this.retryCount = 0;
      } catch (err) {
        this.retryCount++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.debug(JSON.stringify({ error: err }));
        this.debug(
          `Replay flush failed (attempt ${this.retryCount}/${this.maxRetries}): ${errorMsg}`,
        );

        // If max retries exceeded, clear buffer to prevent infinite loop
        if (this.retryCount > this.maxRetries) {
          this.debug(
            `Max retries (${this.maxRetries}) exceeded, discarding ${events.length} replay events`,
          );
          this.retryCount = 0; // Reset for next batch
          return;
        }

        // Re-queue events for retry
        this.buffer = events.concat(this.buffer);
      }
    } finally {
      this.flushing = false;
      // Don't retry immediately - let the interval handle it
    }
  }

  private getRetryDelayMs(): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    return (
      this.baseRetryDelayMs * Math.pow(2, Math.min(this.retryCount - 1, 4))
    );
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
    this.retryCount = 0; // Reset retry count on new session
    this.lastRetryTime = 0;
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
