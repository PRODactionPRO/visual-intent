export type ExecutorMode = "preserve" | "disconnected" | "isolated-worker";

export interface ExecutorCommandContext {
  target: string;
  repositoryRoot: string;
  host: string;
  port: number;
}

export function parseExecutorMode(
  value: string,
  context: ExecutorCommandContext,
): ExecutorMode {
  if (value === "codex") {
    const base = [
      "visual-intent start",
      `--target ${quoteShellArgument(context.target)}`,
      `--repo ${quoteShellArgument(context.repositoryRoot)}`,
      `--host ${quoteShellArgument(context.host)}`,
      `--port ${context.port}`,
    ].join(" ");
    const daemonUrl = formatLoopbackOrigin(context.host, context.port);
    throw new Error(
      [
        "--executor codex was replaced by explicit ownership modes.",
        `Host-attached controller: ${base} --executor disconnected`,
        `Then attach this Codex task: visual-intent attach --daemon ${quoteShellArgument(daemonUrl)} --repo ${quoteShellArgument(context.repositoryRoot)} --thread <CODEX_THREAD_ID>`,
        `Autonomous SDK worker: ${base} --executor isolated-worker`,
      ].join("\n"),
    );
  }
  if (
    value !== "preserve" &&
    value !== "disconnected" &&
    value !== "isolated-worker"
  ) {
    throw new Error(
      "Executor must be preserve, disconnected or isolated-worker",
    );
  }
  return value;
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
import { formatLoopbackOrigin } from "./loopback-origin.js";
