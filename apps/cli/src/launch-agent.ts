import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  assertServiceLabel,
  type VisualIntentServiceConfig,
} from "./service-config.js";

export interface LaunchAgentPaths {
  homeDirectory: string;
  plistPath: string;
  logsDirectory: string;
  standardOutputPath: string;
  standardErrorPath: string;
}

export interface LaunchAgentBinding {
  host: string;
  port: number;
  repositoryRoot?: string;
}

export function launchAgentPaths(
  homeDirectory: string,
  label: string,
): LaunchAgentPaths {
  assertServiceLabel(label);
  if (!isAbsolute(homeDirectory)) {
    throw new Error("LaunchAgent home directory must be an absolute path");
  }
  const logsDirectory = join(homeDirectory, "Library", "Logs", "VisualIntent");
  return {
    homeDirectory,
    plistPath: join(homeDirectory, "Library", "LaunchAgents", `${label}.plist`),
    logsDirectory,
    standardOutputPath: join(logsDirectory, `${label}.out.log`),
    standardErrorPath: join(logsDirectory, `${label}.err.log`),
  };
}

export function serviceProgramArguments(
  config: VisualIntentServiceConfig,
): string[] {
  const argumentsList = [
    config.nodePath,
    config.cliPath,
    "start",
    "--target",
    config.target,
    "--host",
    config.host,
    "--port",
    String(config.port),
    "--repo",
    config.repositoryRoot,
    "--project",
    config.projectKey,
    "--name",
    config.displayName,
    "--executor",
    config.executor,
  ];
  if (config.workerThread) {
    argumentsList.push("--worker-thread", config.workerThread);
  }
  if (config.allowDirty) argumentsList.push("--allow-dirty");
  return argumentsList;
}

export function buildLaunchAgentPlist(
  config: VisualIntentServiceConfig,
  paths: LaunchAgentPaths,
): string {
  assertServiceLabel(config.label);
  const programArguments = serviceProgramArguments(config)
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const executablePath = serviceExecutablePath(config);
  const codexHome = config.codexHome
    ? `\n      <key>CODEX_HOME</key>\n      <string>${escapeXml(config.codexHome)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(config.label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(config.repositoryRoot)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${escapeXml(paths.homeDirectory)}</string>
      <key>PATH</key>
      <string>${escapeXml(executablePath)}</string>
      <key>LANG</key>
      <string>en_US.UTF-8</string>${codexHome}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ExitTimeOut</key>
    <integer>60</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(paths.standardOutputPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(paths.standardErrorPath)}</string>
  </dict>
</plist>
`;
}

export function serviceExecutablePath(
  config: VisualIntentServiceConfig,
): string {
  return [
    ...config.environmentPath.split(":"),
    dirname(config.nodePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(":");
}

export async function writeLaunchAgentPlist(
  config: VisualIntentServiceConfig,
  homeDirectory: string,
): Promise<LaunchAgentPaths> {
  const paths = launchAgentPaths(homeDirectory, config.label);
  await mkdir(dirname(paths.plistPath), { recursive: true, mode: 0o755 });
  await mkdir(paths.logsDirectory, { recursive: true, mode: 0o700 });
  await writeAtomic(
    paths.plistPath,
    buildLaunchAgentPlist(config, paths),
    0o644,
  );
  return paths;
}

export async function readLaunchAgentBinding(
  plistPath: string,
): Promise<LaunchAgentBinding | undefined> {
  const plist = await readFile(plistPath, "utf8");
  const argumentsBlock =
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(
      plist,
    )?.[1];
  if (!argumentsBlock) return undefined;
  const argumentsList = [
    ...argumentsBlock.matchAll(/<string>([\s\S]*?)<\/string>/gu),
  ].map((match) => unescapeXml(match[1] ?? ""));
  const host = argumentValue(argumentsList, "--host");
  const rawPort = argumentValue(argumentsList, "--port");
  if (!host || !rawPort) return undefined;
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || String(port) !== rawPort) return undefined;
  return {
    host,
    port,
    ...(argumentValue(argumentsList, "--repo")
      ? { repositoryRoot: argumentValue(argumentsList, "--repo") }
      : {}),
  };
}

async function writeAtomic(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.visual-intent.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, mode);
    await link(temporaryPath, path);
    await chmod(path, mode);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function argumentValue(
  argumentsList: string[],
  option: string,
): string | undefined {
  const index = argumentsList.indexOf(option);
  return index >= 0 ? argumentsList[index + 1] : undefined;
}
