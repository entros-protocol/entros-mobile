import { simhash } from "@/hashing/simhash";

import { extractMotionFeatures, extractMouseDynamics, extractTouchFeatures } from "../kinematic";
import { extractSpeakerFeatures } from "../speaker";
import { fuseFeatures } from "../statistics";
import type { AudioCapture, MotionSample, TouchSample } from "../types";

const FEATURE_EXTRACTION_TIMEOUT_MS = 30_000;

function deterministicMotion(): MotionSample[] {
  return Array.from({ length: 129 }, (_, index) => ({
    timestamp: index * 16.75,
    ax: (((index * 17) % 31) - 15) / 32,
    ay: (((index * 19) % 37) - 18) / 32,
    az: 1 + (((index * 23) % 29) - 14) / 64,
    gx: (((index * 7) % 23) - 11) / 16,
    gy: (((index * 11) % 27) - 13) / 16,
    gz: (((index * 13) % 33) - 16) / 16,
  }));
}

function deterministicTouch(): TouchSample[] {
  return Array.from({ length: 129 }, (_, index) => ({
    timestamp: index * 15.25,
    x: (index * 37) % 401,
    y: (index * 53) % 307,
    pressure: (((index * 7) % 19) + 1) / 20,
    width: 8 + (index % 7),
    height: 9 + (index % 5),
  }));
}

function deterministicAudio(): AudioCapture {
  return {
    samples: Float32Array.from(
      { length: 16_000 },
      (_, index) => (((index * 17) % 257) - 128) / 256,
    ),
    sampleRate: 16_000,
    duration: 1,
    windowStartMs: 0,
    windowEndMs: 1_000,
  };
}

describe("projection version 0 compatibility", () => {
  it(
    "keeps the default path identical to explicit version 0",
    async () => {
      const motionDefault = extractMotionFeatures(deterministicMotion());
      const motionVersioned = extractMotionFeatures(deterministicMotion(), 0);
      const touchDefault = extractTouchFeatures(deterministicTouch());
      const touchVersioned = extractTouchFeatures(deterministicTouch(), 0);
      const mouseDefault = extractMouseDynamics(deterministicTouch());
      const mouseVersioned = extractMouseDynamics(deterministicTouch(), 0);
      const speakerDefault = await extractSpeakerFeatures(deterministicAudio());
      const speakerVersioned = await extractSpeakerFeatures(deterministicAudio(), 0);

      expect(motionDefault).toEqual(motionVersioned);
      expect(touchDefault).toEqual(touchVersioned);
      expect(mouseDefault).toEqual(mouseVersioned);
      expect(speakerDefault).toEqual(speakerVersioned);

      const defaultFused = fuseFeatures(speakerDefault, motionDefault, touchDefault);
      const versionedFused = fuseFeatures(speakerVersioned, motionVersioned, touchVersioned);
      expect(defaultFused).toEqual(versionedFused);
      expect(simhash(defaultFused)).toEqual(simhash(versionedFused, 0));
    },
    FEATURE_EXTRACTION_TIMEOUT_MS,
  );

  it(
    "keeps projection 2 audio semantics equal to corrected projection 1",
    async () => {
      const audio = deterministicAudio();
      const corrected = await extractSpeakerFeatures(audio, 1);
      expect(corrected).not.toEqual(await extractSpeakerFeatures(audio, 0));
      expect(await extractSpeakerFeatures(audio, 2)).toEqual(corrected);
    },
    FEATURE_EXTRACTION_TIMEOUT_MS,
  );
});
