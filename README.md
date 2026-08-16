# Visual Intent

Visual Intent is a local-first visual feedback bridge for software teams. It puts a small annotation overlay on top of a running local web app, saves structured tasks beside the project, and exposes those tasks to coding agents through MCP.

The current release is a deliberately narrow web-first MVP. It has no cloud backend, accounts, telemetry, or enterprise features.

## What works now

- local reverse proxy for a `localhost` development server;
- injected overlay with **Select**, **Draw**, **Comment**, **Tasks**, and **Apply**;
- structured, platform-neutral `Surface`, `Node`, `Region`, `Frame`, `Relation`, `Annotation`, `Intent`, and `Task` entities;
- JSON file storage with atomic writes, a short-lived file lock, and revision conflict checks;
- local HTTP API and WebSocket task-change notifications;
- MCP stdio bridge for listing, reading, and updating tasks;
- a React/Vite example surface.

`Apply` means “save this intent as a task”. It never changes source code by itself. A coding agent reads the task, performs work in the real repository under its normal approval rules, and writes the result back.

## Requirements

- Node.js 20.19 or newer;
- pnpm 11.18 (`corepack enable` can provide it).

## Run the included demo

```bash
corepack enable
pnpm install
pnpm demo
```

Open <http://127.0.0.1:7310>. Do not open port `5173`: that is the unmodified example app. Port `7310` is the Visual Intent proxy with the overlay.

Try this loop:

1. Click **Select**, then click the green “Start a conversation” button.
2. Click **Comment** and enter a change request.
3. Click **Apply** to save it locally.
4. Click **Tasks** to see the captured task.

Tasks are stored in `.visual-intent/tasks.json`, which is ignored by Git.

## Use it with another local web project

First start that project's normal development server. For example, assume it is available at `http://127.0.0.1:3000`.

In this repository, install and build Visual Intent once:

```bash
corepack enable
pnpm install
pnpm build
```

Then run the proxy. Replace both absolute paths with real paths on your machine:

```bash
pnpm vip -- start \
  --target http://127.0.0.1:3000 \
  --port 7310 \
  --store /absolute/path/to/your-project/.visual-intent/tasks.json
```

Open <http://127.0.0.1:7310>. Your project continues running on its original port; the proxy passes requests and hot-reload WebSockets through while adding the overlay to HTML responses.

The MVP intentionally accepts only loopback targets and binds only to loopback. If a dev server emits compressed HTML despite the proxy asking for an uncompressed response, the page is proxied but the overlay is not injected.

## Connect a coding agent through MCP

Build the repository first, then point the agent's MCP configuration at the same task file used by the proxy.

Generic MCP configuration:

```json
{
  "mcpServers": {
    "visual-intent": {
      "command": "node",
      "args": [
        "/absolute/path/to/visual-intent/apps/cli/dist/index.js",
        "mcp",
        "--store",
        "/absolute/path/to/your-project/.visual-intent/tasks.json"
      ]
    }
  }
}
```

Codex TOML configuration uses the same command and arguments:

```toml
[mcp_servers.visual_intent]
command = "node"
args = [
  "/absolute/path/to/visual-intent/apps/cli/dist/index.js",
  "mcp",
  "--store",
  "/absolute/path/to/your-project/.visual-intent/tasks.json"
]
```

The bridge exposes three tools:

- `visual_intent_list_tasks` — list all tasks or filter by status;
- `visual_intent_get_task` — retrieve full visual and revision context;
- `visual_intent_update_task` — report status and an optional implementation result.

## Local API

All endpoints use the Visual Intent proxy origin:

```text
GET   /_visual-intent/api/health
GET   /_visual-intent/api/tasks?status=ready
GET   /_visual-intent/api/tasks/:id
POST  /_visual-intent/api/tasks
PATCH /_visual-intent/api/tasks/:id
WS    /_visual-intent/ws
```

For a quick check:

```bash
curl http://127.0.0.1:7310/_visual-intent/api/health
curl http://127.0.0.1:7310/_visual-intent/api/tasks
```

## Validate the repository

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Or run the same sequence with:

```bash
pnpm check
```

## Repository map

```text
apps/
  cli/             local daemon, reverse proxy, HTTP/WebSocket API, CLI
  example-web/     React/Vite test surface
packages/
  protocol/        stable entities, Zod contracts, JSON Schema
  core/            task lifecycle and storage port
  file-store/      local JSON storage adapter
  sdk/             typed HTTP client
  web-overlay/     dependency-free injected browser UI
  mcp-server/      coding-agent bridge over MCP stdio
docs/
  PRODUCT.md
  ARCHITECTURE.md
  PROTOCOL.md
  PLATFORM-ROADMAP.md
```

See [Product](docs/PRODUCT.md), [Architecture](docs/ARCHITECTURE.md), [Protocol](docs/PROTOCOL.md), and [Platform roadmap](docs/PLATFORM-ROADMAP.md).

## License

MIT
