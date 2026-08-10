import { CLIENT_PROJECTION_VERSION } from "@/hashing/constants";

export interface ProjectionPolicy {
  current: number;
  minimumSupported: number;
}

const CURRENT_PROJECTION_OFFSET = 109;
const MINIMUM_PROJECTION_OFFSET = 111;
const VERSIONED_CONFIG_SIZE = 113;

export function decodeProjectionPolicy(data: Uint8Array): ProjectionPolicy {
  if (data.length <= CURRENT_PROJECTION_OFFSET) {
    return { current: 0, minimumSupported: 0 };
  }
  if (data.length < VERSIONED_CONFIG_SIZE) {
    throw new Error("The protocol projection policy is truncated.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const current = view.getUint16(CURRENT_PROJECTION_OFFSET, true);
  const minimumSupported = view.getUint16(MINIMUM_PROJECTION_OFFSET, true);
  if (minimumSupported > current) {
    throw new Error("The protocol projection policy is invalid.");
  }
  if (current > CLIENT_PROJECTION_VERSION) {
    throw new Error(
      `This app supports projection versions through ${CLIENT_PROJECTION_VERSION}, but the protocol requires ${current}. Update Entros before verifying.`,
    );
  }
  return { current, minimumSupported };
}
