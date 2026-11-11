import { type AccountInfo, type Connection, PublicKey, SystemProgram } from "@solana/web3.js";

import { fetchIdentityState } from "../identity";

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
jest.mock("@noble/ciphers/utils.js", () => ({
  bytesToHex: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex"),
}));

const wallet = new PublicKey(new Uint8Array(32).fill(9));
const IDENTITY_SIZE = 585;

function identityData(): Buffer {
  const data = Buffer.alloc(IDENTITY_SIZE);
  wallet.toBuffer().copy(data, 8);
  data.writeUInt32LE(3, 56);
  data.writeUInt16LE(2, 583);
  return data;
}

function connectionReturning(account: AccountInfo<Buffer> | null): Connection {
  return { getAccountInfo: jest.fn(async () => account) } as unknown as Connection;
}

const account = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({
  owner,
  data,
  lamports: 890_880,
  executable: false,
  rentEpoch: 0,
});

describe("identity account read", () => {
  test("decodes an identity account the Anchor program owns", async () => {
    const identity = await fetchIdentityState(
      wallet,
      connectionReturning(account(mockAnchorProgram, identityData())),
      true,
    );
    expect(identity).toMatchObject({
      owner: wallet.toBase58(),
      verificationCount: 3,
      projectionVersion: 2,
    });
  });

  test.each([true, false])(
    "treats lamports sent to an unminted identity address as no identity (fail closed: %s)",
    async (failClosed) => {
      await expect(
        fetchIdentityState(
          wallet,
          connectionReturning(account(SystemProgram.programId, Buffer.alloc(0))),
          failClosed,
        ),
      ).resolves.toBeNull();
    },
  );

  test("refuses identity-shaped data that another program owns", async () => {
    const foreign = account(new PublicKey(new Uint8Array(32).fill(6)), identityData());
    await expect(fetchIdentityState(wallet, connectionReturning(foreign), true)).rejects.toThrow(
      "not owned by the Entros Anchor program",
    );
    await expect(fetchIdentityState(wallet, connectionReturning(foreign))).resolves.toBeNull();
  });

  test("refuses a System-owned account that holds data", async () => {
    const allocated = account(SystemProgram.programId, identityData());
    await expect(fetchIdentityState(wallet, connectionReturning(allocated), true)).rejects.toThrow(
      "not owned by the Entros Anchor program",
    );
  });
});
