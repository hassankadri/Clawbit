# Batch 4B-2: connector isolation and usage controls

## Compatibility and persistence decision

Connector credentials remain in memory, indexed by the verified session's
principal. Restart requires reconnection with existing credentials; no new keys
are required. Installation-wide environment tokens are not automatically claimed
by a signed-in user. Existing token connection endpoints accept those same tokens
explicitly. OAuth client configuration remains installation configuration.

The only new persistent store is `data/usage.sqlite3` inside
`CLAWBIT_RUNTIME_DIR`. It stores principal-scoped operation counts, time windows
and concurrency leases, plus connector revocation versions. It never stores
prompts, credentials, token estimates or costs.
Existing authentication, ownership, conversation, checkpoint and upload schemas
are unchanged. The completed ownership claim must not be rerun.

Successful HTTP and SSE contracts remain unchanged. Rejections use HTTP 429 with
`Retry-After`, or the existing SSE `error` event after response headers.

## Credential and OAuth boundaries

GitHub, Notion, Stripe, Google Drive and Slack connection state, discovery caches,
tool handles and errors belong to the authenticated principal. A model-supplied
principal, thread ID or tool configuration cannot select another user's secrets.
Cached graph tools retain metadata and an owner/generation check, not a raw
credential-bearing tool. OAuth tools are rediscovered with the current token when
executed. Disconnect invalidates handles and cancels this worker's active sessions
for that connector. Failed connection attempts preserve an existing good connection.

The SQLite connector generation supports transactional compare-and-set on connect,
refresh and disconnect. Another local worker's revocation invalidates stale
credentials on the next check. A stale refresh cannot restore a disconnected
credential or revoke a newer connection. Credentials themselves are not shared
between workers: use one backend worker for consistent connection and OAuth state.

OAuth state is random, single-use, expires after 600 seconds and is bound to the
principal, initiating session, provider and connection generation. There are at
most 32 pending states per principal. Google uses PKCE S256. Slack retains its
provider-specific flow and requires an HTTPS callback. Completion checks the
session before exchange and again before saving. Denied, expired, mismatched or
replayed callbacks cannot overwrite a valid connection. Google refresh is
serialized per principal/provider; unusable or revoked credentials require
reconnection. The expiry skew is 60 seconds. Slack expiry requires reconnection.

OAuth exchanges use fixed provider endpoints, reject redirects and bound response
reading to 1 MiB. Public errors omit provider bodies, codes and credentials.
Retain the documented backend startup option `--no-access-log`: OAuth callback
query strings contain authorization codes. Reverse proxies must also omit those
query strings from access logs. Do not enable SDK HTTP-body or credential tracing.
Connector POST bodies are limited to 16 KiB. Token credentials are limited to 4,096
characters and reject newlines and SDK environment interpolation syntax. Notion
and Stripe receive only their own explicit secret in their subprocess environment,
in addition to the MCP SDK's inherited process essentials. Installation tokens
are never implicitly assigned to a user.

The existing authentication, CSRF, cookie, logout and ownership boundaries remain
in force. Credential operations recheck the initiating session. Logout revokes the
session; it does not delete the principal's connector settings from memory. A later
valid login as that same principal can use them until disconnect or restart.

## Limits and reset rules

Defaults apply independently to each verified principal:

| Operation | Per UTC minute | Per UTC day | Concurrent per user | Concurrent globally |
| --- | ---: | ---: | ---: | ---: |
| Chat request | 20 | 500 | 2 | 4 |
| Model inference | 40 | 1,000 | 2 | 4 |
| Embedding request | 60 | 2,000 | 2 | 4 |
| Upload request | 10 | 100 | 2 | 4 |
| Document ingestion | 10 | 100 | 1 | 2 |
| RAG retrieval | 60 | 2,000 | 2 | 4 |
| MCP management/discovery | 30 | 500 | 2 | 4 |
| MCP tool execution | 60 | 1,000 | 4 | 8 |
| Built-in tool operation | 60 | 2,000 | 4 | 8 |

Global minute and daily ceilings are four times the configured per-user ceiling
for each operation. A response may request at most 12 tool calls, across all of
its model/tool rounds. The complete next tool-call batch must fit before execution.

Minute windows reset at the next UTC minute boundary; daily windows reset at UTC
midnight. They are fixed windows, not sliding windows. Restart does not reset
either counter. Rejected admissions do not increment counters. Once admitted,
failed or canceled attempts still count. Changing a thread or client-supplied
identity does not reset a user's usage.

HTTP chat and upload admission happens before body processing. Provider inference,
embedding, ingestion, retrieval and tool boundaries have their own budgets.
Nested calls implementing the same logical operation share its lease: an SDK's
generate-to-stream delegation is counted once, and SSE tokens are not counted as
requests. Each document embedding SDK batch is separately admitted before its
provider request. A chat can consume several inference and tool units.

The tool-response cap applies to a whole response. Its 60-second retry hint does
not renew that response's budget; a new response receives a new budget. Rate and
quota hints reflect time remaining to the relevant boundary. Concurrency
rejections suggest retrying after five seconds. The frontend displays retry
guidance once and does not automatically retry failed work.

Disconnect and logout remain available when management limits are exhausted.
Health and session inspection are outside these usage budgets. Existing login
throttling remains separate.

### Configuration

Set positive integer process environment values before backend startup:

```text
CLAWBIT_LIMIT_<OPERATION>_PER_MINUTE
CLAWBIT_LIMIT_<OPERATION>_PER_DAY
CLAWBIT_LIMIT_<OPERATION>_CONCURRENT
CLAWBIT_LIMIT_<OPERATION>_GLOBAL_CONCURRENT
CLAWBIT_TOOL_CALLS_PER_RESPONSE
```

Operation names are `CHAT`, `INFERENCE`, `EMBEDDING`, `UPLOAD`, `INGESTION`,
`RETRIEVAL`, `MCP`, `MCP_EXECUTION` and `TOOL`. For example,
`CLAWBIT_LIMIT_UPLOAD_PER_MINUTE=10` preserves the upload default. There is no
zero/unlimited setting. Every worker using the same store must have the same
configuration. No `.env` file was changed for this batch.

Existing upload bounds also remain: 10 MiB per file, 10 attachments per thread,
1,000,000 extracted characters and 1,500 chunks per document. Daily ingestion and
upload quotas bound growth over time; they are not lifetime storage quotas.

### Persistence and concurrency

SQLite `BEGIN IMMEDIATE` admits the user/global counters and concurrency lease
atomically. Multiple local processes must use the same runtime directory and
SQLite database. Operation cleanup releases leases on completion, errors and
SSE cancellation. Leases record process identity and creation time; a subsequent
admission reaps a dead worker or reused PID. Active leases never expire merely
because an operation is slow. An inaccessible process is not assumed dead.
The process identity implementation supports Windows and Linux; other platforms
need an appropriate implementation before deployment.

Previous windows are pruned during admission. There is no public quota reset
endpoint. Do not delete the usage database to recover capacity: it also contains
connector revocation generations. The host clock and local database integrity are
trusted. This store is intended for one host, not a distributed/network-filesystem
deployment.

## Compatibility and free-tier protections

No conversation, attachment, memory or checkpoint migration was introduced.
Existing thread IDs, references and ownership records are preserved. Tests use
temporary runtime directories and offline fixtures; the completed ownership
migration was not rerun.

Google/Groq free-account attestations and key fingerprints, the model allowlist,
provider consent and OpenRouter zero-price endpoint checks remain unchanged.
There is no paid fallback. Quotas are local request limits, not billing guarantees
or a measurement of provider token consumption.

The optional `model_smoke.py` command now also requires interactive login as the
existing owner so its requests cannot bypass quotas. It creates and revokes only
its own temporary session. The existing `--allow-free-inference` opt-in remains
required. No live inference was performed during this batch.

## Upload capacity regression

The capacity test previously sent ten accepted uploads and then immediately
expected attachment number eleven to return HTTP 409. The new, correct admission
control returns HTTP 429 first because uploads are limited to ten per minute.
This was a test interaction, not a broken storage limit.

The test now uses a deterministic usage-store clock, verifies ten stored
attachments, advances one minute, and retains its 409 assertion. It also retains
foreign-thread deletion rejection, owned deletion, and replacement upload checks.
Independent tests reject over-limit upload work before processing and verify that
ingestion quota rejection preserves committed files, manifests and cleanup state.
No production limit or security assertion was removed.

The final caller review also found that Google Drive and Slack disconnect helpers
had lost the async contract awaited by their HTTP routes. Both helpers are async
again. New authenticated HTTP tests verify successful disconnect under an
exhausted MCP management quota, token removal, cache clearing and rejection of a
previously obtained tool handle.

## Verification

Verification date: 2026-10-21. All backend tests use isolated data and mocked
providers; no real third-party credential exchange or inference was performed.

Commands below run from `backend` unless marked frontend:

| Check | Command | Result |
| --- | --- | --- |
| Focused MCP, usage and uploads | `.\.venv\Scripts\python.exe -m pytest tests/test_mcp_isolation.py tests/test_usage_limits.py tests/test_mcp_compatibility.py tests/test_upload_security.py -q -W error::RuntimeWarning --tb=short` | 169 passed before the final two HTTP regressions were added |
| OAuth HTTP disconnect regressions | `.\.venv\Scripts\python.exe -m pytest tests/test_mcp_isolation.py::test_oauth_http_disconnect_remains_available_over_quota -q -W error::RuntimeWarning --tb=short` | 2 passed |
| Final full backend suite | `.\.venv\Scripts\python.exe -m pytest -q -W error::RuntimeWarning --tb=short` | 637 passed, 2 historical failures, 27 deprecation warnings; 639 collected; 252.59 seconds |
| Frontend tests | `npm test` from `frontend` | 46 passed, 0 failed |
| TypeScript | `.\node_modules\.bin\tsc.cmd --noEmit --incremental false` from `frontend` | Passed |
| ESLint | `npm run lint` from `frontend` | Passed |
| Production build | `npm run build` from `frontend` | Passed; all 12 static pages generated |
| Python compilation | `py_compile.compile(..., doraise=True)` over backend root and `tests/**/*.py` | 40 files passed; no application imports |
| Whitespace checks | `git diff --check` from project root | Passed |

The Windows sandbox prevented an earlier Next.js directory-canonicalization step;
the final build passed outside that sandbox. No dependency installation or upgrade
was needed. No Python formatter/linter is installed in this environment; modified
sections were reviewed manually for typing, naming, comments and formatting.

Focused runs overlap the full suite and are not added to its count. The final full
run includes Batch 4A authentication, Batch 4B-1 ownership, checkpoint, memory,
RAG, upload, model/free-tier and SSE regressions. Independent tests cover atomic
admission across eight SQLite store instances, persisted resets, dead-worker
recovery, error/cancellation cleanup, and per-provider embedding batch accounting.

The two known historical failures remain unchanged and are reported separately:

- `tests/test_mcp.py::test_local_mcp_server_discovers_project_status_tool`: the
  absent local `get_project_status` tool is not discovered.
- `tests/test_mcp.py::test_local_mcp_project_status_tool_executes`: lookup of that
  absent tool raises `StopIteration` inside the coroutine.

Neither test was removed or weakened. The local project-status connector is not
introduced by this batch. Existing deprecation warnings concern Starlette's
httpx test client and `datetime.utcnow()` in persistence code; unrelated packages
and database behavior were left intact.

**Verdict: PASS for Batch 4B-2's offline acceptance criteria.** All new and affected
regressions pass, including the final OAuth HTTP tests. The complete backend suite
still exits with failure because of the two explicitly acknowledged historical
tests. No new failures or runtime-warning failures remain. Live integration and
manual browser checks below remain unperformed; this is not a production-readiness
or live-provider verification claim.

## Manual browser verification

These are follow-up checks, not claims that live browser/provider verification was
performed. Use existing accounts and credentials; do not share them in logs or
screenshots. Real chat inference still requires separate explicit authorization.

1. Start the existing backend and frontend with the same runtime directory. Sign
   in through the existing login screen. Confirm session and model catalog load.
   In a signed-out browser, verify protected data and connector routes return 401.
2. Connect GitHub using an existing token. Confirm status and discovered tools;
   disconnect and confirm the UI clears the connection. Repeat for other available
   connectors. Reconnect with the same credential; no new API key is required.
3. In an isolated test installation with two fixture principals, connect a
   connector for A. B must not see or execute A's connector. Do not create accounts
   by modifying the live authentication database; this batch adds no user UI.
4. Complete Google/Slack OAuth from the initiating browser. Deny a second attempt,
   replay its callback, and try a callback from another session: none should
   replace a valid connection. Sign out during an authorization attempt and
   confirm its callback cannot save credentials. Do not record callback URLs.
5. With disposable uploads in a test installation, send ten uploads in one minute.
   The next request should show retry guidance with HTTP 429. After the minute
   resets, an eleventh attachment in the same full thread must return HTTP 409.
   Delete one owned test attachment and verify replacement succeeds. Existing user
   uploads should not be used for this capacity exercise.
6. Use mocked streaming in the isolated test installation, start and cancel a
   response, then start another. Confirm cancellation frees capacity and a quota
   SSE error is shown once. Do not exhaust real provider quotas for this check.
7. Restart the backend: daily counters should persist, while connectors require
   reconnection. Confirm old conversations and uploads still load for their owner.

## Remaining limitations

- Real provider inference, OAuth exchanges, remote MCP transports and browser
  interactions were not executed. Offline tests cover the boundaries and races;
  they do not prove current provider availability.
- Credentials live in process memory. There is no encrypted credential vault or
  shared credential service. Restart loses credentials and pending OAuth state.
- Disconnect cannot undo an external action already dispatched. This worker
  cancels active connector tasks; another worker observes revocation at its next
  check. Its already-running action may complete. Use one worker for this design.
- Stdio connectors run with the backend OS user's privileges. Environment filtering
  prevents accidental forwarding, but is not an OS sandbox against malicious
  connector packages or a compromised local account.
- SQLite contention, a hung live worker or an unavailable process-identity check
  fails closed rather than granting extra capacity. Clock tampering and local
  database edits are outside the authenticated application boundary.
- Quotas do not provide lifetime disk limits, provider-side billing enforcement or
  distributed denial-of-service protection. No production-readiness claim is made.

## Files changed by Batch 4B-2

Created:

- `backend/usage_limits.py`
- `backend/tests/test_usage_limits.py`
- `backend/tests/test_mcp_isolation.py`
- `frontend/tests/limits.test.mjs`
- `docs/BATCH_4B_2_MCP_LIMITS.md`

Modified (some were already untracked from earlier batches):

- `backend/auth.py`
- `backend/ownership.py`
- `backend/mcp_client.py`
- `backend/mcp_oauth.py`
- `backend/app.py`
- `backend/models.py`
- `backend/openrouter_model.py`
- `backend/agent.py`
- `backend/tool.py`
- `backend/untrusted_content.py`
- `backend/rag.py`
- `backend/model_smoke.py`
- `backend/tests/conftest.py`
- `backend/tests/test_mcp_compatibility.py`
- `backend/tests/test_upload_security.py`
- `frontend/lib/api.ts`

Git's working-tree diff includes earlier batches as well as this one. It is not a
Batch 4B-2-only change count. Existing changes, user data and backups are preserved.
At final review, `git diff --stat` reports 24 tracked files, 3,910 insertions and
3,641 deletions across the accumulated work; it excludes untracked files.
`git status --short` was reviewed. Batch 4B-2 itself touches the 21 files listed
above (five created, sixteen modified). No commits, pushes, resets, stashes or
branch switches were performed.
