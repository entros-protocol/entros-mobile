// Local debug logger for the extraction module. Mirrors `pulse-sdk/src/log.ts`
// but defaults to silent — enable via setExtractionDebug(true) when needed.

let debugEnabled = false;

export function setExtractionDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function sdkLog(...args: unknown[]): void {
  if (debugEnabled) console.warn(...args);
}

export function sdkWarn(...args: unknown[]): void {
  if (debugEnabled) console.warn(...args);
}
