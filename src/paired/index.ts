export {
  attestationDigest,
  COORDINATE_MAX,
  encodeCoarsePath,
  PAIRED_PROTOCOL_VERSION,
  PAIRED_ROUNDS,
  PAIRED_SAMPLE_RATE,
  type GridPoint,
} from "./transcript";

export {
  CoarsePathError,
  scorePath,
  toCoarsePath,
  toGridPoint,
  type TraceSample,
  type TraceSurface,
} from "./coarsePath";

export { advanceReached, createRoundTracker, FRAME_SAMPLES, WAYPOINT_REACH } from "./tracker";

export { analysisSignal, encodePcm16, roundWindow, type SampleWindow } from "./segment";

export {
  buildCommitBody,
  buildFinalizeBody,
  checkFinalizeSuccess,
  commitWithRetry,
  computeFinalDigest,
  finalizeRetryAfterMs,
  initialCommitment,
  isTransientStatus,
  PAIRED_PROJECTION_VERSION,
  PairedClientError,
  parseOpenResponse,
  refusalOf,
  retryUntil,
  type FinalizeRefusal,
  type PairedCaptureTiming,
  type PairedCommitResponse,
  type PairedFinalizeBody,
  type PairedHttpResponse,
  type PairedOpenSession,
  type PairedReveal,
  type PairedRoundCommit,
  type RetryClock,
} from "./client";
