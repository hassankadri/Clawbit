# Clawbit

Clawbit is a locally hosted AI assistant with a Next.js interface and a
FastAPI/LangGraph backend. It supports authenticated chat, progressive SSE
responses, uploaded-document retrieval, explicit saved memory, research tools
and principal-scoped MCP connectors.

Offline tests verify application behavior and security boundaries. They do not
establish current provider availability, real-model reasoning quality or
production readiness. Manual browser and live-provider verification remain a
separate, explicitly authorized step.

## Implemented behavior

- A single initialized owner signs in with an HTTP-only session cookie. CSRF,
  exact origins and backend ownership checks protect private operations.
- Thirteen registered Google, Groq and OpenRouter models retain their actual
  configured availability. Free-account checks, exact model consent and disabled
  paid fallbacks remain mandatory; a registered model can be unavailable.
- Chat streams actual provider deltas. Stop preserves partial answers and
  releases local concurrency leases after cleanup.
- Server history retains conversation IDs, revisions, model/mode, attachments
  and citations. Edit/retry/regenerate reconstruct context without replaying
  side-effecting tools. Browser history import is explicit, never automatic.
- RAG uses Chroma/vector candidates, BM25, hybrid ranking and optional FlashRank
  reranking. Source opening rechecks ownership. Citation IDs establish retrieved
  provenance, not factual entailment.
- Research Mode uses read-only connector tools, bounded searches, deduplication
  and explicit partial/missing-evidence reports. Synthesis remains model dependent.
- Saved memory has confirmed create/update/delete controls, workspace and user
  scopes, duplicate prevention and version conflicts. Retrieval uses bounded
  lexical matching. A model cannot confirm or write a memory for the user.
- GitHub, Notion, Stripe, Google Drive and Slack connectors use principal-scoped
  credentials, OAuth/session binding where applicable, and stale-handle rejection.

There is no public registration, distributed credential vault, semantic memory
index, guaranteed prompt-injection immunity, automatic tool approval system,
OCR upgrade or secure physical erasure of deleted records. Project/library
metadata still includes browser-local storage; it is not a cloud file service.

## Structure

```text
backend/
  app.py, auth.py, ownership.py       HTTP, sessions and access boundaries
  agent.py, chat_execution.py         LangGraph, streaming and cancellation
  models.py, openrouter_model.py      Guarded model registry and adapters
  rag.py, evidence.py, research.py    Retrieval, citations and research policy
  history_store.py, history_chat.py   Durable revisions and turn receipts
  memory_store.py, knowledge_api.py   Confirmed memory and source access
  mcp_client.py, mcp_oauth.py         Connector lifecycle and credentials
  usage_limits.py, observability.py  Admission and structured diagnostics
  evaluate.py, evals/, tests/         Offline evaluations and regressions
frontend/                            Next.js/React/TypeScript application
.github/workflows/backend-ci.yml     Backend and frontend offline CI
docs/                               Batch reports and operational details
```

## Existing installation: ordinary startup

The current installation already has an owner and a completed legacy ownership
claim. **Do not rerun owner initialization or ownership migration.** Keep its
runtime directory, browser profile and backups. Do not reset a database to fix a
login, history or retrieval error.

Backend, in PowerShell:

```powershell
Set-Location 'D:\My Projects\Clawbit AI\backend'
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000 --no-access-log
```

In a second terminal:

```powershell
Set-Location 'D:\My Projects\Clawbit AI\frontend'
npm run dev
```

Open `http://localhost:3000` and sign in with the existing account. Use
`localhost` consistently, or `127.0.0.1` consistently. The default API uses the
browser's hostname on port 8000. Logout revokes the session on the server.
Connector credentials and pending OAuth state are in process memory: reconnect
after restarting the backend, using existing credentials. Use one backend worker.

## Fresh installation only

Prerequisites: Git, Windows PowerShell, Python 3.12 and Node.js 24 with npm.
The locally verified versions are Python **3.12.3** and Node **24.13.0**; CI pins
these versions. This is a compatibility snapshot, not a claim they are the latest
security releases. Review runtime upgrades separately and run the full checks.

From a new checkout:

```powershell
Set-Location backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt -r requirements-lock.txt
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe setup_owner.py
```

Owner setup is interactive: type `INITIALIZE`, choose a username and enter a
hidden 15–128 character passphrase twice. There are no default credentials or
password command-line arguments. Only a fresh installation needs this command.
For frontend dependencies, run `npm ci` from `frontend`, then start both services
as above. No dependency installation is needed for routine startup.

Existing unclaimed installations need a separately planned, backed-up ownership
claim with workers stopped. Read [ownership and recovery](docs/BATCH_4B_1_OWNERSHIP.md)
before any migration. The existing configured installation has already completed
that step. First use can perform additive history/memory schema upgrades with
SQLite backups; it must not recreate or reset existing stores.

## Configuration

Set process environment variables or configure a private local backend `.env`.
Never commit credentials. No real values belong in logs, screenshots or reports.

| Variable | Purpose |
| --- | --- |
| `GOOGLE_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | Optional provider credentials; missing providers fail closed |
| `TAVILY_API_KEY` | Web-search credential |
| `CLAWBIT_RUNTIME_DIR` | Stable private runtime root; defaults to the backend directory |
| `CLAWBIT_AUTH_MODE` | `local` by default; `production` requires HTTPS and secure cookies |
| `CLAWBIT_ALLOWED_ORIGINS` | Exact trusted frontend origins; explicit HTTPS values required in production |
| `CLAWBIT_FRONTEND_URL`, `CLAWBIT_PUBLIC_BACKEND_URL` | OAuth redirect/callback configuration; Slack requires HTTPS |
| `GOOGLE_MCP_CLIENT_ID`, `GOOGLE_MCP_CLIENT_SECRET`, `SLACK_MCP_CLIENT_ID`, `SLACK_MCP_CLIENT_SECRET` | Optional OAuth application configuration |
| `NEXT_PUBLIC_API_URL` | Optional frontend API origin, when overriding the local default |
| `CLAWBIT_LOG_LEVEL` | `DEBUG`, `INFO` (default), `WARNING`, `ERROR` or `CRITICAL` |
| `CLAWBIT_LIMIT_<OPERATION>_<SETTING>` | Positive operation limits; see the quota report |
| `CLAWBIT_TOOL_CALLS_PER_RESPONSE` | Default 12 across all tool rounds |

Google/Groq require billing-disabled free-only accounts and a matching credential
fingerprint attestation in `backend/free_tier_policy.json`. A changed key must be
reconfirmed; do not copy another account's attestation. OpenRouter requires the
exact allowlisted free model, zero advertised prices and an operational eligible
endpoint. Consent is per model and does not guarantee provider confidentiality.
See [free models and known provider limitations](docs/FREE_MODELS.md).

Ordinary pytest/evaluation commands use dummy keys, disable dotenv loading and
block external sockets. Do not run `model_smoke.py` as part of offline validation.
A live smoke requires separate explicit authorization and the existing free-tier
checks; never enable billing or paid fallbacks to make a test pass.

## Data, research and memory

Uploads and retrieval are authorized by the thread's owner. The existing limits
include 10 MiB per file, ten attachments per thread, bounded extraction and
1,500 chunks per document. Research sources can be opened through authenticated
previews/downloads; missing sources remain unavailable. Unknown citation IDs are
unverified. Conflicting sources must be assessed by the user; provenance alone
cannot establish which statement is true.

Use Saved memory to confirm workspace facts or personal preferences. Explicit
updates require the current version; deletion removes an item from future memory
context. Tombstones and backups can retain old content. Do not save credentials;
secret-pattern rejection is heuristic. Conversation history and LangGraph
checkpoints are distinct from saved memory.

Chat defaults to 20 requests/minute and 500/day; inference 40/1,000; upload and
ingestion 10/100; retrieval and embedding 60/2,000; MCP management 30/500; MCP
execution 60/1,000; built-in tools 60/2,000. Concurrency limits also apply. Fixed
UTC minute/day windows and counters persist across restarts. Admitted failed or
cancelled requests count. See [all quotas and reset rules](docs/BATCH_4B_2_MCP_LIMITS.md).

The bundled `get_project_status` MCP tool is an explicit local development
diagnostic. It reports four installed component versions over stdio and does not
read user data or test providers. It is not automatically added to every account
or exposed as an unauthenticated HTTP endpoint. Its real-protocol tests use the
same principal/generation guard as remote connectors.

## Verification and evaluation

From `backend`:

```powershell
.\.venv\Scripts\python.exe -m pytest tests -q -W error::RuntimeWarning --tb=short
.\.venv\Scripts\python.exe evaluate.py --category all
.\.venv\Scripts\python.exe evaluate.py --category rag --output .pytest_cache/rag-evaluation
```

Categories are `agent`, `rag`, `research`, `memory` and `all`. Reports default to
`.pytest_cache/evaluations/results.json` and `summary.md`. Every required scenario
must pass; missing, skipped or failed cases cause nonzero exit. The runner reuses
existing security/graph tests; those overlapping results must not be added to the
full-suite count. The manifest describes fixture input, allowed/forbidden actions,
expected behavior and objective assertion criteria.

The synthetic retrieval corpus measures recall/precision@3, MRR, hit rate, source
coverage, duplicate-content rate and latency. Actual BM25 is compared with the
production hybrid pipeline supplied controlled lexical candidates and an identity
reranker. This does **not** benchmark hosted semantic embeddings or learned
FlashRank quality. Citation validity/provenance are separate from claim
faithfulness. Relevance/performance baselines are reported honestly; deterministic
access/provenance invariants and a direct lookup are enforced gates.

From `frontend`:

```powershell
npm test
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run lint
npm run build
```

CI runs these commands on Windows with pinned dependencies, read-only repository
permissions and no provider secrets. It compiles Python without importing stores,
runs full pytest and offline evaluations, and retains evaluation artifacts for
seven days. Hosted CI has not run for these uncommitted changes. See the
[Batch 8 audit](docs/BATCH_8_FINAL_AUDIT.md) for measured results and limitations.

## Diagnostics and privacy

The `clawbit` logger emits JSON at operation boundaries, never per token. A
server-generated `X-Request-ID` correlates HTTP, authentication, graph admission,
tools/retrieval, persistence errors and SSE outcomes. Client IDs are not trusted.
Model/tool names use stable SHA-256 tags; owner IDs, resource IDs, request paths,
query strings, headers, prompts, responses and document content are not logged.
`DEBUG` adds bounded module/line frame locations without exception text, causes,
source lines or locals. Verbosity does not enable request-body logging.

Keep Uvicorn `--no-access-log`: OAuth callback query strings contain codes. Apply
the same restriction to proxies, and keep SDK body logging and LangSmith tracing
disabled. The structured boundary protects application events, not arbitrary
third-party loggers or OS diagnostics. Logs still reveal timing and operation
metadata; protect and rotate them using local host controls.

## Remaining limitations and manual acceptance

SQLite stores assume one trusted host and clock. Connector secrets are not an
encrypted persistent vault. A cancelled request cannot undo an external action
already dispatched. History/checkpoints/provider effects cannot share one atomic
transaction. Revisions and memory lack lifetime retention quotas and pagination.
Runtime files and backups require OS access controls; no encryption at rest is
added here. Semantic prompt injection remains a model risk even when roles,
authorization, read-only tool filtering and source handling are enforced.

After offline acceptance, follow the [deferred manual checklist](docs/BATCH_8_FINAL_AUDIT.md#deferred-manual-verification):
existing-owner login/logout, old-data preservation, explicit browser import,
stream/cancel/edit/retry, source access, memory scopes, connector reconnect/OAuth,
free-model availability and separately authorized live inference. Do not repeat
owner initialization or the completed legacy claim.
