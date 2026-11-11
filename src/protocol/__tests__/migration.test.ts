import { type AccountInfo, type Connection, PublicKey, SystemProgram } from "@solana/web3.js";

import { findMigrationPda } from "../pdas";
import { fetchMigrationRecord } from "../migration";

const mockAnchorProgram = new PublicKey(new Uint8Array(32).fill(5));

jest.mock("@/config", () => ({
  config: {
    programs: {
      get entrosAnchor() {
        return mockAnchorProgram;
      },
    },
  },
}));
jest.mock("@/lib/log", () => ({ devWarn: jest.fn() }));

const wallet = new PublicKey(new Uint8Array(32).fill(9));
const previousWallet = new PublicKey(new Uint8Array(32).fill(3));
const DISCRIMINATOR = [16, 36, 116, 243, 192, 61, 40, 1];

function recordData(): Buffer {
  const data = Buffer.alloc(57);
  Buffer.from(DISCRIMINATOR).copy(data, 0);
  data.writeBigInt64LE(BigInt(1_800_000_000), 8);
  data.writeBigUInt64LE(BigInt(412_345_678), 16);
  data.writeUInt8(254, 24);
  previousWallet.toBuffer().copy(data, 25);
  return data;
}

const account = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({
  owner,
  data,
  lamports: 1_287_600,
  executable: false,
  rentEpoch: 0,
});

function connectionReturning(value: AccountInfo<Buffer> | null): Connection {
  return { getAccountInfo: jest.fn(async () => value) } as unknown as Connection;
}

describe("migration record read", () => {
  test("reads the previous wallet from a record the Anchor program owns", async () => {
    const connection = connectionReturning(account(mockAnchorProgram, recordData()));
    await expect(fetchMigrationRecord(wallet, connection, true)).resolves.toEqual({
      migratedAt: 1_800_000_000,
      migratedSlot: BigInt(412_345_678),
      previousWallet: previousWallet.toBase58(),
    });
    expect(jest.mocked(connection.getAccountInfo).mock.calls[0]![0]).toEqual(
      findMigrationPda(wallet, mockAnchorProgram),
    );
  });

  test("names the PDA from the migration seed and the new wallet", () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("migration"), wallet.toBuffer()],
      mockAnchorProgram,
    );
    expect(findMigrationPda(wallet, mockAnchorProgram)).toEqual(expected);
  });

  test("treats an absent account as no record", async () => {
    await expect(fetchMigrationRecord(wallet, connectionReturning(null), true)).resolves.toBeNull();
  });

  test.each([
    ["another program owns it", account(new PublicKey(new Uint8Array(32).fill(6)), recordData())],
    ["it holds lamports alone", account(SystemProgram.programId, Buffer.alloc(0))],
    ["its data is short", account(mockAnchorProgram, recordData().subarray(0, 56))],
    [
      "its discriminator is another account's",
      account(mockAnchorProgram, Buffer.concat([Buffer.alloc(8, 1), recordData().subarray(8)])),
    ],
  ])("treats a record as absent when %s", async (_name, value) => {
    await expect(
      fetchMigrationRecord(wallet, connectionReturning(value), true),
    ).resolves.toBeNull();
  });

  test("throws a failed read only when asked to fail closed", async () => {
    const failing = {
      getAccountInfo: jest.fn(async () => {
        throw new Error("rpc down");
      }),
    } as unknown as Connection;
    await expect(fetchMigrationRecord(wallet, failing, true)).rejects.toThrow("rpc down");
    await expect(fetchMigrationRecord(wallet, failing)).resolves.toBeNull();
  });
});
