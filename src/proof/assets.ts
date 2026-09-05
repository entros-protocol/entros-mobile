// Materialize the entros_hamming_final.zkey from the bundled assets to a
// file:// path the native mopro module can read.
//
// The .wasm file is a BUILD-TIME input only — `rust_witness::transpile`
// in `entros-mopro/build.rs` transpiles it into Rust source at compile
// time, baking the witness generator into the native .so. At runtime only
// the .zkey is required.
//
// We bundle the .zkey into the JS asset graph (require()'d from
// `assets/circuits/`) and materialize to expo-file-system's document
// directory on first use. The materialized path is cached in-process so
// subsequent verify cycles in the same session skip the I/O.
//
// PRIVACY: the .zkey is a public proving key — contains the trusted-setup
// output, no secrets. Bundling + materializing it carries no privacy risk.

import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { type NativeProofManifest, validateNativeProofManifest } from "./request";

export const ZKEY_FILENAME = "entros_hamming_final.zkey";

let cachedZkeyPath: string | null = null;

/** Returns a raw filesystem path (no `file://` scheme) to a materialized
 *  copy of entros_hamming.zkey, copying from the bundled JS asset on first
 *  call. Cached in-process. The native mopro module reads the path via
 *  `std::path::Path::new(...)` + `std::fs::File::open` on the Rust side,
 *  which doesn't parse URI schemes — we strip `file://` here so callers
 *  can pass the result straight to `generateCircomProof`. */
export async function getZkeyPath(): Promise<string> {
  if (cachedZkeyPath) return cachedZkeyPath;

  const documentDir = FileSystem.documentDirectory;
  if (!documentDir) {
    throw new Error("expo-file-system documentDirectory unavailable on this platform");
  }
  const destUri = `${documentDir}${ZKEY_FILENAME}`;

  const info = await FileSystem.getInfoAsync(destUri);
  if (!info.exists) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const moduleId = require("../../assets/circuits/entros_hamming_final.zkey");
    const asset = Asset.fromModule(moduleId);
    await asset.downloadAsync();
    if (!asset.localUri) {
      throw new Error("Failed to materialize entros_hamming.zkey asset");
    }
    await FileSystem.copyAsync({ from: asset.localUri, to: destUri });
  }

  cachedZkeyPath = stripFileScheme(destUri);
  return cachedZkeyPath;
}

const stripFileScheme = (uri: string): string =>
  uri.startsWith("file://") ? uri.slice("file://".length) : uri;

/** Drop the cached zkey path. Useful if the document directory was wiped
 *  out-of-band (rare; only really happens with `expo-dev-client` reset). */
export function resetZkeyPathCache(): void {
  cachedZkeyPath = null;
}

const boundLoads = new Map<string, Promise<string>>();
const boundFilename = "entros_request_bound_v1_final.zkey";

async function matchesArtifact(uri: string, fingerprint: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory) return false;
  try {
    const content = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return bytesToHex(sha256(new Uint8Array(Buffer.from(content, "base64")))) === fingerprint;
  } catch {
    return false;
  }
}

async function newArtifactDestination(directory: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const attemptDirectory = `${directory}attempt-${bytesToHex(randomBytes(16))}/`;
    if ((await FileSystem.getInfoAsync(attemptDirectory)).exists) continue;
    try {
      await FileSystem.makeDirectoryAsync(attemptDirectory, { intermediates: false });
    } catch (error) {
      if ((await FileSystem.getInfoAsync(attemptDirectory)).exists) continue;
      throw error;
    }
    const destination = `${attemptDirectory}${boundFilename}`;
    if (!(await FileSystem.getInfoAsync(destination)).exists) return destination;
  }
  throw new Error("Cannot allocate a new proving artifact destination.");
}

export async function getBoundZkeyPath(manifest: NativeProofManifest): Promise<string> {
  const checked = validateNativeProofManifest(manifest);
  const fingerprint = checked.zkey.sha256;
  const pending = boundLoads.get(fingerprint);
  if (pending) return pending;
  const load = async (): Promise<string> => {
    if (!FileSystem.documentDirectory) throw new Error("Native artifact storage is unavailable.");
    const directory = `${FileSystem.documentDirectory}request-bound-v1-${fingerprint}/`;
    const info = await FileSystem.getInfoAsync(directory);
    if (info.exists && !info.isDirectory)
      throw new Error("Native artifact storage is not a directory.");
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    }
    const entries = await FileSystem.readDirectoryAsync(directory);
    const candidates = [
      `${directory}${boundFilename}`,
      ...entries
        .filter((entry) => /^attempt-[0-9a-f]{32}$/.test(entry))
        .sort()
        .map((entry) => `${directory}${entry}/${boundFilename}`),
    ];
    for (const candidate of candidates) {
      if (await matchesArtifact(candidate, fingerprint)) return stripFileScheme(candidate);
    }

    const destination = await newArtifactDestination(directory);
    if (checked.zkey.uri.startsWith("file://")) {
      await FileSystem.copyAsync({ from: checked.zkey.uri, to: destination });
    } else {
      const response = await FileSystem.downloadAsync(checked.zkey.uri, destination);
      if (response.status !== 200) throw new Error("The proving artifact download failed.");
    }
    if (!(await matchesArtifact(destination, fingerprint))) {
      throw new Error("The native proving artifact does not match its manifest.");
    }
    return stripFileScheme(destination);
  };
  const promise = load();
  boundLoads.set(fingerprint, promise);
  try {
    return await promise;
  } finally {
    boundLoads.delete(fingerprint);
  }
}
