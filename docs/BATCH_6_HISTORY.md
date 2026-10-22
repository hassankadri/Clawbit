# Batch 6: persistent conversation history

## Preflight and compatibility plan

The existing browser stores standalone summaries in `clawbit.conversations.v1`
and project snapshots in `clawbit.projects.v1`. UI conversation IDs differ from
the checkpoint thread ID. Message IDs are generated in the browser. The shell
retains only 12 standalone snapshots and writes updates during streaming.
The backend chat routes append new user messages to LangGraph but do not call
the SQL conversation/message helpers. Editing and retrying trim only the UI;
their next request appends into the original checkpoint and loses attachment
references. Batch 5 already handles cancellation, disconnect and thread leases.

This work implements the durable-conversation scope of Phase 6.2. Existing
authentication, ownership, quotas, graph execution and streaming remain in use.
New versioned tables in the existing SQLite runtime will hold canonical visible
history and retained revisions. Schema initialization must back up an existing
database before its additive migration. No legacy tables or checkpoints are
deleted or recreated, and the completed ownership claim is not repeated.

Each turn has a stable request ID and message IDs. Admission is transactional;
duplicate requests cannot dispatch inference again. Conversation versions reject
stale mutations. Edits and regeneration create candidate revisions and retain
the previous active history until success. Normal turns preserve partial/error
records. Model context is reconstructed from completed canonical turns using
LangGraph's message replacement reducer, retaining prior checkpoints as history.
Replay operations disable tools, including internal memory writes, so neither
old tool calls nor newly inferred external actions execute during regeneration.

Browser history remains available without automatic upload or erasure. Explicit
owner-confirmed imports are transactional per conversation, idempotent and
conflict-detecting. An interrupted multi-conversation import can be retried.
Existing thread, workspace, UI and message identifiers are retained.

## Implemented persistence and API

The current UI uses authenticated server history. `useChat({persistent: true})`
creates metadata before its first turn and sends a request ID, stable message
IDs and the last observed history version. The backend commits a turn receipt
before dispatching the graph, periodically stores partial text and commits the
terminal result before emitting `done`. The frontend reconciles against the
saved result, guards late callbacks after navigation, and retains unsaved input
with an error if admission failed. Reloading history never dispatches inference.

Existing `/chat` and `/chat/stream` clients without `request_id` keep their
previous checkpoint behavior. They do not acquire durable visible-history
receipts; non-send revision operations require the new contract. All current
AppShell sends, edits and retries use the persistent path. Direct callers must
adopt that contract to receive its idempotency and history guarantees.

The database remains `data/chatbot_memory.db` under `CLAWBIT_RUNTIME_DIR` (the
backend directory by default). Three additive tables are initialized lazily:

| Table | Stored fields and constraints |
| --- | --- |
| `history_schema` | Version 1; unknown versions fail without rewriting data. Separate from legacy `PRAGMA user_version`. |
| `history_conversations` | Stable thread, workspace and UI display IDs; title, pin, model, mode, creation/update milliseconds, optimistic version, active revision and deletion tombstone. Thread ID is the primary key. |
| `history_revisions` | Revision and parent IDs, thread foreign key, request ID and request fingerprint, operation, state, visible message JSON, timestamp and completed checkpoint ID. `(thread_id, request_id)` is unique. |

Indexes cover conversation ordering/workspace and revision thread ordering.
The existing ownership registry remains the authority: queries filter to the
verified principal's threads; individual operations validate the thread and
workspace. No browser identity, request owner field or second owner registry
can grant access. List queries join active revisions for previews without
fetching every message collection separately.

Visible messages contain stable IDs, user/assistant role, text, status,
creation time, attachment IDs, file/page citations and safe error metadata.
Raw tool messages, credentials, provider exceptions and checkpoint internals
are not exposed by history endpoints. Imports validate their schema and
attachment ownership. Input limits are 2,000 messages, 3,000,000 aggregate text
characters, 1,000,000 per message, ten attachment references per message, and a
4 MiB HTTP body bound for history POST/PATCH. The aggregate limit is checked
when admitting a turn or import; generated output can exceed the remaining
allowance, after which another turn must use a new conversation.

| Route | Contract |
| --- | --- |
| `GET /history` | Owned, nondeleted conversation metadata/previews plus owned deleted thread IDs. Pinned first, then most recently updated. |
| `POST /history` | Create metadata with `thread_id`, `workspace_id`, UI `id`, title, model and mode. Same identifiers are idempotent; conflicting aliases/tombstones return 409. |
| `GET /history/{thread}` | Canonical messages/version and `running` indicator. Recovers abandoned receipts only after obtaining the existing thread lease. An active lease permits reading durable progress without recovery. |
| `PATCH /history/{thread}` | Versioned title, pin or workspace change. New workspace must belong to the principal or be newly claimed through the existing registry. |
| `DELETE /history/{thread}?version=N` | Soft-delete active history; retain revisions, ownership, checkpoints and attachments. |
| `GET /history/{thread}/revisions` | Revision metadata, without loading every revision payload. |
| `GET /history/{thread}/revisions/{revision}` | Visible messages from an owned revision of this exact thread. |
| `DELETE /history/{thread}/messages/{message}?version=N` | Retained revision that truncates the selected message and its dependent suffix. No inference. |
| `POST /history/{thread}/import` | Explicit `confirmed_principal`, version, stable `import_id`, messages and original update timestamp. No overwrite on conflicts. |
| `POST /chat` or `/chat/stream` | Persistent turns add `request_id`, `expected_version`, user/assistant message IDs, operation and optional target message ID. Client checkpoint IDs are rejected. |

History mutations keep session, Origin and CSRF middleware. Invalid/foreign IDs
fail closed; stale versions and conflicting request bodies return 409. The
existing chat admission, provider, tool and concurrency quotas remain in force.
Ordinary history reads consume no model/tool quotas. Same-thread mutations use
the Batch 5 execution lease, so an edit cannot race an active stream.

## Revision and checkpoint semantics

Normal sends append a user/assistant pair and make that pending revision active.
Edits address a user message ID and retain its attachment references. Retry
addresses an unsuccessful assistant response; regenerate addresses a completed
one. Both use its preceding user exactly once and discard the target response
and all later turns from the candidate context. The currently selected model
and mode are used; the persisted workspace is authoritative.

Each revision operation retains the previous active revision until successful
completion. A failed or cancelled candidate remains viewable through Saved
revisions, while the original valid branch stays active. Message removal also
creates a retained revision. The UI offers revision inspection, not automatic
branch activation or tool replay.

The graph uses the same stable thread ID. Its input starts with LangGraph's
`RemoveMessage(REMOVE_ALL_MESSAGES)` reducer operation followed by canonical
completed user/assistant pairs and the intended user prompt. This deliberately
reconstructs visible context instead of resuming a potentially interrupted tool
node or pretending to rewind external effects. Earlier checkpoints remain in
the existing checkpoint store; a successful receipt records the new checkpoint
ID. A failed candidate checkpoint does not become the next prompt: the next
admitted turn rebuilds context from the active visible revision.

Edit/retry/regenerate invoke the model without bound tools and reject any tool
calls it nevertheless returns. This includes internal memory writes. A new
explicit user message is required for tool execution. Normal sends retain the
existing tool path. Real compiled LangGraph fixtures cover both normal and
research modes, editing an earlier turn, regeneration, failed revision recovery,
and exactly one initial external-write fixture without replay.

Current-turn attachment IDs are loaded again through ownership-checked RAG
helpers, including on edits/retries. Citations are stored as file/page metadata.
Previous visible answer text is reconstructed, but raw historical tool results
and earlier image bytes are not replayed. Tool-free regeneration therefore may
have less retrieval context than the original answer; it must not imply that
external work was repeated or reversed. Moving a conversation changes its
workspace metadata for future execution; it does not migrate old memory or
attachment bytes.

## Cancellation, failures and recovery

Partial output is persisted at most once per 250 ms during generation and
flushed on normal cancellation/error cleanup. A hard process crash can lose
the unflushed tail, but never marks an unfinished receipt complete. Recovery
marks abandoned running receipts cancelled after obtaining the thread lease;
it never resumes inference or MCP actions. Transport failure before the first
SSE frame also finalizes the receipt and releases concurrency slots.

The frontend aborts its reader on Stop/navigation/logout, reconciles durable
status, and briefly polls a still-running receipt after cancellation. There is
no automatic inference retry. A server that takes longer than this bounded
polling period may require Reload history; a concurrent request remains blocked
by the server lease. Failed/cancelled turns are excluded from future prompts.

SQLite writes use `BEGIN IMMEDIATE`, foreign keys and rollback on exceptions.
Schema initialization uses SQLite's backup API (including committed WAL data)
to create `<database>.history-<time_ns>.backup` before altering an existing file.
Initialization and backup behavior are tested with isolated legacy fixtures,
including integrity checks, unsupported schema versions, aborted writes and
concurrent identical requests. No real database migration or backup restoration
was executed during this task.

If a history payload is invalid, reads return a safe 503 and retain the original
records; metadata listing can still show the conversation. Do not delete or
reinitialize a database to repair an error. Stop the application before recovery,
copy the complete runtime directory and preserve the damaged file and backups.
Inspect/repair a separate copy with SQLite integrity and foreign-key checks.
Restore an agreed consistent runtime snapshot only as a separately authorized
operation; reverting just the history database can disagree with checkpoints,
ownership and attachments. Soft-deleted payloads remain recoverable by a scoped
repair, but no user-facing undelete API is implemented.

## Legacy browser history

Actual browser migration remains deferred until after Batch 8. The existing
ownership claim of 93 resources is unchanged and was not rerun. Legacy backend
tables and checkpoint files remain intact. A thread with legacy message rows or
checkpoint data but no imported visible revision cannot silently start over;
the server returns an explicit import requirement.

The Import browser history control asks for confirmation and checks the current
authenticated principal against the already-established browser owner marker.
The backend separately validates its authenticated owner and all resource IDs.
Each conversation import is transactional and uses a stable import receipt and
content fingerprint. Repeating an unchanged import is safe; conflicting content
gets 409. A partial multi-conversation import can be retried, without automatic
overwrite. A metadata row may remain empty if its subsequent import fails.

`clawbit.conversations.v1` and `clawbit.projects.v1` are not rewritten or erased.
Project working snapshots use `clawbit.projects.v2`; malformed project data
pauses those local writes. Invalid local records produce a visible error rather
than escaping hydration or triggering a destructive replacement. Import failure
notices remain visible. Original timestamps, message IDs, thread/workspace
associations and attachment references are retained; missing old message times
use the conversation's original update time. Interrupted browser messages become
cancelled. No automatic inference is part of import.

The server catalog supplies Recent/Search and pins without the previous
12-conversation truncation. Search retains the existing title/preview behavior;
it is not full-text indexing of every message. Server conversations are visible
even if this browser lacks their local project definition. Project metadata and
files remain the existing local project implementation; broader project storage
is outside Phase 6.2. New Chat stays empty, and restoration selects the saved ID
or the selected project's own conversation rather than another workspace.

## Verification

Final automated verification on 2026-10-21:

| Working directory / command | Result |
| --- | --- |
| `backend`: `.\.venv\Scripts\python.exe -m pytest tests/test_history.py tests/test_auth.py tests/test_ownership.py tests/test_streaming_lifecycle.py -q -W error::RuntimeWarning --tb=short -o faulthandler_timeout=90` | 115 passed at the focused checkpoint, before three additional history cases. |
| `backend`: `.\.venv\Scripts\python.exe -m pytest tests/test_history.py -q -W error::RuntimeWarning --tb=short` | 24 passed; one existing TestClient deprecation warning. |
| `backend`: `.\.venv\Scripts\python.exe -m pytest -q -W error::RuntimeWarning --tb=short -o faulthandler_timeout=90` | **687 passed, 2 historical failures, 27 deprecation warnings**, 332.05 seconds. |
| `frontend`: `npm test` | **79 passed**, no failures/skips. |
| `frontend`: `.\node_modules\.bin\tsc.cmd --noEmit --incremental false` | Passed. |
| `frontend`: `npm run lint` | Passed, no diagnostics. |
| `frontend`: `npm run build` | Passed; all 12 pages generated. |
| Root: Python `compile(path.read_bytes(), str(path), 'exec')` over `backend/*.py` and `backend/tests/*.py` | All **46** application/test files passed without importing runtime state. |
| Root: `git diff --check` | Passed. All 16 batch files also checked for readable UTF-8, trailing whitespace and final newlines, including untracked files. |

The focused runs overlap the final suite and are not added to its count. Relative
to the supplied baseline, there are 24 additional backend and 14 additional
frontend tests. The full suite includes authentication, two-way ownership,
upload/RAG, free-model registry, MCP isolation/OAuth, quota/concurrency and
streaming regressions. Tests use temporary runtime stores, dummy credentials,
disabled dotenv loading and an external-network guard; no user data or live
providers are involved.

The two unchanged historical failures are:

- `tests/test_mcp.py::test_local_mcp_server_discovers_project_status_tool`:
  the tool catalog does not contain `get_project_status`.
- `tests/test_mcp.py::test_local_mcp_project_status_tool_executes`:
  selecting that absent tool raises `StopIteration` inside the coroutine.

The 27 warnings are existing `datetime.utcnow()` and TestClient deprecations;
runtime coroutine warnings were configured as errors. No dependency upgrade or
unrelated MCP implementation was introduced to conceal these failures.

Final review covered API ownership/CSRF, message and checkpoint identifiers,
tool-free replay, terminal-state persistence, SQLite rollback/backup behavior,
stale browser callbacks, malformed local data and the changed-file manifest.
Installed ESLint/TypeScript checks were used. Black/Ruff/autopep8 were not
installed, so Python formatting was reviewed directly without installing tools.

**Verdict: PARTIAL overall.** Batch 6 implementation and automated verification
are finished with no new failing tests. The full repository suite is not green
because of the two historical MCP failures. Actual browser imports and the
explicitly deferred end-to-end browser/provider checks remain outstanding.

## Remaining limitations and deferred browser checks

- Visible history, LangGraph checkpoints and an external provider/tool cannot
  share one atomic transaction. Receipts prevent duplicate dispatch for the same
  request ID; a hard crash cannot prove whether an upstream action completed.
  Recovery never automatically repeats it. A user-created retry has a new ID.
- Revisions store full message snapshots. Per-conversation input bounds limit
  each snapshot, but many revisions grow storage; no retention/compaction job or
  conversation pagination is included.
- The old nonpersistent chat contract remains supported for compatibility.
  Backend-only legacy checkpoints are preserved, not automatically converted
  into user-visible conversation records.
- SQLite/runtime files rely on existing host filesystem protection; this batch
  does not add encryption at rest. Existing single-worker MCP credential and
  browser-profile limitations remain as documented in Batches 4A–5.
- No live inference, external MCP actions, actual browser imports or manual UI
  testing were performed. No production-readiness claim is made.

After Batch 8, with separate authorization for any live inference:

1. Use the initialized owner's existing browser profile. Save an export/copy of
   local history and the runtime before exercising imports. Verify the expected
   thread IDs and project associations without rerunning ownership migration.
2. Explicitly import browser history, repeat it, and verify conflict handling.
   Confirm the original v1 keys remain unchanged and no other account can read
   imported resources.
3. Create a chat, pin/rename it, switch chats/projects, reload and restart the
   backend. Verify IDs, model/mode, ordering, selected chat, attachments and
   citations. New Chat must remain empty until input.
4. Edit an earlier message, regenerate a completed response and retry a failed
   one. Inspect Saved revisions and verify downstream text is absent from the
   new context. Confirm no MCP write is replayed.
5. Stop before tokens and mid-response; disconnect/reload and exercise backend
   interruption. Confirm partial/cancelled status, old revision preservation and
   concurrency release. Observe stale navigation and session-expiry behavior.
6. Exercise removal and soft deletion, confirming active UI state clears while
   revision/checkpoint/upload files remain. Check search and project moves;
   old memory/files must not be presented as migrated data.

## Batch-specific file manifest

Created: `backend/history_store.py`, `backend/history_api.py`,
`backend/history_chat.py`, `backend/tests/test_history.py`,
`frontend/lib/history.ts`, `frontend/tests/history.test.mjs`,
`frontend/tests/hook-harness.mjs`, `docs/BATCH_6_HISTORY.md`.

Modified: `backend/app.py`, `backend/agent.py`, `backend/auth.py`,
`backend/tests/conftest.py`, `frontend/hooks/useChat.ts`, `frontend/lib/api.ts`,
`frontend/components/layout/AppShell.tsx`, `frontend/tests/streaming.test.mjs`.
The shared hook harness was extracted without dropping streaming assertions.
Other dirty/untracked files predate this batch and were retained. No dependency,
`.env`, ownership-claim, credential, user-data or Git-history changes were made.

Final `git diff --stat` for the entire existing working tree: **28 tracked files,
4,636 insertions, 4,968 deletions**. This includes earlier batches and excludes
untracked files; it is not a Batch 6-only diff. The batch-specific manifest above
contains eight created and eight modified files. `git status --short` was
reviewed, and the branch remains `checkpoint/clawbit-pre-release-qa`.
