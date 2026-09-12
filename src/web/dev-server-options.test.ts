import { describe, expect, it } from "vitest";
import { resolveDevServerOptions } from "./dev-server-options";

describe("resolveDevServerOptions", () => {
  it("leaves both options unset for ordinary local development", () => {
    expect(resolveDevServerOptions({})).toEqual({});
  });

  it("binds every interface only when VITE_DEV_HOST is set", () => {
    expect(resolveDevServerOptions({ VITE_DEV_HOST: "1" })).toEqual({ host: true });
  });

  it("splits VITE_ALLOWED_HOSTS on commas and trims whitespace", () => {
    expect(
      resolveDevServerOptions({
        VITE_ALLOWED_HOSTS: "homestead-test.hippo-ule.ts.net, other-host ",
      }),
    ).toEqual({ allowedHosts: ["homestead-test.hippo-ule.ts.net", "other-host"] });
  });

  it("treats an empty VITE_ALLOWED_HOSTS as unset rather than an empty allow-list", () => {
    // An empty allowedHosts array is not the same thing to Vite as the key being absent —
    // leaving it unset preserves "not restricted" instead of accidentally becoming
    // "restricted to nothing".
    expect(resolveDevServerOptions({ VITE_ALLOWED_HOSTS: "" })).toEqual({});
  });

  it("ignores a VITE_ALLOWED_HOSTS made up entirely of blanks and commas", () => {
    expect(resolveDevServerOptions({ VITE_ALLOWED_HOSTS: " , , " })).toEqual({});
  });

  it("combines both when the dev deployment sets both", () => {
    expect(
      resolveDevServerOptions({
        VITE_DEV_HOST: "1",
        VITE_ALLOWED_HOSTS: "homestead-test.hippo-ule.ts.net",
      }),
    ).toEqual({ host: true, allowedHosts: ["homestead-test.hippo-ule.ts.net"] });
  });
});
