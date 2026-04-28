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
import * as FileSystem from "expo-file-system";

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
