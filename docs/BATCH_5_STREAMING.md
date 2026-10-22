# Batch 5: streaming and execution reliability

## Compatibility plan

Preserve the existing LangGraph graphs, provider adapters and SSE `start`,
`token`, `done`, `error` contract. Tighten parsing and request cleanup without
changing successful payloads. Add frontend-only `cancelled` message status and
optional safe error metadata; existing saved messages remain readable.

Serialize writes to an authorized conversation across local workers using a
thread execution lease in the existing SQLite `leases` table. No database schema
or ownership migration is required. A competing execution receives HTTP 429 with
Retry-After; it is never queued for automatic replay. Ordinary rate/quota counters
retain their existing accounting and reset rules.

Cancellation keeps already displayed partial text in browser history, marked
cancelled. Checkpoints retain only graph steps already committed. Cancellation
does not synthesize an assistant checkpoint or automatically resume pending tools.
No existing checkpoints, threads, attachments or backups are rewritten.

## Existing behavior preserved

The user previously verified progressive Nemotron 3 Super SSE events and rendering
in Chrome. That is historical evidence, not a live test performed in this batch.
The existing architecture remains: authenticated fetch, FastAPI authorization and
usage admission, a cached LangGraph graph, provider streaming, SSE deltas and
message-local rendering. No completed response is split to simulate streaming.

Google/Groq retain their SDK streaming methods. OpenRouter retains its async HTTP
stream parser, endpoint validation and zero-price routing. Model selection,
provider consent, all 13 registry entries, input budgets and disabled paid fallback
remain intact. LangGraph still selects Normal/Research prompts and tools, persists
authorized checkpoints and uses request-scoped personalization and memory. Tool
results retain the untrusted-content encoding and RAG citation/inspector metadata.

The existing final-message fallback remains for providers that supply a completed
message without token events. Message IDs prevent replaying a final message that
was already streamed. A graph producing no answer now emits an error instead of a
successful empty completion.

## Confirmed defects and fixes

| Finding | Root cause and correction |
| --- | --- |
| Partial streams silently completed | Both parser EOF handling and the hook accepted closure after partial text. EOF now requires a complete terminal frame; partial content is retained with an error. |
| Malformed frames disappeared | JSON/schema errors were ignored. Recognized malformed frames now produce a fixed protocol error without reflecting payloads. UTF-8 decoding is incremental and strict; incomplete frames are bounded to 1,048,576 characters. |
| Cancelled answers appeared complete | Stop assigned `complete`. It now retains received text with `cancelled` status and a short stopped label. Restored interrupted snapshots also lose stale streaming indicators. |
| Late callbacks and unmounts | The hook lacked unmount cleanup and guarded some settlements only by message ID. It now aborts on unmount and requires the exact active request object for callbacks and final cleanup. |
| Per-token render churn | Every delta updated message state. Deltas are coalesced at 32 ms intervals; completion/error/Stop flush received text immediately. |
| Network reader remained open | Parsing did not own a reader cleanup boundary or stop at terminal events. It now cancels/releases its reader in `finally`; authenticated body cancellation aborts its fetch as well. |
| Preparation continued after disconnect | StreamingResponse started listening only after route preparation. One request-level receive pump now observes disconnect during preparation and generation. |
| Real graph children outlived cancellation | Starlette's ASGI 2 response task group repeatedly cancelled async graph cleanup. The chat response uses the request's single disconnect watcher and edge cancellation; explicit generator closing lets LangGraph cancel and settle children before leases are released. |
| Concurrent checkpoint writers | Two admitted requests could run the same conversation concurrently. An atomic SQLite thread lease rejects the second request before graph preparation/execution, across model/mode choices and local workers. |
| Incomplete tool calls poisoned the next prompt | Cancellation can commit an AI tool request without its results. The next provider view retains completed call/result pairs and omits unfinished pairs; raw stored history is preserved and pending tools are not replayed. |
| Session errors lost their category | An expired/revoked active session used the generic ownership error. It now has a safe 401 category, preserved through provider mapping and SSE; frontend SSE 401 handling invalidates the matching session. Foreign-resource failures retain generic 404 behavior. |

No automatic retry, provider substitution, new agent graph or broader edit/history
redesign was introduced. Existing user-triggered edit/retry actions retain their
prior semantics and remain separate from cancellation recovery.

## SSE contract

The HTTP request remains `POST /chat/stream` with its existing chat JSON, cookie,
Origin and CSRF requirements. Successful streaming uses `text/event-stream`,
`X-Accel-Buffering: no`, and UTF-8 frames:

```text
event: token
data: {"text":"exact delta, including whitespace"}

```

| Event | Existing payload and meaning |
| --- | --- |
| `start` | `{thread_id}` after admission/preparation |
| `token` | `{text}` for visible chatbot text; reasoning/tool arguments are not answer text |
| `done` | `{thread_id, inspector}` after successful graph completion; does not repeat answer text |
| `error` | `{message, thread_id, status_code?, retry_after?}`; terminal failure with a fixed safe message |

Authentication, CSRF, ownership, availability, quota or preparation errors may be
ordinary HTTP errors before SSE headers. The existing image-capability rejection
can emit an error-only SSE response. Errors after headers produce one `error` and
no `done`. Disconnect/cancellation emits neither successful completion nor a fake
error to an unavailable client. Unknown event types/comments are ignored, never
rendered as answer text. A terminal frame stops further event delivery. Recognized
thread IDs must match the requested/started conversation.

The frontend preserves HTTP status and Retry-After in `ChatStreamError`, retains
SSE error metadata, displays retry guidance once, and never automatically retries.
OpenRouter endpoint outages keep their existing 503 routing category; other
provider failures/timeouts retain the existing sanitized status mapping.

## Cancellation and execution ownership

The authentication middleware retains its complete-request usage budget. Inside
it, `run_chat_request` creates one application task and a bounded receive queue.
Disconnect cancels only that task and then waits for cleanup. The request-local
execution context is inherited by graph tasks and supported worker threads.
Already-stopped worker contexts cannot start another budgeted operation.

After resource authorization, a thread lease in the existing usage database
covers preparation, graph work and response cleanup. It is independent of the
ordinary chat/provider/tool counters. Its operation key is `thread:<thread_id>`.
Concurrent writers receive 429 with `Retry-After: 5`. Threads cannot select an
owner through JSON/config. Dead-worker/PID-reuse checking uses the same local
process-identity approach as Batch 4B-2. Live leases do not expire by age. There is
no migration or public lock-reset endpoint.

Generator cleanup precedes release of the thread lease. Every request releases
only its own lease IDs. Admitted cancelled attempts still consume rate/daily
quota; individual tokens do not consume inference units. Synchronous operations
already dispatched to a worker retain their own concurrency slots until they
actually finish, even if the HTTP request has gone away. Owner/execution contexts
reset after response settlement; retained worker contexts are marked stopped.

Stop preserves received partial text locally and marks it cancelled. Failed
streams preserve partial Markdown with a separate error message/category. Neither
is labelled as a fully completed answer. Existing checkpoint transactions that
committed before cancellation remain available. Uncommitted token text is not
invented as a completed assistant checkpoint. A new user request starts a new
graph input; unfinished tool calls are excluded only from its provider view.

## Verification

All automated checks use mocked providers, controlled async streams and isolated
temporary databases. No real inference, OAuth exchange, owner setup, ownership
migration or browser session was performed. Existing user data and backups were
not rewritten.

| Check | Command | Result |
| --- | --- | --- |
| Affected auth/ownership/model/usage | `.\.venv\Scripts\python.exe -m pytest tests/test_models.py tests/test_usage_limits.py tests/test_auth.py tests/test_ownership.py -q -W error::RuntimeWarning --tb=short` | 198 passed |
| Lifecycle, usage and MCP security | `.\.venv\Scripts\python.exe -m pytest tests/test_streaming_lifecycle.py tests/test_usage_limits.py tests/test_mcp_isolation.py tests/test_mcp_compatibility.py -q -W error::RuntimeWarning --tb=short` | 107 passed before the final two real-stream regressions were added |
| Real graph progressive streaming | `.\.venv\Scripts\python.exe -m pytest tests/test_streaming_lifecycle.py::test_real_graph_uses_one_progressive_model_stream -q -W error::RuntimeWarning --tb=short` | 2 passed |
| Full backend | `.\.venv\Scripts\python.exe -m pytest -q -W error::RuntimeWarning --tb=short` | 663 passed, 2 historical failures, 27 existing deprecation warnings; 665 collected; 365.49 seconds |
| Frontend | `npm test` | 65 passed |
| TypeScript | `.\node_modules\.bin\tsc.cmd --noEmit --incremental false` | Passed |
| ESLint | `npm run lint` | Passed |
| Production build | `npm run build` | Passed; 12 static pages |
| Python compilation | `py_compile.compile(..., doraise=True)` over backend root/tests | 42 files passed; no application imports |
| Git | `git diff --check`, `git diff --stat`, `git status --short` | Checked; final summary below |

Backend commands run from `backend`; frontend commands from `frontend`.
The build ran outside the known Windows sandbox canonicalization restriction.
No dependencies were installed or upgraded. Python formatters/linters are not
installed; changed Python sections received manual review and compilation.
Focused runs overlap the full suite and must not be added to its count.

The 26 new backend cases cover progressive ASGI delivery, exact Unicode/Markdown
text, real LangGraph/LangChain streaming in both modes, one provider invocation and
quota charge, pre-token/midstream/preparation cancellation, send failures,
same-thread exclusion and fresh requests, concurrent SQLite stores, session
revocation, synchronous-worker limitations, MCP reuse and real graph cancellation
with checkpoint recovery. Existing tests continue to cover provider SDK errors,
OpenRouter HTTP transport, authentication/CSRF, ownership, uploads, free-model
guards, tool budgets and connector credential isolation.

The 19 new frontend cases exercise the actual parser/API/hook modules. Controlled
hook stubs verify handlers, batching, unmount cleanup and stale settlements; React
server rendering verifies partial-code and cancelled/error presentation. Existing
Markdown tests retain code rendering/copy checks. These are not browser DOM E2E
tests and do not establish animation smoothness on a real device.

Two known historical tests still expect the absent local MCP tool:

- `tests/test_mcp.py::test_local_mcp_server_discovers_project_status_tool`
- `tests/test_mcp.py::test_local_mcp_project_status_tool_executes`

Their failures remain separately reported; no test or security assertion was
removed or weakened.

**Final verdict — 2026-10-21: PASS for Batch 5's automated acceptance criteria.**
There are no newly introduced failures. The full pytest command still exits 1
because of the two acknowledged historical MCP tests. Runtime warnings were
treated as errors; none failed. The 27 remaining warnings concern the existing
Starlette/httpx test client and `datetime.utcnow()` calls, which were left intact.
Final review removed an unused import and added type annotations; compilation
was repeated after that nonfunctional cleanup. No live inference, OAuth exchange,
browser testing or production-readiness claim is part of this verdict.

## Remaining limitations and deferred combined browser checks

Cancellation is cooperative. It cannot reverse an external action already sent,
interrupt arbitrary synchronous Python/native code, or prove that a remote
provider stopped billing/processing. Already-dispatched sync catalog, retrieval,
embedding or tool work may finish; local liveness checks prevent subsequent
operations. The local SQLite design assumes one host and a trusted clock/process
identity. Batch 4B-2's one-worker recommendation for in-memory MCP/OAuth state
still applies.

There is no new request-idempotency protocol: deliberately sending another
request after completion is another admitted execution. Concurrent same-thread
requests are rejected, not queued or automatically replayed. Cross-thread
workspace memory retains its existing database transaction behavior. Local
partial display text can differ from the last fully committed graph checkpoint.

Manual browser testing is deferred until after Batch 5. For the combined session:

1. Sign in with the existing owner and verify old conversations, projects,
   personalization, attachments and citations remain present.
2. With separately authorized free inference, observe progressive token timing
   and one terminal `done` for an eligible model. Check long Markdown/code, Unicode
   and Copy. Do not infer current provider availability from offline results.
3. Stop before first text, during text and during a supported tool operation.
   Confirm a stopped label, no later text, responsive controls and a fresh request
   succeeding without refresh. Repeat after switching conversations and unmounting.
4. In an isolated test setup, induce HTTP quota/concurrency failures, midstream
   provider errors, malformed/truncated SSE and session expiry. Confirm accurate
   messages, retry hints, login gating and recovery; do not exhaust real quotas.
5. Submit concurrently to the same test thread and verify one retryable rejection.
   Confirm no duplicate tool action and no transcript contamination. Confirm
   connector disconnect/reconnect and subsequent requests remain owner-scoped.
6. Check themes, narrow layouts, code Copy and scroll behavior in the browser.
   No visual redesign or live browser verification is claimed by this batch.

## Files changed in Batch 5

Created:

- `backend/chat_execution.py`
- `backend/tests/test_streaming_lifecycle.py`
- `frontend/tests/streaming.test.mjs`
- `docs/BATCH_5_STREAMING.md`

Modified:

- `backend/agent.py`
- `backend/app.py`
- `backend/auth.py`
- `backend/models.py`
- `backend/ownership.py`
- `backend/untrusted_content.py`
- `backend/usage_limits.py`
- `frontend/components/chat/AssistantMessage.tsx`
- `frontend/components/chat/Message.tsx`
- `frontend/hooks/useChat.ts`
- `frontend/lib/api.ts`
- `frontend/lib/auth.ts`
- `frontend/tests/register-tsx.mjs`

All 17 files were reviewed for readable naming, focused changes, comments, typing
and formatting. Existing unrelated formatting and all prior changes were retained.
The accumulated tracked diff currently reports 27 files, 4,183 insertions and
4,459 deletions. It includes earlier batches and excludes untracked files; it is
not a Batch 5-only count. No commits, pushes, resets, stashes or branch changes
were performed. No `.env`, real database, backup or account setup changes were made.
