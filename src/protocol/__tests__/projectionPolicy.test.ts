import { decodeProjectionPolicy } from "../projectionPolicy";

function configData(length: number, current = 0, minimum = 0): Uint8Array {
  const data = new Uint8Array(length);
  if (length >= 113) {
    const view = new DataView(data.buffer);
    view.setUint16(109, current, true);
    view.setUint16(111, minimum, true);
  }
  return data;
}

describe("projection policy decoding", () => {
  test("treats the legacy account layout as version zero", () => {
    expect(decodeProjectionPolicy(configData(109))).toEqual({
      current: 0,
      minimumSupported: 0,
    });
  });

  test("reads the current and minimum versions", () => {
    expect(decodeProjectionPolicy(configData(113, 2, 1))).toEqual({
      current: 2,
      minimumSupported: 1,
    });
  });

  test("rejects truncated, inverted, and unsupported policy", () => {
    expect(() => decodeProjectionPolicy(configData(111))).toThrow(/truncated/i);
    expect(() => decodeProjectionPolicy(configData(113, 0, 1))).toThrow(/invalid/i);
    expect(() => decodeProjectionPolicy(configData(113, 3, 0))).toThrow(/update Entros/i);
  });
});
