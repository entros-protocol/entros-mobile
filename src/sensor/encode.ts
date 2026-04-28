// Encode Float32 PCM (samples in [-1, 1]) as base64-wrapped Int16 little-endian.
// Verbatim port of pulse-sdk/src/sensor/encode.ts so the bytes-on-wire to
// /validate-features are byte-identical between web and mobile.
//
// See src/sensor/types.ts for the privacy contract covering this path.

export function encodeAudioAsBase64(samples: Float32Array): string {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    const int16 = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    view.setInt16(i * 2, int16, true);
  }
  return bytesToBase64(new Uint8Array(buf));
}

function bytesToBase64(bytes: Uint8Array): string {
  // React Native 0.74+ ships native btoa/atob globals on Hermes (the same
  // Web-compat path src/sensor/audio.ts uses for atob). Chunk to 32KB
  // before fromCharCode to avoid the maximum-call-stack on ~768KB inputs.
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
