// Value checks shared by the protocol, paired-session and service modules.

export type JsonRecord = Record<string, unknown>;

/** A JSON object: neither null nor an array. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Byte-for-byte equality. Not constant time, so compare only public values with it. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
