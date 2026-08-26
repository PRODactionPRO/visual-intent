import { describe, expect, it, vi } from "vitest";

import {
  RUNTIME_DIAGNOSTICS_LIMIT,
  RuntimeDiagnostics,
  probeRuntimeTarget,
  safeErrorCode,
  safePathname,
} from "../src/runtime-diagnostics.js";

describe("runtime diagnostics", () => {
  it("keeps a bounded privacy-safe event ring", async () => {
    const fetchTarget = vi.fn(async () => new Response("ok", { status: 200 }));
    const diagnostics = new RuntimeDiagnostics({
      instanceId: "daemon-1",
      startedAt: "2026-08-26T10:00:00.000Z",
      target: new URL("http://127.0.0.1:3000"),
      now: () => new Date("2026-08-26T10:01:00.000Z"),
      fetch: fetchTarget,
    });

    for (let index = 0; index < RUNTIME_DIAGNOSTICS_LIMIT + 3; index += 1) {
      diagnostics.record({
        kind: "proxy_response",
        requestUrl: `/item/${index}?secret=cookie-${index}`,
        status: 200,
      });
    }
    diagnostics.record({
      kind: "proxy_error",
      requestUrl: "/broken?token=private",
      error: Object.assign(new Error("contains private details"), {
        code: "ECONNREFUSED",
      }),
    });

    const snapshot = await diagnostics.snapshot({
      proxyOrigin: "http://127.0.0.1:7310",
      session: undefined,
    });

    expect(snapshot.recentEvents).toHaveLength(RUNTIME_DIAGNOSTICS_LIMIT);
    expect(snapshot.recentEvents.at(-1)).toEqual({
      at: "2026-08-26T10:01:00.000Z",
      kind: "proxy_error",
      pathname: "/:segment",
      errorCode: "ECONNREFUSED",
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect(fetchTarget).toHaveBeenCalledWith(
      "http://127.0.0.1:3000",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("reports an unreachable target without throwing", async () => {
    const fetchTarget = vi.fn(async () => {
      throw Object.assign(new Error("connection failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    });

    await expect(
      probeRuntimeTarget(new URL("http://127.0.0.1:39999"), {
        fetch: fetchTarget,
        now: () => new Date("2026-08-26T10:02:00.000Z"),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        origin: "http://127.0.0.1:39999",
        reachable: false,
        errorCode: "ECONNREFUSED",
      }),
    );
  });

  it("sanitizes paths and error values", () => {
    expect(safePathname("/admin?apiToken=secret#private")).toBe("/:segment");
    expect(safePathname("/reset/alice@example.com/a-secret-token")).toBe(
      "/:segment/:segment/:segment",
    );
    expect(safePathname("/admin/_next/webpack-hmr")).toBe(
      "/:segment/_next/webpack-hmr",
    );
    expect(safeErrorCode(new Error("sensitive message"))).toBe("RUNTIME_ERROR");
    expect(safeErrorCode({ code: "../../secret" })).toBe("RUNTIME_ERROR");
  });
});
