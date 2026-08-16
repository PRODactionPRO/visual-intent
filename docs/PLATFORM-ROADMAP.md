# Platform roadmap

This roadmap describes direction, not shipped functionality. Each phase should deliver a complete user loop before the next platform is added.

## Phase 0 — Local web proof (implemented)

- TypeScript monorepo with protocol, core, SDK, and adapters.
- Loopback reverse proxy with injected overlay.
- Contextual Select/Draw composer, editable Tasks queue, and explicit batch Apply.
- Repository-bound project sessions and durable Apply batch status.
- Disconnected-safe default plus Codex SDK dispatch to an attached project thread.
- Codex plugin source with a SessionStart hook, project skill, and daemon-backed MCP tools.
- JSON file store, token-protected mutations/WebSocket, and MCP stdio bridge.
- React/Vite example and automated checks.

Exit signal: the team can use captured tasks in a real local project and identify which missing context causes agent rework.

## Phase 1 — Useful web development loop

- Framework-aware source hints for React and common web stacks without putting React in core.
- Resilient selection across scroll, responsive layouts, iframes, and shadow roots.
- Screenshot attachment and viewport metadata with explicit privacy controls.
- Task clarification, acceptance criteria, history, and reopen flow.
- Agent workflow templates that require preview, repository inspection, verification, and result reporting.
- Clear browser status/history for connected, running, needs-input, completed, and failed batches.
- Packaged installation and update flow for the Codex plugin.
- Packaged CLI and a browser extension spike; choose the default adapter from observed use.

Exit signal: repeated use on several internal repositories with materially less back-and-forth than screenshots and chat.

## Phase 2 — Connector plugin foundation

- Public connector SDK, capability manifest, configuration schema, idempotency contract, and conformance tests.
- Outbound task destinations for Jira, Yandex Tracker, and Notion.
- Agent adapters for MCP-based tools, Codex, Claude Code, Cursor, and other compatible clients.
- Delivery preview and explicit confirmation before creating external tasks.
- External IDs, retry state, dead-letter handling, and safe secret storage.

Exit signal: one task can be intentionally routed to two different providers without provider logic leaking into core.

## Phase 3 — Collaboration backend

- Hosted projects, review sessions, team roles, and expiring external-client access.
- PostgreSQL task/history store and object storage for controlled media.
- Real-time collaboration, notifications, review assignment, and resolution workflow.
- Browser extension connected to an authenticated review environment.
- API/webhooks for studios and internal product teams.

Exit signal: an agency can invite a client, collect feedback against a review build, triage it, and route approved work with an auditable history.

This is the first phase that needs a cloud backend and authentication. It must not make the local open-source loop dependent on the hosted product.

## Phase 4 — React Native adapter

- Development-only package connected to Metro and the local daemon.
- Component hierarchy and props references when the runtime exposes them.
- Touch selection and drawn regions in iOS and Android emulators.
- Coordinate normalization for density, safe areas, orientation, and scroll containers.

Exit signal: a task captured in a React Native emulator produces the same protocol envelope and agent workflow as a web task.

## Phase 5 — Native iOS adapter

- Swift package for SwiftUI and UIKit development builds.
- View/accessibility hierarchy mapping into `Node`.
- Simulator-first overlay and a local bridge transport.
- Source hints where Xcode/runtime metadata safely permits them.

Exit signal: Swift tooling can capture and replay visual intent without embedding TypeScript in the application runtime.

## Phase 6 — Native Android adapter

- Kotlin library for Jetpack Compose and Android Views development builds.
- Semantics/layout hierarchy mapping, density-aware coordinates, and emulator overlay.
- Gradle development-only integration and local bridge transport.

Exit signal: Android captures pass the same protocol conformance suite used by web, React Native, and iOS.

## Phase 7 — Enterprise product

- SSO/SCIM, granular roles, policy and approval controls.
- Audit export, retention/legal hold, regional deployment, and private networking.
- Managed connector catalog, observability, service-level commitments, and support.
- On-premise or private-cloud control plane when validated by customer demand.

Enterprise features are paid extensions around coordination, governance, and operation. The protocol and useful local workflow remain open.

## Cross-platform acceptance gate

Every new adapter must:

1. emit the current protocol version and pass shared fixtures;
2. map platform-native concepts to shared entities without changing core;
3. keep capture disabled in production builds by default;
4. document permissions, privacy exposure, and performance cost;
5. support an example app and an end-to-end local task capture test;
6. prove compatibility with at least one existing MCP consumer.
