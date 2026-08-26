import { describe, expect, it, vi } from "vitest";

import {
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  type DoctorDependencies,
} from "../src/doctor.js";
import type { RuntimeDiagnosticsSnapshot } from "../src/runtime-diagnostics.js";

const repositoryRoot = "/workspace/project";
const daemonUrl = "http://127.0.0.1:7310";
const apiToken = "a".repeat(48);

function fixtureDependencies(input: {
  files?: Record<string, string>;
  health?: unknown;
  diagnostics?: unknown;
}): DoctorDependencies {
  const files: Record<string, string> = {
    [`${repositoryRoot}/.git/info/exclude`]: "/.visual-intent/\n",
    [`${repositoryRoot}/.visual-intent/connection.json`]: JSON.stringify({
      protocolVersion: "0.1",
      daemonUrl,
      apiToken,
      projectKey: "project",
      repositoryRoot,
      sessionId: "session-1",
      daemonInstanceId: "daemon-1",
    }),
    [`${repositoryRoot}/package.json`]: JSON.stringify({
      devDependencies: { "@biomejs/biome": "2.0.0", next: "16.0.0" },
    }),
    [`${repositoryRoot}/biome.json`]: JSON.stringify({
      files: { includes: ["**", "!.visual-intent"] },
    }),
    [`${repositoryRoot}/apps/web/next.config.mjs`]:
      'export default { allowedDevOrigins: ["127.0.0.1"] };',
    ...input.files,
  };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/health")) {
      return Response.json(input.health ?? validHealth());
    }
    if (target.endsWith("/diagnostics")) {
      return Response.json(input.diagnostics ?? validDiagnostics());
    }
    return new Response("target", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    canonicalize: vi.fn(async () => repositoryRoot),
    readText: vi.fn(async (path) => files[path]),
    listRelevantFiles: vi.fn(async () =>
      Object.keys(files).filter(
        (path) => path.endsWith("biome.json") || path.includes("next.config."),
      ),
    ),
    runGit: vi.fn(async (_root, args) =>
      args.includes("--show-toplevel")
        ? `${repositoryRoot}\n`
        : ".git/info/exclude\n",
    ),
    fetch: fetcher,
    now: () => new Date("2026-08-26T12:00:00.000Z"),
  };
}

function validHealth(): unknown {
  return {
    ok: true,
    protocolVersion: "0.1",
    daemonInstanceId: "daemon-1",
    session: {
      id: "session-1",
      projectKey: "project",
      displayName: "Project",
      repository: { root: repositoryRoot, name: "project" },
      targetUrl: "http://127.0.0.1:3000",
      proxyUrl: daemonUrl,
      executor: {
        kind: "codex",
        ownership: "visual-intent-owned",
        status: "connected",
      },
      createdAt: "2026-08-26T11:00:00.000Z",
      updatedAt: "2026-08-26T11:00:00.000Z",
    },
  };
}

function validDiagnostics(): RuntimeDiagnosticsSnapshot {
  return {
    version: 1,
    generatedAt: "2026-08-26T12:00:00.000Z",
    daemon: {
      instanceId: "daemon-1",
      startedAt: "2026-08-26T11:00:00.000Z",
      protocolVersion: "0.1",
    },
    proxy: { origin: daemonUrl, reachable: true },
    target: {
      origin: "http://127.0.0.1:3000",
      reachable: true,
      checkedAt: "2026-08-26T12:00:00.000Z",
      latencyMs: 3,
      status: 200,
    },
    session: {
      id: "session-1",
      projectKey: "project",
      repositoryRoot,
      executor: {
        kind: "codex",
        ownership: "visual-intent-owned",
        status: "connected",
      },
    },
    recentEvents: [],
  };
}

describe("Visual Intent doctor", () => {
  it("returns a typed read-only healthy report without exposing the token", async () => {
    const dependencies = fixtureDependencies({});
    const report = await runDoctor({ repo: repositoryRoot }, dependencies);

    expect(report.repositoryRoot).toBe(repositoryRoot);
    expect(report.summary.fail).toBe(0);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "target.reachability", status: "pass" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "next.allowed-dev-origins",
        status: "pass",
      }),
    );
    expect(JSON.stringify(report)).not.toContain(apiToken);
    expect(doctorExitCode(report)).toBe(0);
  });

  it("detects stale runtime identity and an unreachable target", async () => {
    const diagnostics = validDiagnostics();
    diagnostics.target = {
      ...diagnostics.target,
      reachable: false,
      status: undefined,
      errorCode: "ECONNREFUSED",
    };
    const health = validHealth() as {
      daemonInstanceId: string;
      session: { id: string };
    };
    health.daemonInstanceId = "daemon-stale";
    health.session.id = "session-stale";
    const report = await runDoctor(
      { repo: repositoryRoot },
      fixtureDependencies({ health, diagnostics }),
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "runtime.instance", status: "fail" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "runtime.session", status: "fail" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "target.reachability", status: "fail" }),
    );
    expect(doctorExitCode(report)).toBe(2);
  });

  it("provides linter recipes and a strict warning exit policy", async () => {
    const report = await runDoctor(
      { repo: repositoryRoot },
      fixtureDependencies({
        files: {
          [`${repositoryRoot}/.git/info/exclude`]: "",
          [`${repositoryRoot}/biome.json`]: JSON.stringify({ files: {} }),
          [`${repositoryRoot}/apps/web/next.config.mjs`]: "export default {};",
        },
      }),
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "git.exclude", status: "warning" }),
    );
    expect(
      report.ignoreRecipes.find((recipe) => recipe.tool === "biome"),
    ).toEqual(expect.objectContaining({ detected: true, ignored: false }));
    expect(doctorExitCode(report)).toBe(1);
    expect(doctorExitCode(report, true)).toBe(2);
    expect(formatDoctorReport(report)).toContain("[WARN]");
    expect(formatDoctorReport(report)).toContain("Что сделать:");
  });

  it("does not mistake a positive runtime include for a linter ignore", async () => {
    const report = await runDoctor(
      { repo: repositoryRoot },
      fixtureDependencies({
        files: {
          [`${repositoryRoot}/biome.json`]: JSON.stringify({
            files: { includes: [".visual-intent/**"] },
          }),
        },
      }),
    );

    expect(
      report.ignoreRecipes.find((recipe) => recipe.tool === "biome"),
    ).toEqual(expect.objectContaining({ detected: true, ignored: false }));
  });

  it("uses the canonical Git root when doctor starts in a subdirectory", async () => {
    const dependencies = fixtureDependencies({});
    dependencies.canonicalize = vi.fn(async (path) =>
      path.endsWith("/apps/web")
        ? `${repositoryRoot}/apps/web`
        : repositoryRoot,
    );

    const report = await runDoctor(
      { repo: `${repositoryRoot}/apps/web` },
      dependencies,
    );

    expect(report.repositoryRoot).toBe(repositoryRoot);
    expect(report.connection.path).toBe(
      `${repositoryRoot}/.visual-intent/connection.json`,
    );
  });
});
