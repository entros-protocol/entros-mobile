import { readFileSync } from "fs";
import { join } from "path";

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { PublicKey } from "@solana/web3.js";
import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";

import { getBoundZkeyPath, getZkeyPath } from "../assets";
import type { NativeProofManifest } from "../request";

jest.mock("expo-asset", () => ({ Asset: { fromModule: jest.fn() } }));
jest.mock("../../../assets/circuits/entros_hamming_final.zkey", () => 1);
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///test/documents/",
  EncodingType: { Base64: "base64" },
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
  copyAsync: jest.fn(),
  downloadAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));

const keyBytes = Buffer.from("synthetic public proving artifact");
const manifest: NativeProofManifest = {
  generation: "request-bound-v1",
  deploymentDomain: "11".repeat(32),
  genesisHash: new PublicKey(new Uint8Array(32).fill(2)).toBase58(),
  verifierProgram: new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
  consumerProgram: new PublicKey(new Uint8Array(32).fill(4)).toBase58(),
  zkey: { uri: "file:///test/source.zkey", sha256: bytesToHex(sha256(keyBytes)) },
};
const directory = `file:///test/documents/request-bound-v1-${manifest.zkey.sha256}/`;
const filename = "entros_request_bound_v1_final.zkey";
const remote = {
  ...manifest,
  zkey: { ...manifest.zkey, uri: "https://example.invalid/proof.zkey" },
};

const bundledKey = readFileSync(
  join(__dirname, "../../../assets/circuits/entros_hamming_final.zkey"),
);
const bundledUri = "file:///test/bundle/entros_hamming_final.zkey";
const bundledHash = "d162ea965646e52e636994ef5416cf36b599fc5ad13cd7529d6141f321101769";
const flatKeyUri = "file:///test/documents/entros_hamming_final.zkey";
const hashOf = (uri: string): string | undefined => {
  const bytes = files.get(uri);
  return bytes && bytesToHex(sha256(bytes));
};

let files: Map<string, Buffer>;
let directories: Set<string>;
function writeNew(uri: string, bytes: Buffer): void {
  if (files.has(uri)) throw new Error("Test prevents overwriting an existing artifact");
  files.set(uri, Buffer.from(bytes));
}

describe("native artifact identity", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    files = new Map([[manifest.zkey.uri, keyBytes]]);
    directories = new Set(["file:///test/documents/"]);
    jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => {
      if (files.has(uri) || directories.has(uri)) {
        return {
          exists: true,
          isDirectory: directories.has(uri),
          uri,
          size: files.get(uri)?.length ?? 0,
          modificationTime: 1,
        };
      }
      return { exists: false, isDirectory: false, uri };
    });
    jest.mocked(FileSystem.makeDirectoryAsync).mockImplementation(async (uri, options) => {
      if (directories.has(uri) && !options?.intermediates) throw new Error("Directory exists");
      directories.add(uri);
    });
    jest.mocked(FileSystem.readDirectoryAsync).mockImplementation(async (uri) => {
      if (!directories.has(uri)) throw new Error("Directory missing");
      const descendants = [...directories, ...files.keys()]
        .filter((candidate) => candidate.startsWith(uri) && candidate !== uri)
        .map((candidate) => candidate.slice(uri.length).split("/")[0])
        .filter((name): name is string => name !== undefined && name.length > 0);
      return [...new Set(descendants)];
    });
    jest.mocked(FileSystem.copyAsync).mockImplementation(async ({ from, to }) => {
      const bytes = files.get(from);
      if (!bytes) throw new Error("Missing test source");
      writeNew(to, bytes);
    });
    jest.mocked(FileSystem.downloadAsync).mockImplementation(async (_source, uri) => {
      writeNew(uri, keyBytes);
      return { uri, status: 200, headers: {}, mimeType: "application/octet-stream" };
    });
    jest.mocked(FileSystem.deleteAsync).mockImplementation(async (uri) => {
      files.delete(uri);
      if (!directories.has(uri)) return;
      for (const name of [...files.keys()]) if (name.startsWith(uri)) files.delete(name);
      for (const name of [...directories]) if (name.startsWith(uri)) directories.delete(name);
    });
    jest.mocked(FileSystem.readAsStringAsync).mockImplementation(async (uri) => {
      const bytes = files.get(uri);
      if (!bytes) throw new Error("Missing test artifact");
      return bytes.toString("base64");
    });
    jest
      .mocked(Asset.fromModule)
      .mockImplementation(
        () => ({ localUri: bundledUri, downloadAsync: async () => undefined }) as unknown as Asset,
      );
  });

  describe("bundled proving key", () => {
    beforeEach(() => files.set(bundledUri, bundledKey));

    it("pins the SHA-256 of the bundled key", () => {
      expect(bytesToHex(sha256(bundledKey))).toBe(bundledHash);
    });

    it("stores the key in a directory named by its SHA-256", async () => {
      const result = await getZkeyPath();
      expect(result).toContain(bundledHash);
      expect(result.endsWith("/entros_hamming_final.zkey")).toBe(true);
      expect(hashOf(`file://${result}`)).toBe(bundledHash);
    });

    it("removes the key an earlier build left under the flat name once a verified copy exists", async () => {
      files.set(flatKeyUri, Buffer.from("proving key from an earlier release"));
      const result = await getZkeyPath();
      expect(`file://${result}`).not.toBe(flatKeyUri);
      expect(hashOf(`file://${result}`)).toBe(bundledHash);
      expect(files.has(flatKeyUri)).toBe(false);
    });

    it("removes the flat key when the verified copy was already in place", async () => {
      const first = await getZkeyPath();
      files.set(flatKeyUri, Buffer.from("proving key from an earlier release"));
      expect(await getZkeyPath()).toBe(first);
      expect(files.has(flatKeyUri)).toBe(false);
    });

    it("keeps the verified copy when the flat key cannot be removed", async () => {
      files.set(flatKeyUri, Buffer.from("proving key from an earlier release"));
      jest.mocked(FileSystem.deleteAsync).mockRejectedValue(new Error("read-only"));
      const result = await getZkeyPath();
      expect(hashOf(`file://${result}`)).toBe(bundledHash);
    });

    it("keeps the flat key while no verified copy exists", async () => {
      files.set(flatKeyUri, Buffer.from("proving key from an earlier release"));
      files.set(bundledUri, Buffer.from("not the pinned key"));
      await expect(getZkeyPath()).rejects.toThrow("does not match");
      expect(files.has(flatKeyUri)).toBe(true);
    });

    it("checks the hash before each use", async () => {
      const first = await getZkeyPath();
      files.set(`file://${first}`, Buffer.from("changed on disk"));
      const second = await getZkeyPath();
      expect(second).not.toBe(first);
      expect(hashOf(`file://${second}`)).toBe(bundledHash);
      // The changed copy is deleted with its attempt directory.
      expect(files.has(`file://${first}`)).toBe(false);
      expect(directories.has(`file://${first.slice(0, -"entros_hamming_final.zkey".length)}`)).toBe(
        false,
      );
    });

    it("refuses a bundled asset whose bytes do not match the pinned hash", async () => {
      files.set(bundledUri, Buffer.from("not the pinned key"));
      await expect(getZkeyPath()).rejects.toThrow("does not match");
      // The rejected copy and its attempt directory are gone.
      const hashed = `file:///test/documents/hamming-${bundledHash}/`;
      expect([...files.keys()].filter((uri) => uri.startsWith(hashed))).toEqual([]);
      expect([...directories].filter((uri) => uri.startsWith(`${hashed}attempt-`))).toEqual([]);
    });
  });

  it("uses a hash-specific directory and one load for concurrent requests", async () => {
    const [first, second] = await Promise.all([
      getBoundZkeyPath(manifest),
      getBoundZkeyPath(manifest),
    ]);
    expect(first).toBe(second);
    expect(first).toContain(manifest.zkey.sha256);
    expect(first.endsWith(`/${filename}`)).toBe(true);
    expect(FileSystem.copyAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of 128 requests into one verified artifact load", async () => {
    const results = await Promise.all(Array.from({ length: 128 }, () => getBoundZkeyPath(remote)));
    expect(new Set(results).size).toBe(1);
    expect(FileSystem.downloadAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledTimes(1);
    expect(files.get(`file://${results[0]}`)).toEqual(keyBytes);
  });

  it("deletes a mismatched copy in the hashed directory and materializes a healthy one", async () => {
    directories.add(directory);
    const oldDestination = `${directory}${filename}`;
    files.set(oldDestination, Buffer.from("wrong"));
    const result = await getBoundZkeyPath(manifest);
    expect(result).not.toBe(oldDestination.replace("file://", ""));
    expect(files.has(oldDestination)).toBe(false);
    expect(directories.has(directory)).toBe(true);
    expect(files.get(`file://${result}`)).toEqual(keyBytes);
    expect(FileSystem.copyAsync).toHaveBeenCalledTimes(1);
  });

  it("deletes a mismatched attempt copy with its directory and serves a later valid one", async () => {
    const bad = `${directory}attempt-${"aa".repeat(16)}/`;
    const good = `${directory}attempt-${"bb".repeat(16)}/`;
    directories.add(directory);
    directories.add(bad);
    directories.add(good);
    files.set(`${bad}${filename}`, Buffer.from("wrong"));
    files.set(`${good}${filename}`, keyBytes);
    expect(await getBoundZkeyPath(remote)).toBe(`${good}${filename}`.replace("file://", ""));
    expect(files.has(`${bad}${filename}`)).toBe(false);
    expect(directories.has(bad)).toBe(false);
    expect(files.get(`${good}${filename}`)).toEqual(keyBytes);
    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
  });

  it("deletes an attempt directory that holds no copy", async () => {
    const empty = `${directory}attempt-${"cc".repeat(16)}/`;
    directories.add(directory);
    directories.add(empty);
    const result = await getBoundZkeyPath(remote);
    expect(directories.has(empty)).toBe(false);
    expect(files.get(`file://${result}`)).toEqual(keyBytes);
  });

  it("checks downloaded response status before accepting an artifact", async () => {
    let errorDestination = "";
    jest.mocked(FileSystem.downloadAsync).mockImplementationOnce(async (_source, uri) => {
      errorDestination = uri;
      writeNew(uri, Buffer.from("error response"));
      return { uri, status: 404, headers: {}, mimeType: "application/octet-stream" };
    });
    await expect(getBoundZkeyPath(remote)).rejects.toThrow("download failed");
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
    // The error body and its attempt directory are gone.
    expect(files.has(errorDestination)).toBe(false);
    expect(directories.has(errorDestination.slice(0, -filename.length))).toBe(false);
  });

  it("recovers when a failed download leaves partial bytes at its destination", async () => {
    let partialDestination = "";
    jest.mocked(FileSystem.downloadAsync).mockImplementationOnce(async (_source, uri) => {
      partialDestination = uri;
      writeNew(uri, Buffer.from("partial download"));
      throw new Error("Connection interrupted");
    });
    await expect(getBoundZkeyPath(remote)).rejects.toThrow("Connection interrupted");
    expect(files.has(partialDestination)).toBe(false);
    expect(directories.has(partialDestination.slice(0, -filename.length))).toBe(false);
    const result = await getBoundZkeyPath(remote);
    expect(result).not.toBe(partialDestination.replace("file://", ""));
    expect(files.get(`file://${result}`)).toEqual(keyBytes);
    expect(FileSystem.downloadAsync).toHaveBeenCalledTimes(2);
    // Only the verified copy is hashed on the next load.
    jest.mocked(FileSystem.readAsStringAsync).mockClear();
    expect(await getBoundZkeyPath(remote)).toBe(result);
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledTimes(1);
  });

  it("reports the failed download when its partial bytes cannot be deleted", async () => {
    jest.mocked(FileSystem.downloadAsync).mockImplementationOnce(async (_source, uri) => {
      writeNew(uri, Buffer.from("partial download"));
      throw new Error("Connection interrupted");
    });
    jest.mocked(FileSystem.deleteAsync).mockRejectedValue(new Error("busy"));
    await expect(getBoundZkeyPath(remote)).rejects.toThrow("Connection interrupted");
  });

  it("deletes a download that fails its hash, with its attempt directory, then retries", async () => {
    let rejectedDestination = "";
    jest.mocked(FileSystem.downloadAsync).mockImplementationOnce(async (_source, uri) => {
      rejectedDestination = uri;
      writeNew(uri, Buffer.from("wrong artifact"));
      return { uri, status: 200, headers: {}, mimeType: "application/octet-stream" };
    });
    await expect(getBoundZkeyPath(remote)).rejects.toThrow("does not match");
    expect(files.has(rejectedDestination)).toBe(false);
    expect(directories.has(rejectedDestination.slice(0, -filename.length))).toBe(false);
    const result = await getBoundZkeyPath(manifest);
    expect(files.get(`file://${result}`)).toEqual(keyBytes);
    // Only the verified copy is hashed on the next load.
    jest.mocked(FileSystem.readAsStringAsync).mockClear();
    expect(await getBoundZkeyPath(manifest)).toBe(result);
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledTimes(1);
  });

  it("reports the hash mismatch when the rejected copy cannot be deleted", async () => {
    jest.mocked(FileSystem.downloadAsync).mockImplementationOnce(async (_source, uri) => {
      writeNew(uri, Buffer.from("wrong artifact"));
      return { uri, status: 200, headers: {}, mimeType: "application/octet-stream" };
    });
    jest.mocked(FileSystem.deleteAsync).mockRejectedValue(new Error("busy"));
    await expect(getBoundZkeyPath(remote)).rejects.toThrow("does not match");
  });

  it("discovers a valid persisted attempt without downloading or copying again", async () => {
    const attempt = `${directory}attempt-${"ab".repeat(16)}/`;
    directories.add(directory);
    directories.add(attempt);
    const persisted = `${attempt}${filename}`;
    files.set(persisted, keyBytes);
    expect(await getBoundZkeyPath(remote)).toBe(persisted.replace("file://", ""));
    expect(FileSystem.copyAsync).not.toHaveBeenCalled();
    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
  });

  it("reuses the earlier flat cache when its bytes match", async () => {
    directories.add(directory);
    const persisted = `${directory}${filename}`;
    files.set(persisted, keyBytes);
    expect(await getBoundZkeyPath(remote)).toBe(persisted.replace("file://", ""));
    expect(FileSystem.copyAsync).not.toHaveBeenCalled();
    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
  });
});
