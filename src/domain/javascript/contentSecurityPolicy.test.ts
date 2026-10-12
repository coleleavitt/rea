import { describe, expect, it } from "vitest";

import { parseContentSecurityPolicy } from "./contentSecurityPolicy.js";

describe("Content-Security-Policy parsing", () => {
  it("rejects text whose directive names are not CSP directives", () => {
    expect(
      parseContentSecurityPolicy("color: red; margin-src 0", false),
    ).toBeUndefined();
    expect(parseContentSecurityPolicy("img-src 'self'", true)).toBeUndefined();
  });

  it("judges omissions only for fully static policies", () => {
    expect(
      parseContentSecurityPolicy("img-src 'self'; connect-src https:", false)
        ?.concerns,
    ).toEqual([
      expect.objectContaining({ directive: "connect-src", source: "https:" }),
      expect.objectContaining({ directive: "script-src", source: null }),
      expect.objectContaining({ directive: "object-src", source: null }),
    ]);
    expect(
      parseContentSecurityPolicy("img-src 'self'; connect-src ${…}", false)
        ?.concerns,
    ).toEqual([]);
  });

  it("ignores script 'unsafe-inline' when a nonce or hash is present", () => {
    expect(
      parseContentSecurityPolicy(
        "default-src 'self'; script-src 'nonce-abc' 'unsafe-inline'",
        false,
      )?.concerns,
    ).toEqual([]);
  });
});
