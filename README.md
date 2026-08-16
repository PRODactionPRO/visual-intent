# Visual Intent

Visual Intent is a local-first visual feedback bridge for software teams. It puts a small annotation overlay on top of a running local web app, saves structured tasks beside the project, and exposes those tasks to coding agents through MCP.

The current release is a deliberately narrow web-first MVP. It has no cloud backend, accounts, telemetry, or enterprise features.

## What works now

- local reverse proxy for a `localhost` development server;
- injected overlay with **Select**, **Draw**, **Comment**, **Tasks**, and **Apply**;
- structured, platform-neutral `Surface`, `Node`, `Region`, `Frame`, `Relation`, `Annotation`, `Intent`, and `Task` entities;
- JSON file storage with atomic writes, a short-lived file lock, and revision conflict checks;
- repository-bound project sessions and durable Apply batches;
- local HTTP API and token-protected mutations/WebSocket notifications;
- Codex SDK dispatcher plus MCP tools for project chats;
- a repository-local Codex plugin source with automatic session attachment;
- a React/Vite example surface.

`Add task` saves one visual comment to the editable local queue. `Apply` atomically creates a durable batch from every ready item. If a Codex project chat is attached, the local dispatcher resumes exactly that thread with the exact server-owned repository as its working directory. Without an attached executor, the batch stays visible as `waiting_for_executor`; feedback is never silently discarded.

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
2. Enter a change request in the card that opens beside the selected element.
3. Click **Add task** to put it in the local queue.
4. Open **Tasks** to edit or delete saved comments.
5. Click **Apply** to send the complete ready queue to the coding-agent bridge.

Tasks are stored in `.visual-intent/tasks.json`, which is ignored by Git.
The demo starts disconnected, so Apply is safe to explore: it records a waiting batch but does not edit the example repository.

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
  --store /absolute/path/to/your-project/.visual-intent/tasks.json \
  --repo /absolute/path/to/your-project \
  --project your-project \
  --name "Your project"
```

Open <http://127.0.0.1:7310>. Your project continues running on its original port; the proxy passes requests and hot-reload WebSockets through while adding the overlay to HTML responses.

The MVP intentionally accepts only loopback targets and binds only to loopback. If a dev server emits compressed HTML despite the proxy asking for an uncompressed response, the page is proxied but the overlay is not injected.

## Route Apply to the correct Codex project chat

The default executor is `disconnected`. This is intentional: starting a proxy from the Visual Intent repository must not make the Visual Intent development chat edit whichever product happens to be displayed.

For an existing Codex project chat, run this command from that chat's project terminal after the proxy is running:

```bash
node /absolute/path/to/visual-intent/apps/cli/dist/index.js attach \
  --daemon http://127.0.0.1:7310 \
  --repo /absolute/path/to/your-project
```

Inside Codex, `CODEX_THREAD_ID` supplies the current chat identifier. The daemon validates the canonical repository path before attaching it. The Tasks panel changes from `disconnected` to `connected`; the next Apply resumes that project chat through the local Codex SDK.

If a separate generated Codex thread is preferable, start the proxy with:

```bash
pnpm vip -- start \
  --target http://127.0.0.1:3000 \
  --port 7310 \
  --store /absolute/path/to/your-project/.visual-intent/tasks.json \
  --repo /absolute/path/to/your-project \
  --project your-project \
  --executor codex
```

The first Apply creates a persistent SDK thread and later batches resume it. By default the dispatcher refuses to edit a repository that already has uncommitted changes. `--allow-dirty` is available only for an intentional, reviewed exception.

### Codex plugin

The plugin source is in `plugins/visual-intent`. It contributes:

- a `SessionStart` hook that attaches a project chat when the matching proxy is already running;
- a project-session skill that verifies the exact Git root;
- MCP tools for session, task, batch, claim, and completion status.

Codex asks the user to trust a new hook before it can run; review it in `/hooks`. Plugin changes are picked up by a new Codex chat after installation. The CLI `attach` command above remains the immediate, plugin-independent path.

## Connect another coding agent through MCP

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

The file-backed compatibility bridge exposes seven tools:

- `visual_intent_list_tasks` — list all tasks or filter by status;
- `visual_intent_list_batches` — list Apply batches and their status;
- `visual_intent_retry_batch` — retry a blocked/failed batch after its blocker is resolved;
- `visual_intent_claim_batch` — atomically claim one queued batch and mark it `in_progress`;
- `visual_intent_get_task` — retrieve full visual and revision context;
- `visual_intent_finish_batch` — store the implementation result for the whole batch;
- `visual_intent_update_task` — edit instructions or report status and an optional implementation result.

## Local API

All endpoints use the Visual Intent proxy origin:

```text
GET   /_visual-intent/api/health
GET   /_visual-intent/api/session
POST  /_visual-intent/api/session/attach
GET   /_visual-intent/api/tasks?status=ready
GET   /_visual-intent/api/tasks/:id
POST  /_visual-intent/api/tasks
PATCH /_visual-intent/api/tasks/:id
DELETE /_visual-intent/api/tasks/:id
POST  /_visual-intent/api/tasks/apply
GET   /_visual-intent/api/batches
GET   /_visual-intent/api/batches/:id
POST  /_visual-intent/api/batches/:id/claim
POST  /_visual-intent/api/batches/:id/finish
POST  /_visual-intent/api/batches/:id/retry
WS    /_visual-intent/ws
```

The daemon writes a mode-`0600` `.visual-intent/connection.json` file in the target repository. It contains the loopback URL and a random session token used for mutations, WebSocket access, CLI attachment, the hook, and the plugin MCP bridge. Keep `.visual-intent/` ignored and never commit that file.

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
plugins/
  visual-intent/   Codex hook, skill, and daemon-backed MCP bridge
docs/
  PRODUCT.md
  ARCHITECTURE.md
  PROTOCOL.md
  PLATFORM-ROADMAP.md
```

See [Product](docs/PRODUCT.md), [Architecture](docs/ARCHITECTURE.md), [Protocol](docs/PROTOCOL.md), and [Platform roadmap](docs/PLATFORM-ROADMAP.md).

## License

MIT
