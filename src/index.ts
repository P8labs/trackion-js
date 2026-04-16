import {
  createTrackionClient,
  TrackionClient,
  type TrackionClientOptions,
  type TrackionJSON,
  type TrackionTrackContext,
  type TrackionPageOptions,
  type RuntimePayload,
  type RuntimeListener,
  type RefreshRuntimeOptions,
  type TrackionReplayOptions,
  type DeviceInfo,
  getDeviceInfo,
} from "./core";

export {
  createTrackionClient,
  TrackionClient,
  type TrackionClientOptions,
  type TrackionJSON,
  type TrackionTrackContext,
  type TrackionPageOptions,
  type RuntimePayload,
  type RuntimeListener,
  type RefreshRuntimeOptions,
  type TrackionReplayOptions,
  type DeviceInfo,
  getDeviceInfo,
};

export interface TrackionInitOptions extends Omit<
  TrackionClientOptions,
  "apiKey" | "serverUrl"
> {
  projectId: string;
  endpoint: string;
  replay?: TrackionReplayOptions;
}

let singletonClient: TrackionClient | null = null;

function ensureClient(): TrackionClient {
  if (!singletonClient) {
    throw new Error("Trackion SDK: call trackion.init(...) before use");
  }
  return singletonClient;
}

export const trackion = {
  init(options: TrackionInitOptions): TrackionClient {
    if (singletonClient) {
      singletonClient.shutdown();
    }

    singletonClient = createTrackionClient({
      ...options,
      apiKey: options.projectId,
      serverUrl: options.endpoint,
    });

    return singletonClient;
  },
  get replay() {
    const client = ensureClient();
    return client.replay;
  },
};

export {
  type ErrorContext,
  type NormalizedError,
  generateFingerprint,
  normalizeError,
  parseStackTrace,
  shouldIgnoreError,
  ErrorDeduplicator,
} from "./errors";

export { getEventDeviceInfo } from "./device";
