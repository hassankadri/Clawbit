# Batch 7: research, citations and memory

## Preflight and compatibility plan

The current local tree already has authenticated Normal/Research selection,
LangGraph tool loops, hybrid Chroma/BM25 retrieval, FlashRank reranking,
principal-scoped retrieval caches, SQL workspace memory, and Batch 6 visible
history/revisions. Research currently differs mainly by its prompt/tool set.
Citation metadata contains only file/page and is not rendered as authorized
source links. Memory has save/search helpers but no update/delete workflow;
model-selected writes are not tied to explicit UI confirmation.

Extend those paths, retaining the existing graph, providers, ownership registry,
rate limits and checkpoint identifiers. Add a bounded execution-local evidence
registry and backward-compatible optional citation metadata. Uploaded source
opening must recheck thread ownership and use guarded file access. Citation
resolution confirms provenance, not semantic entailment.

Memory will continue using the existing SQLite database and legacy memory rows.
An additive versioned metadata/audit migration will back up an existing database
before schema changes. Existing workspace ownership stays authoritative; a
principal's cross-conversation preference scope uses a separately owned internal
workspace identifier. No legacy rows, owner claims or Chroma data are rewritten.
Real database schema/count inspection found four memory rows. Implementation and
migration tests use isolated databases; actual deployment migration is deferred.

## Implementation and confirmed gaps fixed

The existing graph remains the execution engine. Normal and Research modes keep
their distinct tool sets and existing frontend selector. Research now receives
evidence instructions, execution-local source IDs, relevant authorized memory,
and explicit reports of unavailable evidence. The model chooses search steps,
compares evidence and synthesizes a response; the application enforces access,
tool budgets and citation resolution. It does not claim to validate the model's
reasoning or the truth of every cited statement.

Confirmed gaps addressed:

- Retrieved file/page labels had no stable evidence IDs or authorized opening
  flow. Sources now travel from retrieval through progressive SSE and persisted
  message metadata to clickable references beside claims.
- Citation-like model text could lack execution provenance. Unknown IDs are
  marked unverified; only retrieved, cited records survive final resolution.
- Browser imports could otherwise impersonate new server provenance. Imports
  retain sanitized legacy file/page labels but cannot set verified IDs, source
  URLs or research counts. Original browser storage is not changed.
- Repeated ingestion could overwrite chunks under the same vector IDs. Identical
  indexed content is now idempotent; differing or unverifiable legacy content
  requires a new attachment. Existing vectors are not replaced or migrated.
- Reranker indices could be negative or duplicate a chunk. Invalid indices fail
  reranking safely, duplicate indices are ignored, and hybrid results remain.
- Failed web-search responses could be described as empty successful retrieval.
  Invalid/error results now produce a safe failure note and no source records.
- Removed citation files raised an unhandled filesystem error. Source preview
  and download now return a safe unavailable-source response.
- Replaying a completed request receipt omitted saved citation metadata from
  the response. Both chat contracts now replay the original source records and
  research report without another retrieval or inference.
- Memory lacked explicit update/delete controls and allowed model-selected
  writes. Saved memory now has a confirmed user workflow; `remember_this`
  explains that workflow and cannot persist model or document instructions.

## Research execution and resource boundaries

The frontend sends and restores `mode="research"`. The same authenticated chat
admission, ownership checks, free-provider consent, checkpoints, cancellation and
inference wrappers remain in force. All 13 model entries and endpoint availability
checks are unchanged. No provider key, policy file or `.env` was changed.

Research uses the existing document search, bounded web search, safe webpage
reader, date and calculator tools. MCP tools are included only when their
advertised `readOnlyHint` is exactly true. Wrappers preserve that metadata along
with owner/generation checks. A refreshed tool that loses its read-only flag
cannot execute through an earlier read-only handle. Raw credential-bearing tools
are still not captured in graph wrapper closures. Normal-mode connector behavior
and all previous OAuth/disconnect safeguards remain unchanged.

The existing default cap is 12 tool calls across a response; the entire next
batch must fit before execution. Research has a graph recursion limit of 28 to
allow those rounds and a terminal response. At the tool cap it returns a partial
result identifying retrieved references or the lack of evidence, without
executing the rejected calls. Provider, quota and transport errors retain their
existing safe error behavior and any durable partial answer. There are no new
automatic retries or side-effect replay paths. Batch 6 edit/regeneration remains
tool-free and cannot reuse prior source IDs as new evidence.

Identical normalized web queries share one execution-local cached result and a
separate search lock, including parallel tool requests. The cache is discarded
between executions and cannot cross principals. It does not bypass tool admission.

Default quotas remain those in `BATCH_4B_2_MCP_LIMITS.md`: chat 20/minute and
500/day; inference 40/1,000; embedding and retrieval 60/2,000; uploads and ingestion
10/100; MCP management 30/500; MCP execution 60/1,000; built-in tools 60/2,000.
Memory CRUD/list operations use the existing built-in tool limiter. Existing
fixed UTC minute/day resets, persistent counters and concurrency leases apply.

## Retrieval and citation contract

Hybrid Chroma/vector plus BM25 retrieval, deduplication, document diversity and
FlashRank reranking are retained. Ownership and attachment filtering happen
before ranking and prompt assembly. Retrieval caches remain principal/thread/
attachment scoped; cached provenance is registered in each new execution.

New chunks retain their existing vector IDs and add `chunk_id` and a content
hash. Older metadata remains readable, using a content-derived chunk identifier
where necessary. Real page numbers are preserved; no missing page is invented.
Each result contains at most 3,000 text characters, within 12,000 total snippet
characters, plus bounded metadata. The existing preview fallback is limited to
2,000 characters per document and explicitly labeled. Retrieval and reranking
failures/fallbacks are included in research limitations, including cache hits.

Each execution holds at most 32 source records. IDs are `S` plus 24 hexadecimal
characters derived from document/thread/attachment/page/chunk identity or the
retrieved web URL. The model cites them as `[S...]`. Final resolution keeps only
records cited in that answer and known to the execution. Excess or invented IDs
are unverified. This establishes provenance, **not claim entailment**.

Backward-compatible source objects keep `file` and optional `page`, adding:

```json
{
  "file": "report.pdf",
  "page": 2,
  "source_id": "S0123456789abcdef01234567",
  "kind": "document",
  "thread_id": "existing-thread",
  "attachment_id": "existing-attachment",
  "chunk_id": "3"
}
```

Web records use `kind="web"` and a URL supplied by an actual successful retrieval.
Titles are bounded and stripped of path prefixes/control characters. Links must
use HTTP(S), public-looking hosts, ordinary ports and no embedded credentials or
credential-like query parameters. Unsafe literal IPs and local/internal host
suffixes are rejected. URL validation does not perform DNS resolution; actual
web fetching still uses the existing SSRF/redirect protections. Arbitrary MCP
result schemas are not automatically promoted into clickable source records.

`GET /sources/{thread_id}/{attachment_id}` returns a bounded title/text preview.
`GET /sources/{thread_id}/{attachment_id}/content` downloads the original bytes
as an attachment with octet-stream content type, sandbox CSP and existing
private-response/nosniff headers. Both require the signed-in principal's thread
ownership, manifest membership, guarded path and validated bounded file read.
No backend path is returned. Missing files fail safely. The UI uses authenticated
fetch for both operations, and never renders source HTML as executable content.
Precise page/chunk deep linking is not implemented: the UI labels a genuine page
when known and provides the preview/original document without inventing a jump.

## Streaming, revisions and restoration

The optional SSE `sources` event carries `{ "sources": [...] }` when the current
execution's evidence changes. It precedes corresponding answer tokens, so inline
citations resolve while streaming. This exposes observable evidence, not private
reasoning. The final `done.inspector.sources` contains only cited sources;
`done.inspector.research` contains `retrieved_sources`, `cited_sources` and bounded
limitation messages. The frontend validates progressive source frames.

Batch 6 message JSON stores resolved source records and the research report.
No history table migration is needed. Restart/reload restores references; older
messages remain readable. A successful regeneration has its own fresh evidence
registry. Failed regeneration preserves the previous valid active answer and its
sources. Cancelled persistent responses retain only sources cited in partial
text. Existing request receipts, revisions, thread IDs and checkpoint behavior
are preserved. Legacy nonpersistent clients still work.

## Explicit persistent memory

Saved memory supports workspace scope and principal-wide preferences. Conversation
context/checkpoints remain separate, and frontend personalization is still applied
as before. Relevant saved memory enters the graph as labeled untrusted context;
it does not become a trusted system instruction or permission to run a connector.
The same behavior is covered in both Normal and Research graph execution.

`GET /memories?scope=workspace&workspace_id=...` lists owned workspace entries;
`scope=user` selects the authenticated principal's internal preference workspace.
`POST /memories` accepts content, scope, workspace and `confirmed: true`.
`PATCH /memories/{id}` also requires the current version.
`DELETE /memories/{id}?scope=...&workspace_id=...&version=...` tombstones one owned
entry. CSRF, authenticated principal derivation, 16 KiB write-body limits and
tool quotas apply. Client-supplied owner fields are rejected.

The Saved memory panel provides explicit save/update confirmation and delete
confirmation, scoped listing, loading/empty/error states and optimistic conflict
errors. Merely viewing, chatting or retrieving a source cannot write a memory.

Memories contain 1–2,000 normalized characters. Credential-pattern checks reject
common passwords, API keys, bearer tokens, JWTs and private keys before writing.
Duplicates are whitespace-normalized and case-insensitive. SQLite `BEGIN
IMMEDIATE` and optimistic versions serialize duplicates/updates and reject stale
edits with 409. Audit records store principal/action/time without copying memory
content. Deleted entries are excluded immediately, with no memory-context cache.

Context selection uses lexical overlap, selecting at most five memories within
4,000 characters; it never falls back to every memory. Workspace records never
leak to other workspaces; relevant principal preferences can cross conversations.
Unavailable/corrupt memory reads do not break otherwise valid chat. Unsupported
schema versions fail closed. Credential detection is heuristic, not a guarantee
that arbitrary prose contains no sensitive information.

## Database compatibility and recovery

The existing `data/chatbot_memory.db` and `long_term_memory` rows remain the base.
Version 1 adds `memory_schema`, `memory_details`, `memory_audit` and a workspace
lookup index. Existing row IDs, thread/workspace associations and timestamps are
not rewritten by migration. Missing metadata denotes a legacy workspace memory
at version 0. Each principal's preferences use an owned `user-memory-<hash>`
workspace in the existing ownership registry, not a separate ownership system.

On first use, an existing database receives a SQLite backup named
`chatbot_memory.db.memory-<timestamp>.backup` before the additive transaction.
Initialization is idempotent; foreign-key integrity is checked. Migration,
backup, legacy rows, restarts and concurrent stores are tested on temporary
databases. The actual installation's four memory rows were inspected only by
schema/count; the new migration has not been run against that database.

Deletion is a tombstone, not secure physical erasure. Memory content may remain
in local database rows and backups. Updates replace the active text; this batch
does not introduce full memory revision snapshots. Storage/backups require the
existing host filesystem protections and are not encrypted by this batch.

For recovery, stop backend workers and preserve a copy of the current runtime
before choosing a backup. Validate the chosen copy using SQLite integrity checks
and inspect it in an isolated runtime before restoring. Keep matching ownership
and history/checkpoint backups together. Do not rerun owner setup or ownership
claims, delete the current database, or overwrite it while a worker is running.
No actual recovery, owner initialization, ownership migration, browser import,
Chroma reindex or user-data deletion was performed here. The existing owner,
93 claimed legacy resources and their backups were left untouched.

## Verification

Verification uses isolated runtime directories, temporary SQLite stores, dummy
credentials, disabled dotenv loading and an external-network guard. Mocked
providers exercise the actual graph, retrieval, HTTP and SSE paths; these tests
do not demonstrate live internet research or live model quality.

| Check | Command | Result |
| --- | --- | --- |
| Full backend | `.\.venv\Scripts\python.exe -m pytest -q -W error::RuntimeWarning --tb=short -o faulthandler_timeout=90 --junitxml=.pytest_cache/batch7-final.xml` | 743 passed, 2 historical failures, 13 warnings; 315.29 seconds |
| Focused research/replay | `.\.venv\Scripts\python.exe -m pytest tests/test_research.py -q -W error::RuntimeWarning --tb=short -o faulthandler_timeout=90 --junitxml=.pytest_cache/batch7-research-final.xml` | 15 passed; overlaps the full suite |
| Frontend | `npm test` | 90 passed, 0 failed |
| TypeScript | `.\node_modules\.bin\tsc.cmd --noEmit --incremental false` | Passed |
| ESLint | `npm run lint` | Passed |
| Production build | `npm run build` | Passed; all 12 pages generated |
| Python compilation | `py_compile.compile(..., doraise=True)` for backend root/tests Python files | 52 files passed |
| Diff whitespace | `git diff --check` | Passed |

Backend commands run from `backend`; frontend commands run from `frontend`.
The Windows sandbox denied SWC path canonicalization on the first build attempt;
the same build passed outside that sandbox. Backend tests likewise used the
approved Windows asyncio loopback execution context. No dependencies were added.

Earlier focused runs and overlapping full runs are not added to final counts.
The final run includes all 56 new backend cases, including the two replay cases;
the frontend total includes 11 new cases. No new failing regression remains.
The final backend result is saved as JUnit XML in the ignored pytest cache so an
interrupted application session does not lose its evidence. The two historical
failures are tracked separately:

- `tests/test_mcp.py::test_local_mcp_server_discovers_project_status_tool`: the
  configured catalog does not expose `get_project_status`.
- `tests/test_mcp.py::test_local_mcp_project_status_tool_executes`: selecting that
  missing tool raises `StopIteration` inside the coroutine.

The 13 warnings are the existing TestClient and `datetime.utcnow()` deprecations.
Runtime coroutine warnings were treated as errors. The full suite covers auth,
CSRF, ownership, upload/RAG protection, SSE cancellation/lease release, history,
MCP isolation/OAuth, persistent usage limits and all 13 model/free-tier policies.
The two historical failures were neither skipped nor weakened.

Final review covered all batch files for naming, typing, comments, source
validation, ownership, cancellation, migration behavior and compatibility.
Installed ESLint/TypeScript checks were used; Python was reviewed directly and
compiled. No formatter dependency was installed. Earlier unrelated formatting
and architecture were retained.

**Final verdict (22 October 2026): PARTIAL overall.** Batch 7 implementation,
documentation and automated verification are finished with no new failures.
The repository suite still has the two historical MCP failures; the explicitly
deferred browser/live-provider checks remain outstanding. This is not a
production-readiness claim. Batch 8 was not implemented.

## Remaining limitations and deferred checks

- Source resolution does not prove a claim, settle conflicting documents, or
  assess source reputation. Research planning/synthesis quality remains model
  dependent. General model knowledge must not be presented as retrieved evidence.
- MCP read-only annotations are a trust boundary with the configured connector;
  the application cannot prove an external server honors its advertised behavior.
- Retrieval can use a clearly labeled preview fallback. There is no OCR upgrade,
  new embedding model, semantic memory index or page-specific document viewer.
- Memory listing/relevance scans owned records. Prompt context is bounded, but
  storage/list pagination and retention/compaction are outside this batch.
- Existing single-worker connector credential/OAuth state and cross-store crash
  limitations from Batches 4B-2/6 remain. Cancellation prevents subsequent
  authorized work but cannot undo an external operation already completed.
- No live provider, web research, OAuth exchange, external write, actual browser
  history import or manual browser run was performed during verification.

After Batch 8, with separate authorization for any live inference:

1. Sign in using the existing owner's claimed browser profile. Verify all 13
   catalog entries reflect actual configured availability and consent.
2. Select Research Mode, ask a document question with two conflicting sources,
   observe progressive text/citations, and check that uncertainty is explicit.
3. Open cited documents in both themes, download the original, and verify page
   labels. Test a removed source, unsafe link and foreign attachment ID.
4. Cancel before tokens and mid-answer; reload/restart and inspect partial text,
   references, mode and revisions. Regenerate successfully and with a simulated
   failure; confirm previous valid references remain on failed regeneration.
5. Save/edit/delete a nonsensitive workspace fact, then open a later conversation
   in that workspace and one elsewhere. Repeat with a relevant user preference.
   Check duplicate/stale edits, loading/error states and unchanged personalization.
6. Verify session expiry, logout, CSRF, connector disconnect and quota exhaustion.
   Confirm an injected source cannot authorize writes, access foreign memory or
   restore revoked MCP handles. Do not rerun ownership claims or import local
   history as an incidental test.

## Batch-specific file manifest

Created:

- `backend/evidence.py`
- `backend/research.py`
- `backend/memory_store.py`
- `backend/knowledge_api.py`
- `backend/tests/test_knowledge.py`
- `backend/tests/test_research.py`
- `frontend/lib/knowledge.ts`
- `frontend/components/chat/SourceCitation.tsx`
- `frontend/components/settings/MemoryPanel.tsx`
- `frontend/tests/knowledge.test.mjs`
- `docs/BATCH_7_RESEARCH_RAG_MEMORY.md`

Modified:

- `backend/agent.py`
- `backend/app.py`
- `backend/auth.py`
- `backend/chat_execution.py`
- `backend/database.py`
- `backend/history_chat.py`
- `backend/history_store.py`
- `backend/mcp_client.py`
- `backend/rag.py`
- `backend/tool.py`
- `backend/tests/conftest.py`
- `frontend/components/chat/AssistantMessage.tsx`
- `frontend/components/chat/Markdown.tsx`
- `frontend/components/chat/Message.tsx`
- `frontend/components/layout/AppShell.tsx`
- `frontend/hooks/useChat.ts`
- `frontend/lib/api.ts`

Other modified/untracked files belong to earlier batches and were preserved.
No dependencies, `.env`, free-tier policy or Git history were changed.

The complete working tree's `git diff --stat` is **28 tracked files, 4,893
insertions and 5,317 deletions**. This includes earlier batches and excludes
untracked files; it is not a Batch 7-only diff. The batch manifest above lists
11 created and 17 modified files. The branch remains
`checkpoint/clawbit-pre-release-qa`.
