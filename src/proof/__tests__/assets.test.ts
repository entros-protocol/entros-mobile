import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { PublicKey } from "@solana/web3.js";
import * as FileSystem from "expo-file-system/legacy";

import { getBoundZkeyPath } from "../assets";
import type { NativeProofManifest } from "../request";

jest.mock("expo-asset", () => ({ Asset: {} }));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///test/documents/",
  EncodingType: { Base64: "base64" },
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
  copyAsync: jest.fn(),
  downloadAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
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
    jest.mocked(FileSystem.readAsStringAsync).mockImplementation(async (uri) => {
      const bytes = files.get(uri);
      if (!bytes) throw new Error("Missing test artifact");
      return bytes.toString("base64");
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

  it("preserves mismatched existing bytes and materializes a healthy source elsewhere", async () => {
    directories.add(directory);
    const oldDestination = `${directory}${filename}`;
    files.set(oldDestination, Buffer.from("wrong"));
    const result = await getBoundZkeyPath(manifest);
    expect(result).not.toBe(oldDestination.replace("file://", ""));
    expect(files.get(oldDestination)).toEqual(Buffer.from("wrong"));
    expect(files.get(`file://${result}`)).toEqual(keyBytes);
    expect(FileSystem.copyAsync).toHaveBeenCalledTimes(1);
  });

  it("checks downloaded response status before accepting an artifact", async () => {
    jest.mocked(FileSystem.downloadAsync).mockImplementationOnce(async (_source, uri) => {
      writeNew(uri, Buffer.from("error response"));
      return { uri, status: 404, headers: {}, mimeType: "application/octet-stream" };
    });
    await expect(getBoundZkeyPath(remote)).rejects.toThrow("download failed");
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it("recovers when a failed download leaves partial bytes at its destination", async () => {
    let partialDestination = "";
    jest.mocked(FileSystem.downloadAsync).mockImplementationOnce(async (_source, uri) => {
      partialDestination = uri;
      writeNew(uri, Buffer.from("partial download"));
      throw new Error("Connection interrupted");
    });
    await expect(getBoundZkeyPath(remote)).rejects.toThrow("Connection interrupted");
    const result = await getBoundZkeyPath(remote);
    expect(result).not.toBe(partialDestination.replace("file://", ""));
    expect(files.get(partialDestination)).toEqual(Buffer.from("partial download"));
    expect(files.get(`file://${result}`)).toEqual(keyBytes);
    expect(FileSystem.downloadAsync).toHaveBeenCalledTimes(2);
  });

  it("retries a hash mismatch without replacing the rejected download", async () => {
    let rejectedDestination = "";
    jest.mocked(FileSystem.downloadAsync).mockImplementationOnce(async (_source, uri) => {
      rejectedDestination = uri;
      writeNew(uri, Buffer.from("wrong artifact"));
      return { uri, status: 200, headers: {}, mimeType: "application/octet-stream" };
    });
    await expect(getBoundZkeyPath(remote)).rejects.toThrow("does not match");
    const result = await getBoundZkeyPath(manifest);
    expect(files.get(rejectedDestination)).toEqual(Buffer.from("wrong artifact"));
    expect(files.get(`file://${result}`)).toEqual(keyBytes);
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
