import { describe, expect, it, vi } from "vitest";

import { ConnectionProjectDaemonProbe } from "../src/project-daemon-probe.js";

const repositoryRoot = "/workspace/project";
const daemonUrl = "http://127.0.0.1:7310";
const apiToken = "a".repeat(48);

describe("legacy project daemon health probe", () => {
  it("returns a daemon only after connection and health identities match", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        ok: true,
        service: "visual-intent",
        daemonInstanceId: "daemon-1",
        session: {
          id: "session-1",
          projectKey: "project",
          repository: { root: repositoryRoot, name: "project" },
          proxyUrl: daemonUrl,
        },
      }),
    ) as unknown as typeof fetch;
    const probe = new ConnectionProjectDaemonProbe({
      readText: vi.fn(async () => connectionJson()),
      fetch: fetcher,
      timeoutMs: 50,
    });

    await expect(probe.inspect(repositoryRoot)).resolves.toEqual({
      daemonUrl,
      daemonInstanceId: "daemon-1",
      repositoryRoot,
      sessionId: "session-1",
      projectKey: "project",
    });
    expect(fetcher).toHaveBeenCalledWith(
      `${daemonUrl}/_visual-intent/api/health`,
      expect.objectContaining({
        headers: { "x-visual-intent-token": apiToken },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects a stale daemon instance or a repository mismatch", async () => {
    const probe = new ConnectionProjectDaemonProbe({
      readText: vi.fn(async () => connectionJson()),
      fetch: vi.fn(async () =>
        Response.json({
          ok: true,
          service: "visual-intent",
          daemonInstanceId: "different-daemon",
          session: {
            id: "session-1",
            projectKey: "project",
            repository: { root: "/workspace/other", name: "other" },
            proxyUrl: daemonUrl,
          },
        }),
      ) as unknown as typeof fetch,
    });

    await expect(probe.inspect(repositoryRoot)).resolves.toBeUndefined();
  });

  it("never fetches a non-loopback, credentialed, or path-scoped daemon URL", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const values = [
      "https://127.0.0.1:7310",
      "http://example.com:7310",
      "http://user:secret@127.0.0.1:7310",
      "http://127.0.0.1:7310/admin",
    ];

    for (const value of values) {
      const probe = new ConnectionProjectDaemonProbe({
        readText: vi.fn(async () => connectionJson({ daemonUrl: value })),
        fetch: fetcher,
      });
      await expect(probe.inspect(repositoryRoot)).resolves.toBeUndefined();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats an unreachable daemon as absent", async () => {
    const probe = new ConnectionProjectDaemonProbe({
      readText: vi.fn(async () => connectionJson()),
      fetch: vi.fn(async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
      timeoutMs: 25,
    });

    await expect(probe.inspect(repositoryRoot)).resolves.toBeUndefined();
  });
});

function connectionJson(
  overrides: Partial<{ daemonUrl: string }> = {},
): string {
  return JSON.stringify({
    daemonUrl: overrides.daemonUrl ?? daemonUrl,
    apiToken,
    daemonInstanceId: "daemon-1",
    repositoryRoot,
    sessionId: "session-1",
    projectKey: "project",
  });
}
