// Materialize the entros_hamming_final.zkey from the bundled assets to a
// file:// path the native mopro module can read.
//
// The .wasm file is a BUILD-TIME input only — `rust_witness::transpile`
// in `entros-mopro/build.rs` transpiles it into Rust source at compile
// time, baking the witness generator into the native .so. At runtime only
// the .zkey is required.
//
// We bundle the .zkey into the JS asset graph (require()'d from
// `assets/circuits/`) and copy it into a document-directory folder named by
// its SHA-256. Every use checks the copy against that hash, so a key from an
// earlier release or a changed file is never handed to the prover.
//
// PRIVACY: the .zkey is a public proving key — contains the trusted-setup
// output, no secrets. Bundling + materializing it carries no privacy risk.

import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { type NativeProofManifest, validateNativeProofManifest } from "./request";

export const ZKEY_FILENAME = "entros_hamming_final.zkey";
/** SHA-256 of the bundled entros_hamming proving key. A new key needs a new value. */
const ZKEY_SHA256 = "d162ea965646e52e636994ef5416cf36b599fc5ad13cd7529d6141f321101769";

/** Returns a raw filesystem path (no `file://` scheme) to a copy of the
 *  bundled entros_hamming proving key whose SHA-256 matches the pinned value.
 *  The native mopro module reads the path via `std::path::Path::new(...)` +
 *  `std::fs::File::open` on the Rust side, which doesn't parse URI schemes,
 *  so callers can pass the result straight to `generateCircomProof`. */
export async function getZkeyPath(): Promise<string> {
  return loadVerifiedArtifact(
    `hamming-${ZKEY_SHA256}`,
    ZKEY_FILENAME,
    ZKEY_SHA256,
    async (destination) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const moduleId = require("../../assets/circuits/entros_hamming_final.zkey");
      const asset = Asset.fromModule(moduleId);
      await asset.downloadAsync();
      if (!asset.localUri) {
        throw new Error("Failed to materialize entros_hamming.zkey asset");
      }
      await FileSystem.copyAsync({ from: asset.localUri, to: destination });
    },
  );
}

const stripFileScheme = (uri: string): string =>
  uri.startsWith("file://") ? uri.slice("file://".length) : uri;

const artifactLoads = new Map<string, Promise<string>>();
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

interface ArtifactDestination {
  attemptDirectory: string;
  path: string;
}

/** Deletes `uri`. A failed delete leaves it for a later load to skip. */
async function deleteQuietly(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Every load checks the hash of what it uses, so a leftover is never served.
  }
}

/** Deletes the flat copy an earlier build kept, when one is present. */
async function removeFlatCopy(uri: string): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || info.isDirectory) return;
  } catch {
    return;
  }
  await deleteQuietly(uri);
}

async function newArtifactDestination(
  directory: string,
  filename: string,
): Promise<ArtifactDestination> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const attemptDirectory = `${directory}attempt-${bytesToHex(randomBytes(16))}/`;
    if ((await FileSystem.getInfoAsync(attemptDirectory)).exists) continue;
    try {
      await FileSystem.makeDirectoryAsync(attemptDirectory, { intermediates: false });
    } catch (error) {
      if ((await FileSystem.getInfoAsync(attemptDirectory)).exists) continue;
      throw error;
    }
    const path = `${attemptDirectory}${filename}`;
    if (!(await FileSystem.getInfoAsync(path)).exists) return { attemptDirectory, path };
  }
  throw new Error("Cannot allocate a new proving artifact destination.");
}

/**
 * Returns a path to a copy of an artifact whose SHA-256 is `fingerprint`,
 * inside a document-directory folder that `directoryName` names. An existing
 * copy is used only after its hash matches. Otherwise `materialize` writes a
 * new copy to a fresh attempt directory, which is checked before use. Any
 * copy whose write fails or that fails the check is deleted with its attempt
 * directory, so later loads do not hash it again. Bytes are never overwritten
 * in place.
 *
 * Earlier builds kept the artifact directly in the document directory under
 * the same filename. Once a verified copy exists, that flat file is deleted.
 */
async function loadVerifiedArtifact(
  directoryName: string,
  filename: string,
  fingerprint: string,
  materialize: (destination: string) => Promise<void>,
): Promise<string> {
  const pending = artifactLoads.get(directoryName);
  if (pending) return pending;
  const load = async (): Promise<string> => {
    if (!FileSystem.documentDirectory) throw new Error("Native artifact storage is unavailable.");
    const directory = `${FileSystem.documentDirectory}${directoryName}/`;
    const info = await FileSystem.getInfoAsync(directory);
    if (info.exists && !info.isDirectory)
      throw new Error("Native artifact storage is not a directory.");
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    }
    const entries = await FileSystem.readDirectoryAsync(directory);
    const candidates: { path: string; attemptDirectory?: string }[] = [
      { path: `${directory}${filename}` },
      ...entries
        .filter((entry) => /^attempt-[0-9a-f]{32}$/.test(entry))
        .sort()
        .map((entry) => ({
          path: `${directory}${entry}/${filename}`,
          attemptDirectory: `${directory}${entry}/`,
        })),
    ];
    const flatCopy = `${FileSystem.documentDirectory}${filename}`;
    for (const candidate of candidates) {
      if (await matchesArtifact(candidate.path, fingerprint)) {
        await removeFlatCopy(flatCopy);
        return stripFileScheme(candidate.path);
      }
      // A copy that fails its hash is never used, so later loads skip hashing it.
      await deleteQuietly(candidate.path);
      if (candidate.attemptDirectory) await deleteQuietly(candidate.attemptDirectory);
    }

    const destination = await newArtifactDestination(directory, filename);
    const discard = async () => {
      await deleteQuietly(destination.path);
      await deleteQuietly(destination.attemptDirectory);
    };
    try {
      await materialize(destination.path);
    } catch (error) {
      await discard();
      throw error;
    }
    if (!(await matchesArtifact(destination.path, fingerprint))) {
      await discard();
      throw new Error("The native proving artifact does not match its expected SHA-256.");
    }
    await removeFlatCopy(flatCopy);
    return stripFileScheme(destination.path);
  };
  const promise = load();
  artifactLoads.set(directoryName, promise);
  try {
    return await promise;
  } finally {
    artifactLoads.delete(directoryName);
  }
}

export async function getBoundZkeyPath(manifest: NativeProofManifest): Promise<string> {
  const checked = validateNativeProofManifest(manifest);
  const fingerprint = checked.zkey.sha256;
  return loadVerifiedArtifact(
    `request-bound-v1-${fingerprint}`,
    boundFilename,
    fingerprint,
    async (destination) => {
      if (checked.zkey.uri.startsWith("file://")) {
        await FileSystem.copyAsync({ from: checked.zkey.uri, to: destination });
      } else {
        const response = await FileSystem.downloadAsync(checked.zkey.uri, destination);
        if (response.status !== 200) throw new Error("The proving artifact download failed.");
      }
    },
  );
}
