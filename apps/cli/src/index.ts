#!/usr/bin/env node
import { resolve } from "node:path";

import { Command } from "commander";

import { FileTaskStore } from "@visual-intent/file-store";
import { runMcpServer } from "@visual-intent/mcp-server";

import { startDaemon } from "./daemon.js";

const program = new Command();

program
  .name("visual-intent")
  .description("Capture visual change requests from a local development server")
  .version("0.1.0");

program
  .command("start")
  .description("Start the local reverse proxy, overlay, and task API")
  .requiredOption("--target <url>", "localhost development server to proxy")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--port <port>", "port to bind", "7310")
  .option("--store <path>", "local task file", ".visual-intent/tasks.json")
  .action(
    async (options: {
      target: string;
      host: string;
      port: string;
      store: string;
    }) => {
      const port = Number.parseInt(options.port, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("Port must be an integer between 0 and 65535");
      }
      if (
        options.host !== "127.0.0.1" &&
        options.host !== "::1" &&
        options.host !== "localhost"
      ) {
        throw new Error("MVP only binds to a local loopback host");
      }

      const storePath = resolve(options.store);
      const daemon = await startDaemon({
        host: options.host,
        port,
        target: options.target,
        store: new FileTaskStore(storePath),
      });

      console.log(`Visual Intent: http://${daemon.host}:${daemon.port}`);
      console.log(`Proxy target:  ${daemon.target}`);
      console.log(`Task store:    ${storePath}`);
      console.log("Press Ctrl+C to stop.");

      await new Promise<void>((done) => {
        const stop = (): void => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          done();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
      await daemon.close();
    },
  );

program
  .command("mcp")
  .description("Run the coding-agent bridge over MCP stdio")
  .option("--store <path>", "local task file", ".visual-intent/tasks.json")
  .action(async (options: { store: string }) => {
    await runMcpServer(new FileTaskStore(resolve(options.store)));
  });

await program.parseAsync();
