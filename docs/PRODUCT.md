# Product

## Product thesis

Software feedback loses meaning while it moves from a visible interface into chat, screenshots, task trackers, and finally source code. Visual Intent captures the user's intent at the interface itself and carries enough structured context for a developer or coding agent to act without guessing what the comment referred to.

The product is a platform, not a web-only annotation widget. Web, React Native, iOS, Android, and canvas tools are adapters over the same protocol and task lifecycle.

## Initial users

The first user is a developer or product manager working locally on their own project. The first team use case is an internal product team reviewing a development build. A later commercial use case is an agency giving a client a safe browser review surface and routing approved feedback into the team's existing workflow.

## Principles

1. **Local first.** The first useful loop runs on one machine without an account or cloud dependency.
2. **Web first, platform neutral.** Prove the workflow with the browser while keeping protocol entities independent of DOM, React, SwiftUI, or Compose.
3. **Intent before automation.** Capturing a clear target, region, comment, and expected result matters before autonomous code changes.
4. **Human-controlled application.** Saving a task does not authorize a coding agent to edit or publish code.
5. **Adapters instead of forks.** Platforms, trackers, storage engines, and agents implement stable ports.
6. **Open contracts.** The local core, protocol, SDK, and basic adapters are intended to be open source.

## Web-first MVP

The current MVP provides one complete local loop:

```text
running localhost app
  -> Visual Intent reverse proxy
  -> injected overlay
  -> selected DOM node or drawn viewport region
  -> local structured task
  -> HTTP/MCP consumer
  -> task status and result
```

The overlay exposes the requested controls:

- **Select** captures an element, selector, visible text, selected semantic attributes, and its viewport rectangle.
- **Draw** captures an arbitrary viewport rectangle.
- **Comment** focuses the instruction composer.
- **Tasks** shows the local queue and current status.
- **Apply** validates and stores the task locally. It does not edit source code automatically.

## MVP success criteria

- A new contributor can install and open the included demo using the README alone.
- The overlay works through the proxy without adding an SDK to the target project.
- A task survives daemon restart in a readable JSON file.
- HTTP and MCP clients receive the same protocol shape.
- A task update cannot silently overwrite a newer revision.
- Lint, type checks, tests, and production builds pass in CI.

## Explicit non-goals for this release

- cloud backend or hosted review links;
- accounts, authentication, permissions, or organizations;
- multi-user collaboration and conflict-free live editing;
- automatic source-code mutation or Git operations;
- screenshots, video, asset uploads, or object storage;
- production browser extension distribution;
- Jira, Yandex Tracker, Notion, Slack, or webhook delivery;
- React Native, iOS, or Android runtime adapters;
- SSO, audit export, policy engines, on-prem control plane, or other enterprise features.

## Open-source and commercial strategy

The planned open-source base contains the protocol, local daemon, overlay/adapters, SDK, local stores, MCP bridge, and examples. This makes the tool useful to individual developers and allows other platforms and agents to implement compatible adapters.

Commercial value appears when coordination becomes the hard problem rather than capture:

- hosted projects and review environments;
- internal and external participant roles;
- secure guest links and review sessions;
- durable history, media, notifications, and service-level controls;
- organization policy, SSO/SCIM, audit, private deployment, support, and governance;
- managed connectors and workflow analytics.

The open protocol must not require the commercial backend. A local task should remain exportable and processable by third-party tools.

## Product decisions still open

- Whether a future browser extension is the default web adapter or complements the reverse proxy.
- How source maps and framework devtools map runtime nodes to code without coupling the protocol to React.
- Which collaboration objects are universal (`Project`, `ReviewSession`, `Participant`) and which stay backend-specific.
- Which connector SDK guarantees are required before publishing third-party plugins.
