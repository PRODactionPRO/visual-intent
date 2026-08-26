import { describe, expect, it } from "vitest";

import {
  formatLoopbackHost,
  formatLoopbackOrigin,
} from "../src/loopback-origin.js";

describe("loopback URL formatting", () => {
  it.each([
    ["127.0.0.1", "127.0.0.1"],
    ["localhost", "localhost"],
    ["::1", "[::1]"],
    ["[::1]", "[::1]"],
  ])("formats host %s", (host, expected) => {
    expect(formatLoopbackHost(host)).toBe(expected);
  });

  it("creates a valid IPv6 loopback origin", () => {
    expect(formatLoopbackOrigin("::1", 7310)).toBe("http://[::1]:7310");
    expect(new URL(formatLoopbackOrigin("::1", 7310)).hostname).toBe("[::1]");
  });
});
