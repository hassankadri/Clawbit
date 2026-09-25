# Phase 6: functional agent UI

Implement one subphase per task, preserving existing behavior throughout. This plan does not authorize implementation by itself.

## Baseline and boundaries

- Next.js shell uses local view state; `/projects` is a separate placeholder. Ordinary chat history/pins are transient; projects are localStorage snapshots.
- FastAPI provides chat, SSE and uploads. LangGraph checkpoints preserve agent context; SQL conversation helpers are not wired to chat APIs.
- RAG/uploads are thread-scoped; memory accepts a workspace ID, which the frontend currently omits. MCP already uses a real stdio server and LangGraph tools; plugin UI flags are disconnected.
- Keep provider IDs, chat modes, tool execution and storage compatible. Introduce additive APIs/migrations only in the subphase that needs them. Preserve existing local data during migration.
- Full authentication is not an early blocker. Use an explicit local/single-user scope initially; ownership enforcement and security hardening are mandatory before production.

## 6.1 — Routing, navigation and sidebar foundations only

Establish a shared shell and consistent routes/active states. Sidebar: New Chat, Search, Projects section with existing project shortcuts, Pinned chats, Recent chats, Tools. Profile menu: Profile, Personalization, Settings, Help & Docs, Logout. Remove redundant Chats, Workspaces and Customize navigation; preserve their useful content under the new destinations.

Acceptance:
- Navigation, direct entry and browser back/forward select the correct surface; in-app navigation preserves active chat/model state and existing local project data.
- Project shortcuts open existing projects; menus support keyboard use and collapsed sidebar behavior.
- Keep current New Chat, search-command palette and data behavior; clearly identify deferred functionality. Profile and Personalization have distinct destinations; Logout is explicitly unavailable in local mode, never simulated.
- No backend/API/schema/auth changes, persistence redesign, streaming work or new project/tool capabilities. Existing chat, uploads and model selection remain usable.

## 6.2 — Durable conversations and correct chat lifecycle

Connect conversation metadata/history APIs to existing checkpointed threads. Persist titles/pins and implement Recent, Search and New Chat. Reconcile rename/delete/edit/retry with backend context and separate standalone/project selection. Define compatible local-data import and deletion semantics.

Acceptance: chats and pins survive reload; search finds stored chats; New Chat stays empty until input; project switching cannot misfile chats; edits/retries do not silently retain contradictory history; removal follows documented storage semantics without orphaning active UI state.

## 6.3 — Real streaming and response state

Use the existing SSE endpoint/client, replacing timed word animation. Handle errors, completion and cancellation consistently with checkpoint state; retain model/mode behavior and attachment context.

Acceptance: tokens arrive before completion; stop/error/retry/navigation do not corrupt or cross-update conversations; provider failures appear as errors, not successful answers; relevant chat regressions pass.

## 6.4 — Persistent project chats and files

Add durable projects and chat membership; migrate local projects without losing snapshots/references. Explicitly map project scope to workspace memory. Extend file retrieval to project scope while preserving standalone thread filtering.

Acceptance: project shortcuts, chats and files survive reload; multiple chats can use project files; unrelated projects cannot retrieve each other's files/memory; standalone uploads still work.

## 6.5 — Project instructions and personalization

Persist project instructions/context and user preferences; define their precedence and pass supported values into agent requests. Connect meaningful Profile/Personalization/Settings fields; mark unsupported controls unavailable.

Acceptance: instructions affect only their project; supported preferences survive reload and affect their advertised behavior; defaults preserve existing agent behavior; no UI-only success claims.

## 6.6 — Real Tools/MCP and project tool scope

Expose discovery, connection health and supported configuration through the existing MCP client/server and agent architecture. Replace fake installation/enabling flags with actual supported operations; enforce project tool selection and account for cached agents/tools.

Acceptance: UI reflects real discovery/execution/failures; disabling a tool prevents agent execution; project settings stay isolated; built-in tools and MCP failure fallback remain functional. Do not invent integrations or replace MCP with mock state.

## 6.7 — Agent runs/activity

Persist and display project run status and tool lifecycle events from actual execution, with chat/run associations and useful errors.

Acceptance: running/completed/failed/cancelled states match backend outcomes; activity survives reload, links to its chat and never fabricates progress or exposes secrets.

## 6.8 — Production hardening and final verification

Implement identity/session handling and real Logout; enforce ownership on chats, projects, files, memory, runs and tools. Validate identifiers/upload paths and limits; secure outbound tool access, secrets and tool approvals. Finalize Help & Docs against shipped behavior.

Acceptance: cross-user access is denied; Logout invalidates the session and clears private client state; unsafe paths/tool requests are rejected; existing-data migration and end-to-end navigation/chat/upload/RAG/MCP checks pass. Required before production deployment.

## Verification gate for every implementation task

Run relevant lint/typecheck/tests and affected-flow checks per `AGENTS.md`. Preserve backend memory/RAG/MCP coverage; add focused tests for new persistence, scope and lifecycle behavior. Report exact files, commands/results and unmet criteria. Do not proceed to another subphase to conceal a failure.
