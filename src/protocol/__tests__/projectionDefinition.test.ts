import { getProjectionDefinition, HIGHEST_SUPPORTED_PROJECTION_VERSION } from "../../projection";

describe("projection definitions", () => {
  test("binds projection versions to feature schemas and transcripts", () => {
    expect(getProjectionDefinition(0)).toEqual({
      featureSchemaVersion: 3,
      featurePipeline: "legacy",
      hyperplanes: { family: "legacy" },
      authenticatedTransitions: false,
    });
    expect(getProjectionDefinition(1)).toEqual({
      featureSchemaVersion: 4,
      featurePipeline: "corrected",
      hyperplanes: { family: "public", transcriptVersion: 1 },
      authenticatedTransitions: true,
    });
    expect(getProjectionDefinition(2)).toEqual({
      featureSchemaVersion: 5,
      featurePipeline: "normalized-touch",
      hyperplanes: { family: "public", transcriptVersion: 2 },
      authenticatedTransitions: true,
    });
    expect(HIGHEST_SUPPORTED_PROJECTION_VERSION).toBe(2);
  });

  test("rejects non-integral and unknown versions", () => {
    expect(() => getProjectionDefinition(1.5)).toThrow("Unsupported projection version 1.5");
    expect(() => getProjectionDefinition(3)).toThrow("Unsupported projection version 3");
  });
});
