# Batch 8: final engineering audit

## Status and scope

Verification date: 22 October 2026. **PASS for Batch 8 offline engineering acceptance.**
Implementation, documentation and local automated verification are complete. Browser testing, real inference, OAuth exchanges
and remote connector actions are explicitly deferred. This report does not
certify production readiness or real-model reasoning quality.

The preflight used the current local branch `checkpoint/clawbit-pre-release-qa`,
its accumulated tracked/untracked changes, repository instructions and reports
for Batches 4A, 4B-1, 4B-2, 5, 6, 7 and free-model integration. The retained
Batch 7 JUnit baseline was 743 passed and two historical MCP failures; frontend
had 90 passes and successful type/lint/build checks. No older remote code was
substituted for the working tree.

## Findings and corrections

| Finding | Resolution |
| --- | --- |
| Historical MCP tests assumed an automatic local connection | Add explicit local connection through the existing principal/generation path; test actual stdio discovery and execution |
| Local status tool returned a fabricated success sentence | Return measured installed versions for four allowlisted backend packages, without importing application stores |
| Existing RAG evaluation used expected-keyword sorting | Retain that compatibility regression; add a separate labeled corpus, measured ranking metrics and provenance gates |
| No category runner or durable evaluation reports | Add a small pytest-backed manifest/runner, JSON/Markdown reports and nonzero failure gates |
| Ad hoc prints and tool warnings lacked request correlation | Add one application JSON logger, request ContextVar and bounded operation events |
| Persistence and safe upstream errors lacked diagnostic context | Add sanitized storage/provider/tool failure events and optional bounded frame locations |
| CI covered only backend tests and omitted transitive pins | Add the installed dependency snapshot and frontend/evaluation jobs with fixed action commits |
| Manifest disagreed with the passing installed environment | Align requests 2.32.5 → 2.34.2 and beautifulsoup4 4.14.2 → 4.15.0; no package installation or upgrade occurred |
| Root/backend setup instructions were stale | Document actual startup, fresh-only owner setup, current features, limitations and offline verification |

The current graph, authenticated API, free-model checks, upload/RAG safeguards,
source ledger, explicit memory store, history receipts, OAuth binding and usage
store were reused. There is no new agent architecture, database schema, provider
fallback or ownership migration in Batch 8.

## Historical MCP root cause and protocol contract

`load_mcp_tools()` intentionally returns only servers explicitly connected by the
active principal. Batch 4B-2 tests enforce an empty catalog for unconfigured and
foreign principals. The old `test_mcp.py` called it without connecting anything,
then expected `get_project_status`. The second failure was `StopIteration` from
selecting that absent tool. This was a discovery/configuration mismatch, not a
broken GitHub transport or a missing installed MCP package.

The bundled `mcp_server.py` remained present, so it is retained as an explicit
local development diagnostic. `connect_local_mcp()` uses the running Python
executable and a fixed sibling script path. It passes no user-selected command,
filesystem path or token. The SDK's standard subprocess environment plus
`PYTHON_DOTENV_DISABLED=1` is used; no provider credentials are forwarded explicitly.
The server imports only MCP and installed-package metadata. Its no-argument,
read-only tool returns `project`, `transport` and versions of FastAPI, LangGraph,
MCP and the LangChain MCP adapter. Missing packages are reported as null, not
pretended healthy. It does not claim model, database or remote-service health.

Connection, discovery and invocation use existing quota admission, owner context,
connection epochs, wrapper validation and cancellation machinery. Disconnect and
reconnect invalidate old handles. There is no automatic connection, environment
credential claim, unauthenticated endpoint or new UI connector option.

The original two test names remain. Their assertions now test the actual protocol
contract: discover the exact tool, verify read-only metadata and empty argument
schema, invoke a real stdio process, compare all measured versions, reject foreign
principals and reject disconnected/reconnected stale handles. An additional test
rejects anonymous connection. The focused real-local/remote-mock MCP suite passed
60 cases. No remote write or credential exchange was performed.

## Evaluation design

`backend/evals/scenarios.json` defines stable scenario IDs, categories, synthetic
inputs, expected behavior, allowed/forbidden actions, assertion criteria and failure
categories. It references real graph, API, SSE, checkpoint and store tests rather
than implementing a second agent. Parametrized tests yield separate result rows.

`evaluate.py` imports no application modules before pytest loads `conftest.py`.
That fixture establishes temporary runtime stores, dummy keys, disabled dotenv
and tracing, explicit principals, isolated ownership/history/memory/usage stores
and external-network blocking. The new corpus never accesses real uploads,
embeddings, owner records or the installation's four legacy memories.

The runner records pass/failure and numeric test properties without copying raw
exceptions, captured output or private application data into its artifacts. A
failed setup/teardown overrides a passing call. Missing or skipped cases fail the
gate even if pytest otherwise exits zero. Regressions exercise each of those
outcomes and the actual JSON/Markdown writer. Category filtering selects only
manifest cases; full pytest additionally covers runner/metric regressions.

Coverage includes:

- Real graph tool routing, all 13 model IDs, model switching and checkpoint reuse.
- Multi-step document/connector/calculator execution and sanitized tool failure.
- Unknown tools, missing required arguments and invalid typed arguments in both
  modes: exactly one error ToolMessage and zero tool-body executions.
- Tool budgets, research-only read permissions, refresh annotation changes,
  unauthorized principals and stale handles.
- Role/data prompt-injection boundaries, cancellation, retained partial evidence,
  no repeated side effects on edit/regeneration and idempotent saved responses.
- Conflicting/empty/failed research evidence, repeated and parallel search dedup,
  citation persistence, history restoration and failed-revision preservation.
- Confirmed memory creation, scope isolation, personalization, later-chat relevance,
  duplicate/concurrent writes, version conflicts, deletion, secret rejection,
  hostile source instructions, legacy backup and restart persistence.
- Authorized source preview/download, anonymous/foreign rejection, missing files,
  corrupt legacy rows, invalid reranker indices and explicit preview fallback.

These are application orchestration and safety evaluations. Controlled providers
supply predetermined decisions; they do not demonstrate model intelligence,
semantic injection resistance or actual internet research.

## Retrieval and citation methodology

The non-sensitive JSON corpus has nine chunks (including one foreign-thread
contaminant), eight queries and K=3. It includes factual/paraphrased lookups,
multiple chunks from one document, conflicting documents, distractors, duplicate
content, missing evidence and injected instructions. Separate scenario tests
exercise workspace/owner isolation and corrupt/unavailable sources.

The first measured method calls production `_bm25_search` over a controlled
index fixture, including its metadata authorization. The second calls production
`retrieve_from_rag` with deterministic lexical-cosine candidates, actual BM25,
production hybrid merge/diversity and an identity reranker through the existing
reranker adapter. It deliberately does not download FlashRank weights or call
hosted embeddings. Its label is
`hybrid_controlled_candidates_identity_reranker`, not a real-vector quality score.

For each query, the report stores selected chunk IDs and:

- Recall@3: distinct relevant chunks returned / labeled relevant chunks.
- Precision@3: distinct relevant chunks returned / 3, including empty slots.
- Reciprocal rank: inverse first relevant rank, or zero for no relevant result.
- Hit rate: whether any labeled relevant chunk was returned.
- Source coverage: relevant document IDs represented / relevant document IDs.
- Duplicate-content rate: 1 − unique text bodies / returned chunk count.
- Wall-clock retrieval latency in milliseconds, with cold application cache.

No-evidence queries have null recall/hit/source coverage; aggregate values for
those metrics exclude them. Precision and MRR include all eight queries. The
benchmark intentionally records unrelated retrieval for the missing-evidence
query rather than describing it as an abstention success. There is currently no
calibrated semantic relevance/abstention threshold.

Enforced gates are exact source metadata/authorization/citation invariants and
MRR=1 for a rare-term direct BM25 lookup. All other retrieval quality values are
baseline measurements; there is no post-hoc threshold selected to force a pass.
Latency is descriptive because hardware, process load and logging affect it.

Citation evaluation validates each returned SourceRecord, resolves actually
registered IDs, compares document/page/chunk metadata, and inserts unsupported
IDs that must be marked unverified. Source access tests exercise actual temporary
upload bytes, foreign/anonymous denial and removed files. This measures provenance
and access handling, not whether a cited claim is true. No faithfulness score is
reported.

## Measured results

Final offline evaluations: **91 passed, 0 failed**, across 30 scenario definitions and 91 parametrized cases. No scenarios were missing.

| Category | Cases passed |
| --- | ---: |
| Agent | 51 |
| Research | 13 |
| Memory | 21 |
| Rag | 6 |

| Method | Recall@3 | Precision@3 | MRR | Hit@3 | Source coverage | Duplicate rate | Mean ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BM25 | 1.0000 | 0.4583 | 0.7917 | 1.0000 | 1.0000 | 0.0417 | 0.6860 |
| Controlled hybrid / identity reranker | 0.8571 | 0.3750 | 0.7917 | 1.0000 | 1.0000 | 0.0417 | 11.0366 |

BM25 outperformed the controlled hybrid path on chunk recall in this fixture.
The production diversity pass favors different attachments and can omit a second
relevant chunk from one document. Both methods returned duplicate content across
different documents; deduplication is not global semantic/content deduplication.
The no-evidence query returned unrelated candidates. These results do not justify
a claim that hybrid or reranking is universally better.

Citation checks resolved **24/24 registered records**, validated **24/24 IDs** and
preserved **24/24 metadata records**. All eight inserted unsupported IDs were
detected. Foreign-thread metadata was excluded in every tested retrieval and the
cross-owner retrieval was rejected. The real source-access scenario passed two
authorized reads, three unauthorized rejection checks and two removed-file
checks (2/2 safe missing-source handling). These are deterministic provenance
and authorization gates, not semantic faithfulness.

Labeled lexical memory retrieval returned the exact expected sets for all three
queries: precision 1.0, recall 1.0 over two relevant facts, and correct empty
retrieval for the unrelated query. This small exact-lexical fixture does not
establish semantic memory quality. All six invalid-tool-argument cases produced
one error ToolMessage and **zero tool-body executions**.

Raw per-query measurements and individual scenario results are retained locally
in `backend/.pytest_cache/evaluations/results.json` and `summary.md`. These cases
overlap the full backend suite and are not added to its total.

## Logging and tracing

`observability.py` uses standard Python logging and an application-owned handler.
Repeated configuration does not add duplicate handlers, and application events do
not propagate into duplicate root handlers. `CLAWBIT_LOG_LEVEL` controls verbosity.
No logging infrastructure or paid service was added.

The outer ASGI middleware creates a random correlation ID, returns `X-Request-ID`,
and holds a ContextVar through authentication, graph tasks, supported worker
threads and the entire SSE lifetime. IDs from callers are ignored. Tests interleave
two async requests, execute worker-thread events and verify independent IDs plus
context cleanup. Identifiers confer no ownership or quota privileges.

Events cover HTTP start/finish; authentication/origin/CSRF failures; authorization
denials; chat/research admission; provider/model selection and failures;
quota rejection; budgeted tools/MCP/retrieval/embedding; reranking counts/fallback;
unknown citations; MCP connection/disconnection; memory failures; history and
checkpoint persistence failures; research partial reports; SSE terminal outcomes.
The existing admission context prevents logging nested SDK delegation per token.
An operation can complete locally while returning a sanitized error result; the
separate failure event preserves that distinction. SSE completion is observed from
fixed event prefixes; HTTP 200 alone is never treated as proof of stream success.

Fields include UTC timestamp, severity, server request ID, operation/status,
allowed categories, bounded counts/duration/status codes, provider and hashed
model/tool tags. SHA-256 tags are stable identifiers, not encryption. No owner
correlation is needed, so principal IDs are not logged.

Redaction is restrictive: unknown keys and free-form text are discarded; nested
containers have depth/item bounds. Allowed enum values and numeric fields survive.
Passwords, headers, tokens, callback URLs, resource IDs, prompts, model output,
private documents, tool arguments and upstream error payloads are never passed as
log message content. Exceptions are not formatted. DEBUG records at most eight
module-basename/line locations, without locals, source text, causes or raw messages.

Tests use nested secret objects, a deliberately unformattable exception, forged
request IDs, parallel contexts, quota rejection, failed checkpoint reads and SSE
completion/error/cancellation. All preserve actual error and cleanup semantics.
Application redaction is not a guarantee for arbitrary SDK/root loggers, proxy
access logs or OS diagnostics. Keep Uvicorn `--no-access-log`, omit callback query
strings at proxies and leave SDK body/LangSmith tracing disabled. Log storage,
rotation and access permissions remain host/operator responsibilities.

## CI and reproducibility

The existing workflow now has separate backend and frontend jobs on
`windows-2022`, matching the developer's tested OS and avoiding an unverified
second dependency platform. Python 3.12.3 and Node 24.13.0 match local validation.
Actions are pinned to verified full release commit IDs, following
[GitHub's immutable-action guidance](https://docs.github.com/en/actions/reference/security/secure-use).
Checkout credentials are not persisted; workflow permissions are `contents: read`.
There is no `pull_request_target`, secret mapping, deployment or write-capable
repository token. Ordinary pull requests, pushes and manual dispatch trigger it.

Backend installs direct/dev requirements plus the exact installed transitive
snapshot, checks dependency consistency, compiles root/test modules without app
imports, runs full pytest and the offline evaluation runner. Temporary runtime,
dummy credentials and disabled dotenv/tracing are explicit. Conftest provides
additional per-test stores and network guards. The local MCP subprocess runs only
the bundled read-only metadata server. The frontend uses `npm ci`, existing lockfile,
tests, installed TypeScript, ESLint and build. Evaluation JSON/Markdown artifacts
have seven-day retention. Dependency installation itself needs package-network
access; the tests do not perform live provider work.

The snapshot pins 139 installed distributions (excluding pip). Pywin32 is marked
Windows-only. The frontend lockfile already exists and remains unchanged.
`pip check` passed; direct requirements and every snapshot pin match installed
metadata. Requests/BeautifulSoup manifest drift was corrected without installing
anything. Versions are not a vulnerability certification; snapshot refresh and
security patch evaluation remain deliberate maintenance work. Wheel hashes,
a fresh clean-environment install and Linux/macOS validation are not claimed.

Workflow YAML, job structure, permissions, action SHAs and dependency pins were
validated locally. The commands were run against installed environments. **Hosted
GitHub Actions has not run**, and local checks cannot prove runner/download/cache
behavior. No commit or push was made.

## Security and code-quality review

The focused review covered auth/CSRF/cookies/session lifetime, ownership ContextVars,
quota leases, MCP credentials/OAuth epochs, graph tool budgets/replay, provider
allowlisting, RAG metadata filtering, citations, memory confirmation, history
receipts and frontend auth/history/stream handling. Existing security assertions
remain enabled. Instrumentation does not change authorization, admission, model
fallback, public error messages or persistent schemas.

Targeted changes replace ad hoc prints, centralize safe persistence diagnostics,
bound metadata traversal, keep cancellation outside ordinary exception handling
and make correlation cleanup unconditional. Existing large graph/API modules were
not broadly reformatted or restructured. New Python files were reviewed for names,
typing, formatting and non-obvious comments; no formatter dependency was installed.
The installed frontend linters/types were run without changing frontend code.

Data preservation is established by execution scope: test imports use isolated
runtime roots before storage initialization; new MCP code opens no application
stores; compilation imports no application code. No real owner initialization,
ownership claim, browser import, data deletion, Chroma reindex or backup restore
was run. Existing sessions, 93 claimed resources, IDs, uploads, memories and backups
were not intentionally read or modified by these checks. This is not a fresh
content-by-content inventory of the real installation.

## Verification commands

Backend commands run from `backend`:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_mcp.py tests/test_mcp_compatibility.py tests/test_mcp_isolation.py -q -W error::RuntimeWarning --tb=short
.\.venv\Scripts\python.exe -m pytest tests/test_evaluations.py tests/test_observability.py -q -W error::RuntimeWarning --tb=short
.\.venv\Scripts\python.exe -m pytest tests -q -W error::RuntimeWarning --tb=short -o faulthandler_timeout=90 -o junit_family=legacy --junitxml=.pytest_cache/batch8-final.xml
.\.venv\Scripts\python.exe evaluate.py --category all
.\.venv\Scripts\python.exe -m pip check
```

Frontend commands run from `frontend`: `npm test`,
`node node_modules/typescript/bin/tsc --noEmit --incremental false`,
`npm run lint`, `npm run build`.

Python compilation uses `py_compile.compile(..., doraise=True)` over backend root
and test modules without importing stores. Root checks are `git diff --check`,
`git diff --stat` and `git status --short`, plus UTF-8/newline/trailing-whitespace
review for newly untracked files.

| Final check | Result |
| --- | --- |
| Full backend pytest | **769 passed, 0 failed, 0 skipped; 13 existing deprecation warnings; 306.99 seconds** |
| Historical MCP targets and compatibility/isolation | **60 passed** in the focused run; included in full-suite count |
| Final offline evaluations | **91 passed, 0 failed; 30 scenario definitions** |
| Focused new evaluation/logging checks | 22 passed before the final checkpoint logging case; that case passed in the full suite |
| Frontend tests | **90 passed, 0 failed, 0 skipped** |
| TypeScript | PASS |
| ESLint | PASS |
| Production build | PASS, 12 static pages generated |
| Python compilation | PASS, all 56 backend root/test modules; no application imports |
| Dependency consistency | `pip check` passed; all direct/transitive snapshot versions match installed metadata |
| Workflow checks | YAML, action pins, least privilege and local commands validated; hosted run not performed |
| Git whitespace | `git diff --check` passed |

The 13 warnings concern the existing Starlette/httpx TestClient and legacy
`datetime.utcnow()` calls. Runtime coroutine warnings were treated as errors.
The first full pass had two extra JUnit-format warnings from evaluation numeric
properties; using the compatible `junit_family=legacy` retains those properties
and removes the format mismatch without suppressing warnings. No test was skipped,
deleted, xfailed or weakened. Earlier full/focused runs are not added to these
counts. The runner's final Markdown-only layout was also checked with the RAG
category command after the full run.

All auth/CSRF/ownership, upload/SSRF, model/free-tier, MCP/OAuth, quota, streaming,
history, research/citation and memory regressions pass. The two historical MCP
failures are resolved, not excluded. Batch 8 adds 24 cases relative to the prior
745-case suite and converts its two failures to passes.

The first sandboxed MCP test process stalled without output and was interrupted;
the real stdio run passed outside that Windows restriction. The first production
build encountered the known SWC directory-canonicalization access denial; the
same build passed outside the sandbox. An initial new quota-logging test changed
environment variables after store initialization; its fixture now configures the
isolated store directly. No production limit or assertion was weakened.

## Batch-specific file manifest

Created:

- `backend/evaluate.py`
- `backend/evals/scenarios.json`
- `backend/evals/retrieval.json`
- `backend/observability.py`
- `backend/requirements-lock.txt`
- `backend/tests/test_evaluations.py`
- `backend/tests/test_observability.py`
- `docs/BATCH_8_FINAL_AUDIT.md`

Modified (including files already untracked from previous batches):

- `.github/workflows/backend-ci.yml`
- `README.md`
- `backend/README.md`
- `backend/agent.py`
- `backend/app.py`
- `backend/auth.py`
- `backend/evidence.py`
- `backend/history_chat.py`
- `backend/mcp_client.py`
- `backend/mcp_server.py`
- `backend/models.py`
- `backend/owned_checkpoints.py`
- `backend/rag.py`
- `backend/research.py`
- `backend/requirements.txt`
- `backend/tests/test_mcp.py`
- `backend/tests/test_knowledge.py`
- `backend/untrusted_content.py`
- `backend/usage_limits.py`

This list is Batch 8-specific. The complete Git diff also contains Batches 1–7
and excludes newly untracked files. No frontend source or lockfile was edited in
this batch. No `.env`, account attestation, credential, database or Git history
was changed.

## Remaining limitations and follow-up work

Required offline checks passed. Separate follow-ups include hosted CI execution, clean dependency installation validation,
real embedding/reranker quality measurement, larger labeled retrieval datasets,
calibrated missing-evidence abstention and separately authorized live-provider
checks. No real-model faithfulness, reasoning or semantic injection score exists.

Existing limitations remain: singleton account UI; single-worker in-memory
connector credentials; MCP annotations depend on server honesty; subprocesses run
with backend OS privileges; cooperative cancellation cannot undo dispatched remote
actions; history/checkpoints/upstream effects lack one atomic transaction; local
SQLite assumes trusted clock/host; revisions/memory lack pagination/retention;
backups and tombstones retain private content; no encryption-at-rest addition.

## Deferred manual verification

Perform only after offline Batch 8 acceptance, using explicit authorization for
live inference/OAuth/remote actions and disposable data for destructive exercises.

1. Preserve a runtime backup and browser-history export. Use the existing owner
   and claimed browser profile. Do not rerun owner setup or the 93-resource claim.
2. Sign in, refresh, expire/revoke a session and log out. Confirm private UI/API
   access closes and existing account/session behavior remains intact.
3. Check old conversations, checkpoints, uploads, memories and project associations
   before changing anything. Import legacy browser history only with explicit
   confirmation; retry an import and inspect conflicts without erasing originals.
4. Confirm all 13 registered models show actual current eligibility. Check exact
   model consent and unavailable-provider messaging. Never enable paid fallback.
5. With separately authorized free inference, verify progressive SSE, Unicode and
   Markdown/code, Stop before/after tokens, disconnect/reload and a fresh request.
6. Edit an earlier turn, regenerate and retry; inspect retained revisions, canonical
   context, attachment references and citations. Confirm no remote write is replayed.
7. Upload disposable supported files, retrieve direct/paraphrased questions, compare
   conflicting sources and inspect missing evidence. Exercise preview/download,
   real page labels and removed/foreign source rejection.
8. Use Research Mode with authorized sources; observe read-only connector selection,
   repeated-search dedup, explicit tool-budget partial work and restored references.
9. Confirm memory save/update/delete, user/workspace scopes, stale-version errors,
   relevance in another chat, deletion exclusion and unchanged personalization.
10. Reconnect GitHub and other intended connectors using existing least-privilege
    credentials. Test disconnect/stale tools and restart behavior. Authorize OAuth
    separately; test denial, replay, wrong session and logout during callback.
11. In an isolated installation, exercise quota/concurrency limits, same-thread
    requests, cancellation cleanup and persistent daily counters. Do not exhaust
    real provider quotas or fill the real user's upload store for this test.
12. Inspect a successful and failed request's JSON events using X-Request-ID. Confirm
    no private content, callback query strings, session cookies or provider bodies
    enter application/proxy logs. Keep SDK body tracing disabled.
13. Check narrow layouts, themes, keyboard interactions, source dialogs, saved-memory
    controls and navigation during streaming. Offline Node tests are not DOM E2E.
14. When a commit/push is separately authorized, observe the hosted CI jobs and
    artifact retention. Do not infer hosted success from local verification.

## Final working-tree summary

Batch 8 changed **27 files: eight created and nineteen modified**. The complete
accumulated tracked diff reports **32 files changed, 5308 insertions(+), 5625 deletions(-)**. Git status reports
32 tracked modified paths and 65 untracked entries (some entries are directories).
These totals include prior batches; untracked files are not included in diff stat.
The branch remains `checkpoint/clawbit-pre-release-qa`. No commit, push, reset,
stash, branch switch or real runtime migration was performed.

**Verdict: PASS for the requested offline Batch 8 work.** Hosted CI and deferred
manual/live checks remain unverified; this is not a production-readiness claim.
