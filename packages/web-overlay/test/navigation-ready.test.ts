import { describe, expect, it } from "vitest";

import {
  createOverlayScript,
  settleNavigationBootstrap,
} from "../src/index.js";

function section(script: string, start: string, end: string): string {
  const startIndex = script.indexOf(start);
  const endIndex = script.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThan(-1);
  expect(endIndex).toBeGreaterThan(startIndex);
  return script.slice(startIndex, endIndex);
}

describe("navigation-ready contract", () => {
  it("publishes the booting marker before the Shadow DOM is mounted", () => {
    const script = createOverlayScript();
    const booting = script.indexOf(
      'overlayHost.setAttribute("data-visual-intent-bootstrap", "booting")',
    );
    const mounted = script.indexOf(
      "document.documentElement.append(overlayHost)",
    );

    expect(booting).toBeGreaterThan(-1);
    expect(mounted).toBeGreaterThan(booting);
  });

  it("uses honest loader results to choose ready or degraded", () => {
    const script = createOverlayScript();
    const tasks = section(
      script,
      "async function loadTasks()",
      "function appendDetails",
    );
    const runtime = section(
      script,
      "async function loadRuntime()",
      "function openApplyModal",
    );
    const bootstrap = section(
      script,
      "async function runInitialBootstrap()",
      'addEventListener("resize"',
    );

    expect(tasks).toContain("return true");
    expect(tasks).toContain("return false");
    expect(runtime).toContain("return true");
    expect(runtime).toContain("return false");
    expect(bootstrap).toContain("settleNavigationBootstrap(");
    expect(bootstrap).toContain(
      'result.tasksLoaded && result.runtimeLoaded ? "ready" : "degraded"',
    );
    expect(bootstrap).toContain(
      'overlayHost.setAttribute("data-visual-intent-bootstrap", status)',
    );
  });

  it("terminates as a timeout result when an API loader never settles", async () => {
    const never = new Promise<boolean>(() => undefined);

    await expect(
      settleNavigationBootstrap(Promise.resolve(true), never, 5),
    ).resolves.toEqual({
      tasksLoaded: false,
      runtimeLoaded: false,
      timedOut: true,
    });
  });

  it("dispatches the versioned event with session and daemon identity", () => {
    const script = createOverlayScript({
      apiToken: "token-test",
      daemonInstanceId: "daemon-test",
    });
    const bootstrap = section(
      script,
      "async function runInitialBootstrap()",
      'addEventListener("resize"',
    );

    expect(script).toContain('const daemonInstanceId = "daemon-test"');
    expect(script).not.toContain("__VISUAL_INTENT_DAEMON_INSTANCE_ID__");
    expect(bootstrap).toContain(
      'new CustomEvent("visual-intent:navigation-ready"',
    );
    expect(bootstrap).toContain('version: "v1"');
    expect(bootstrap).toContain("status");
    expect(bootstrap).toContain("daemonInstanceId: daemonInstanceId || null");
    expect(bootstrap).toContain("sessionId: currentSession?.id ?? null");
    expect(bootstrap).toContain("url: location.href");
    expect(bootstrap).toContain("readyAt");
  });

  it("keeps the terminal marker independent of WebSocket refreshes", () => {
    const script = createOverlayScript();
    const socket = section(
      script,
      "function connectSocket()",
      "async function runInitialBootstrap()",
    );
    const bootstrap = section(
      script,
      "async function runInitialBootstrap()",
      'addEventListener("resize"',
    );

    expect(socket).toContain("void loadTasks()");
    expect(socket).toContain("void loadRuntime()");
    expect(socket).not.toContain("data-visual-intent-bootstrap");
    expect(bootstrap.match(/data-visual-intent-bootstrap/g)).toHaveLength(1);
    expect(script).toContain("void runInitialBootstrap()");
  });
});
