import { redirectSystemPath } from "../../../app/+native-intent";

describe("external links", () => {
  const LINKS = [
    "entros://verify/failure?bucket=report-bug&message=Send%20your%20seed%20phrase",
    "io.entros.mobile://verify/processing",
    "entros:///(app)/settings",
    "/verify/failure?bucket=baseline-missing",
    "entros://",
  ];

  test.each(LINKS)("start the app at the home route, never the linked screen: %s", (path) => {
    expect(redirectSystemPath({ path, initial: true })).toBe("/");
  });

  test.each(LINKS)("leave a running app on its current screen: %s", (path) => {
    expect(redirectSystemPath({ path, initial: false })).toBeNull();
  });
});
