# Batch 4B-1: private data ownership

## Current implementation status

Batch 4B-1 is already implemented and its local owner claim has been applied.
The activation receipt below records that operation. Do not rerun the claim as
part of routine verification or recreate the existing owner.

The working tree also contains [Batch 4B-2](BATCH_4B_2_MCP_LIMITS.md) and
[Batch 5](BATCH_5_STREAMING.md). Statements below describing MCP isolation and
rate controls as deferred describe the original Batch 4B-1 boundary. Batch 4B-2
subsequently added principal-scoped connector credentials, OAuth state and usage
limits. Batch 5 added cancellation cleanup and same-thread execution exclusion.
Those later protections remain in place; this document is not a rollback plan.

## Compatibility and implementation plan

Use a stable, random principal identifier from the verified server session. Keep
the singleton account restriction. An additive authentication schema migration
backs up the database before adding the principal identity; passwords and
existing sessions remain valid.

A separate `data/ownership.sqlite3` maps globally unique thread and workspace
identifiers to principals. Existing conversation rows, checkpoint keys, upload
paths, manifests and Chroma collections retain their identifiers and contents.
Ownership of attachments, vectors and checkpoint namespaces is inherited from
their thread. Memory requires both thread and workspace authorization. Legacy
identifiers are reserved as unclaimed, never assigned on first access.

Bind a request-local context at the authentication middleware and reset it after
the complete ASGI response, including streaming. Storage helpers and the
checkpoint saver check this context; model arguments and RunnableConfig cannot
set it. Filter private retrieval before ranking, cache lookup or prompt assembly.

Provide an offline migration command with a read-only dry run, SQLite backups,
metadata backup, an explicit target owner confirmation and a transactional audit
record. Claims are idempotent and cannot transfer already-owned resources.
Keep the original data recoverable and document rollback before applying claims.

Validate two-way isolation, concurrency, cache behavior, actual checkpoint
restoration and legacy migration with temporary stores and mocked providers.
Then run the existing backend/frontend acceptance checks. MCP credential
management and broader rate controls remain Batch 4B-2 work.

## Implemented boundaries

- Authentication schema version 2 adds `owner_identity`, a stable random
  identifier linked to the existing singleton owner. The verified session join
  supplies it. `/auth/session` and login add `user.principal_id`; cookies, CSRF,
  passwords, session expiry and the singleton constraint retain their behavior.
- Authentication middleware establishes a `ContextVar` for the entire ASGI
  response. It resets on completion/error and propagates through supported
  asyncio/AnyIO workers. Model-visible tool arguments and RunnableConfig do not
  establish or override this context. Helpers without a principal fail closed.
- `ownership.sqlite3` reserves globally unique thread/workspace IDs. Atomic
  creation binds new IDs to the active principal. Existing unclaimed or foreign
  IDs return the same 404 as missing protected resources. Ownership is inherited
  by checkpoint namespaces, attachment manifests and vector metadata using the
  authorized thread. Application databases need no ownership-column backfill.
- Chat and streaming authorize both thread and workspace before graph work.
  Uploads authorize the thread before reading upload contents. Database helpers
  authorize conversations/history/messages and workspace memory; conversation
  listing filters to the caller's threads. There is no existing backend
  conversation-delete HTTP endpoint: browser deletion changes local history.
- `OwnedSqliteSaver` checks read, write, intermediate-write, history, delta
  history and deletion operations before SQLite reads/deserialization. Unscoped
  history enumeration is rejected. The upstream synchronous bridges delegate to
  these guarded methods. Checkpoint IDs, namespaces and contents are unchanged.
- Manifest reads, byte/text extraction, ingestion and deletion require the
  owning thread. Foreign or missing attachment references fail before chat.
  Existing MIME, size, path, symlink and upload-journal checks remain enabled.
- Vector and BM25 queries restrict thread and attachment IDs. Returned metadata
  is checked before hybrid ranking/reranking, citations or context assembly.
  New vector keys include thread IDs to prevent cross-thread replacement by a
  reused attachment ID; existing vector keys remain readable via metadata.
- RAG cache keys and compiled-agent cache keys include the principal. Direct RAG
  cache reads/writes reject a foreign principal key. Internal document and memory
  tools check server context, even when runtime configuration contains forged
  user/owner identifiers. Personalization remains request-scoped.

All private runtime stores now honor `CLAWBIT_RUNTIME_DIR`. Previously the
checkpoint path alone used the backend directory even with a custom runtime
root. The default installation path is unchanged. If an installation previously
used a custom runtime directory, stop its backend and explicitly copy/back up
its old `backend/data/langgraph_checkpoints.sqlite` using SQLite backup into that
runtime's `data` directory before the claim. Do not overwrite a destination
checkpoint database that already contains records. No automatic filesystem move
or merge is performed.

## Browser-local data

Conversation display history, project records, active-project selection,
preferences and personalization remain in their existing localStorage keys.
Library files/folders remain in the `clawbit-library` IndexedDB database. These
are not backend project/file resources; deleting a local conversation still
does not delete its server checkpoint or uploads. A project identifier sent as
`workspace_id` must pass server ownership checks independently of browser state.

Before mounting private views, the browser asks explicitly to bind the existing
profile to the verified principal. It stores only that non-secret identifier
under `clawbit-browser-owner-v1`, preserving all existing data. A different
principal must use a separate browser profile. Missing/inaccessible storage
fails closed. Changing server principals cancels prior requests and remounts the
profile boundary. The marker is outside the existing `clawbit.` backup importer
and clear-data namespace, so importing a backup cannot silently reassign it.

This protects ordinary application access, not someone with direct browser
developer-tools or OS access to the profile. It is not encryption or a backend
authorization credential. Public registration remains disabled, and this batch
does not implement several accounts sharing one browser profile.

## Legacy claim, backups and recovery

The preflight inspected schemas and counts without reading private checkpoint
content: 746 checkpoints, 909 intermediate writes, four memory rows, 28 Chroma
embedding rows, and one existing initialized owner. A read-only inventory found
89 thread IDs and four workspace IDs across checkpoints, SQL, vectors and upload
directories. These counts include old development/test identifiers; none are
discarded. Existing files, manifests and vector collections are retained.

From `backend`, inspect the inventory without initializing or modifying stores:

```powershell
.\.venv\Scripts\python.exe ownership_migration.py
```

Stop all backend workers before claiming or rolling back. Then explicitly name
the **existing** owner; no new account or password is required:

```powershell
.\.venv\Scripts\python.exe ownership_migration.py --claim-owner '<existing username>'
```

The command requires typing `CLAIM <existing username>`. Use `--root` for an
explicit runtime directory. The command otherwise honors the same environment
and absolute backend `.env` configuration as the application; it never edits
`.env` or prints credentials.

Before mutation, SQLite's backup API snapshots auth, conversation/memory,
checkpoint, ownership (if present), and Chroma databases, including committed
WAL contents. Manifest and pending-journal copies are saved beside them under
`data/ownership-backups/<backup-id>/`. Authentication also makes its own
pre-upgrade `.backup` snapshot. Payload files and Chroma binary indices are not
modified by ownership claims; keep normal full-runtime backups for general
disaster recovery. These private snapshots are ignored by Git and must retain
the runtime directory's OS access controls.

Claiming reserves the inventory and assigns only NULL owners in one SQLite
transaction. The `claims` and `claim_resources` tables record the principal,
timestamp, exact resource IDs, count and backup path; `claim.json` identifies the
completed operation. Repeating a claim does not reassign owned data. A failed
transaction cannot leave a partially assigned resource set. Unclaimed resources
remain inaccessible until a successful explicit claim.

To revoke one claim without deleting payloads or newer resources:

```powershell
.\.venv\Scripts\python.exe ownership_migration.py --rollback-claim '<claim-id>'
```

Type `ROLLBACK` to confirm. This creates another backup and transactionally
returns just that claim's resources to unclaimed state. It is idempotent and
audited in `rollbacks`. Stop/restart workers around this operation so in-memory
contexts and caches cannot outlive the administrative change. A later explicit
claim can restore access. Rollback is not a destructive data restore.

If the registry itself is corrupted, stop workers, preserve the current runtime
as a separate backup, and restore the ownership database from the matching
snapshot using SQLite's backup API. If there was no registry before the first
claim, prefer the audited rollback above. Do not delete the authentication DB,
reset the account, or overwrite current payload databases to undo an ownership
assignment. Restoring an older registry without reconciling newer resource
bindings intentionally quarantines those resources on next inventory; it must
not silently assign them. Keep backups until recovery has been verified.

## Security validation and remaining scope

Tests use temporary databases, fake providers and explicit principals. The HTTP
attack test creates two independent temporary singleton AuthStores, signs into
each through the real CSRF/login flow, and routes their verified test sessions
through the actual middleware. Production's singleton schema is not relaxed.

Coverage includes valid-owner operations and both directions of conversation
read/write, thread reuse, workspace/memory access, attachment guesses/deletion,
raw-path access, private retrieval and cache attacks. Actual LangGraph checkpoint
restoration, edits, retries, history, deletion and synchronous bridges reject
foreign contexts. Other tests exercise forged tool configuration, vector/BM25
metadata contamination before reranking, vector-ID collisions, concurrent
contexts/creation races, SSE context propagation, legacy claims, auth-version
migration, idempotency, backups and rollback with preservation of newer data.
Existing authentication, CSRF, upload, SSRF and all 13 model regressions remain.

At the original Batch 4B-1 boundary, MCP credentials, OAuth connector stores and
external tool discovery remained installation-wide. Their principal isolation,
credential lifecycle and broader rate controls were deferred to Batch 4B-2,
which is now present in this working tree. Public registration remains disabled.
Existing GitHub connector behavior is preserved.
Already-admitted background work retains its verified owner context; logout
does not transactionally undo an operation already in progress.

No paid or free model inference, real OAuth exchange or credential disclosure
is needed for these tests. Offline SSE tests verify actual event transport with
mocked model responses; they are not a claim of current upstream availability.
Browser tests use Node/React with controlled browser stubs, not live DOM E2E.
This batch is not a production-readiness declaration.

## Files in this batch

Created (8):

- `backend/ownership.py`
- `backend/ownership_migration.py`
- `backend/owned_checkpoints.py`
- `backend/tests/test_ownership.py`
- `frontend/lib/browser-owner.ts`
- `frontend/components/auth/BrowserOwnerGate.tsx`
- `frontend/tests/ownership.test.mjs`
- `docs/BATCH_4B_1_OWNERSHIP.md`

Modified (16, including files untracked before this batch):

- `backend/auth.py`
- `backend/auth_store.py`
- `backend/app.py`
- `backend/agent.py`
- `backend/database.py`
- `backend/rag.py`
- `backend/tool.py`
- `backend/tests/conftest.py`
- `backend/tests/test_auth.py`
- `backend/tests/test_upload_security.py`
- `backend/tests/test_rag.py`
- `backend/tests/test_rag_eval.py`
- `frontend/lib/auth.ts`
- `frontend/components/auth/AuthProvider.tsx`
- `frontend/tests/auth.test.mjs`
- `frontend/tests/models.test.mjs`

Existing fixtures now explicitly provide a trusted principal, use complete
thread metadata, and assert the additive session identity/profile gate. Existing
assertions and security checks were retained. No dependency upgrades, provider
changes, `.env` edits, commits, pushes, resets or branch changes are part of this
batch.

## Manual verification

1. For this existing installation, retain the completed activation receipt and
   backup; do not repeat the claim. Only an unclaimed installation needs the
   dry run and explicit claim with workers stopped. Restart normally if needed.
2. Sign in with the existing account. Explicitly claim its current browser
   profile when prompted; confirm old conversation/project/library views remain.
3. Open an existing thread and continue it with an available, consented free
   model only when a live request is authorized. Verify streamed tokens, cancel,
   edit/retry, history restoration and memory within its workspace.
4. Upload a small allowed document, retrieve its citations, and delete it.
   Confirm a guessed attachment reference returns the generic missing response.
5. Sign out and verify protected API requests fail; sign back in and check the
   same history and attachments. Verify GitHub connector status without exposing
   or replacing credentials.
6. Test additional accounts only in isolated test stores. Do not modify the real
   owner table to simulate multi-user access.

## Verified results — 2026-10-20

**PASS for Batch 4B-1's implemented ownership boundaries and offline acceptance,
excluding the two unchanged historical MCP failures.** This is not production
readiness or completed multi-user connector support.

| Check | Result |
| --- | --- |
| Full backend: `.\.venv\Scripts\python.exe -m pytest -q -W error::RuntimeWarning --tb=short` | 555 passed, 2 historical failures; 27 existing deprecation warnings |
| Final ownership: `.\.venv\Scripts\python.exe -m pytest tests/test_ownership.py -q -W error::RuntimeWarning --tb=short` | 17 passed |
| Ownership + upload focused run | 102 passed |
| `npm test` | 42 passed |
| `.\node_modules\.bin\tsc.cmd --noEmit --incremental false` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed; 12 static pages generated |
| Python compilation | All 37 backend root/test modules compiled; final edited ownership modules recompiled |
| `git diff --check` | Passed |

The full backend run includes authentication, upload, SSRF, RAG, memory, model,
MCP and 16 ownership cases. The final checkpoint-runtime consistency regression
was added after its collection; the 17-case focused run verifies that last
change, actual graph restoration and all other ownership checks. These runs
overlap: the resulting suite has 556 distinct passing cases and two historical
failures, not an additional 17 independent passes on top of the full count.

The unchanged failures are:

- `tests/test_mcp.py::test_local_mcp_server_discovers_project_status_tool`
- `tests/test_mcp.py::test_local_mcp_project_status_tool_executes`

Both still expect `get_project_status` in the current default MCP discovery,
where it is absent. The GitHub compatibility regressions pass. No assertions or
checks were disabled. The initial affected run exposed incomplete old RAG
fixtures and ownership setup in a legacy upload fixture; those were corrected
to represent real thread metadata and an explicit owner. The path mismatch
check retained its existing upload error. Final affected checks pass.

No Python formatter/linter is installed in the environment; none was installed
for this task. Changed sections were reviewed manually for naming, imports,
typing, comments and maintainability, followed by compilation and whitespace
checks. Existing unrelated formatting was preserved.

### Local activation and preservation receipt

After confirming no backend worker was running/listening, the explicit claim
was applied to the sole existing initialized account. Its username was read from
the auth store, not hardcoded in the implementation, and no account/password was
created or replaced.

- Claim ID: `8138d67a3dc34b4cbfe7f9845c9b6070`
- Claimed resources: **93** (89 threads, four workspaces)
- Unclaimed resources after activation: **0**
- Backup directory:
  `backend/data/ownership-backups/d4d1abfdd6fb4affabe312ecb27d2fde/`
- Before/after SHA-256 verification: **25 payload files unchanged**, covering
  application/checkpoint databases, uploads/manifests and Chroma files.
- Original owner/password rows and all existing session rows: **unchanged**.
- The resource inventory remained unchanged and every assignment has an audit
  row. `claim.json` and `verification.json` are saved inside the private backup.
- All four pre-migration database snapshots passed SQLite integrity checks;
  there was no ownership database before this first claim.

The live claim did not invoke model providers, create another real account,
delete data, edit `.env` or start a backend service. Start/restart the application
normally and accept the browser-profile claim after signing in. Manual browser
DOM login/history checks and live model streaming have not been performed.

The final tracked working-tree diff is **23 files, 3,195 insertions and 1,496
deletions**, including earlier batches. Untracked files are not included in
`git diff --stat`; this batch's exact 24-file manifest is above. The branch stays
`checkpoint/clawbit-pre-release-qa`. Existing dirty work was retained.

## Current-tree revalidation — 2026-10-21

The Batch 4B-1 request was submitted again after Batch 5. Review confirmed that
the requested ownership implementation and activation were already present.
The plan for this pass was to check the existing enforcement points against the
request, fix confirmed gaps only, run acceptance checks, and update this record.
No new ownership defect was found in the reviewed paths or regression tests.
No application code, test assertions, dependencies or persistence schemas were
changed. The only file edited in this pass is `docs/BATCH_4B_1_OWNERSHIP.md`.
The original 24-file implementation manifest above remains historical.

Review covered verified-session context, registry authorization, conversation
and workspace storage, checkpoint read/write/history/delete guards, attachment
path and manifest checks, vector/BM25 filtering before ranking, principal-scoped
RAG and agent caches, memory tools, and the browser profile gate. The current
MCP wrappers also retain Batch 4B-2's principal and connection-generation checks.

| Current acceptance command | Result |
| --- | --- |
| Backend: `.\.venv\Scripts\python.exe -m pytest -q -W error::RuntimeWarning --tb=short -o faulthandler_timeout=90` | 663 passed, 2 historical failures, 27 deprecation warnings; 255.00 seconds |
| Frontend: `npm test` | 65 passed, 0 failed |
| Frontend: `.\node_modules\.bin\tsc.cmd --noEmit --incremental false` | Passed |
| Frontend: `npm run lint` | Passed |
| Frontend: `npm run build` | Passed; 12 static pages |
| Python `py_compile` over backend root and test modules | 42 files passed |
| `git diff --check` | Passed |
| `git diff --stat`, `git status --short` | Reviewed; existing dirty tree preserved |

The full backend run includes all 17 ownership tests, authentication, uploads,
RAG, memory, checkpoint restoration, all registered model regressions, MCP
isolation, usage limits and streaming lifecycle tests. These are included in
the 663 passes, not additional counts. Both directions of resource theft,
forged ownership configuration, attachment guesses, cache contamination and
legacy migration/recovery are exercised using temporary stores. No real owner
account, runtime database, backup or ownership assignment was modified.

The only failures remain
`tests/test_mcp.py::test_local_mcp_server_discovers_project_status_tool` and
`tests/test_mcp.py::test_local_mcp_project_status_tool_executes`. Both expect the
absent default `get_project_status` tool. The pytest command exits 1 for these;
no new failures or RuntimeWarning failures occurred.

An initial sandboxed pytest attempt stopped progressing and was interrupted.
Only the subsequent complete run is counted. The sandbox also denied Next.js
path canonicalization on Windows; the build passed when rerun outside it.
Backend tests retained isolated persistence and external-network guards.

The accumulated tracked diff remains 27 files, 4,183 insertions and 4,459
deletions, including earlier batches. This document is already untracked and
therefore excluded from that statistic. No Git history or branch changes were
made. The existing activation receipt and recovery instructions are retained;
the migration was not rerun and the historical payload hashes were not presented
as a fresh integrity audit.

**Verdict: PASS for the implemented Batch 4B-1 ownership boundaries and offline
acceptance, with the two documented historical MCP failures excluded.** This is
not a completely green full-suite result or a production-readiness declaration.
Browser-local data still depends on browser-profile and OS access controls;
the profile marker is not encryption. MCP/OAuth credentials remain memory-only
with the one-worker limitation documented in Batch 4B-2. Live browser checks,
real OAuth exchanges and provider inference were not performed. Use the manual
steps above and the combined Batch 5 checklist without repeating owner setup or
the completed migration.
