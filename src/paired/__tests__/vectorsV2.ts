import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RoundEntryVector, SessionVector } from "./vectors";
export { bytes } from "./vectors";
export interface CueRoundVector extends RoundEntryVector {
  cuePoint: [number, number];
  cueSaltHex: string;
  cueCommitmentHex: string;
  completeTargetHex: string;
  completeWaypoints: [number, number][];
}
interface CueSessionVector extends Omit<SessionVector, "roundEntries"> {
  roundEntries: CueRoundVector[];
}
export const vectorsV2 = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/paired-round-v2-vectors.json"), "utf8"),
) as { sessions: CueSessionVector[]; attestationDigestHex: string };
export const traceSessionV2 = (): CueSessionVector => vectorsV2.sessions[0]!;
