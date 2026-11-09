# Clawbit Vercel Deployment Plan

**Status:** compatibility inventory complete; implementation not started  
**Baseline:** `eb1428b50f901a8fc67782e34225e8c230f4ea87`  
**Working branch:** `deployment/vercel-migration`

This plan is intentionally separate from the pre-deployment audit branch. No production deployment, local database, uploaded file, or credential has been modified.

## 1. Recommended Vercel layout

Use two Vercel projects from the same Git repository:

1. **Frontend project** — Root Directory `frontend/`, Next.js.
2. **Backend project** — Root Directory `backend/`, FastAPI Python runtime. The backend directory already contains `app.py` and `requirements.txt`, which are recognized by Vercel when that directory is the project root.

The browser should continue calling the same-origin `/api` path. Configure the frontend project to rewrite `/api/:path*` to the backend project's stable deployment URL, stripping the `/api` prefix. This matches the existing production default in `frontend/lib/auth.ts`, while keeping the browser's session cookie on the frontend origin. Do not cache API rewrites, especially authentication, chat streams, uploads, and connector routes.

Use the frontend origin for:
- `CLAWBIT_ALLOWED_ORIGINS`
- `CLAWBIT_FRONTEND_URL`
- the public OAuth callback base URL (OAuth callbacks must also pass through the same `/api` rewrite so the browser session cookie is present).

Validate the forwarded scheme/host behavior in a Vercel Preview before allowing production authentication. Do not assume the local `production_server.py` proxy allowlist is the correct Vercel configuration.

## 2. Proposed managed storage

Prefer a small number of managed services:

- **Neon Postgres:** transactional application data, accounts/sessions, usage limits, connector state, conversation history, memory, and LangGraph checkpoints.
- **Neon pgvector:** replace the embedded Chroma collection, subject to a retrieval/evaluation comparison and an explicit embedding-dimension decision.
- **Neon Object Storage (private S3-compatible buckets; preferred candidate):** uploaded document/image bytes. Neon currently lists 5 GB object storage per Free project, with branch-aware objects. Keep attachment metadata, ownership, status and manifests in Postgres; use private buckets and backend-authorized access. Validate region availability, access signing, and migration volume before locking this choice. Vercel Blob remains a fallback (Hobby currently includes 1 GB storage/month and 10 GB transfer/month).
- **No Redis initially:** use Postgres transactions and short-lived rows for coordination where reasonable. Add Redis only if measured contention or polling makes it necessary.

Do not treat Vercel Function `/tmp` as durable storage. It is scratch space only.

## 3. Current persistence inventory

| Existing component | Current location / behavior | Required deployment change |
| --- | --- | --- |
| Authentication | `auth_store.py` stores users, password hashes, sessions, setup tokens and login throttles in SQLite via `auth.sqlite3` | Postgres adapter; preserve password hashes and principal IDs during an explicit migration; decide how sessions are handled |
| Conversation history | `history_store.py` writes `data/chatbot_memory.db` | Postgres adapter and transactional migrations |
| Saved memory | `memory_store.py` uses the same `data/chatbot_memory.db` file as history | Move both schemas/data together; preserve workspace ownership, versions, tombstones and audit records |
| Usage and coordination | `usage_limits.py` stores counters, leases and connector epochs in `data/usage.sqlite3`; leases identify a local PID/process | Postgres-backed atomic quotas/leases; replace PID/process-stamp assumptions with expiring distributed leases |
| MCP credentials | `mcp_credentials.py` stores encrypted token records in `data/mcp_credentials.sqlite3` | Store encrypted credentials in managed durable storage; Windows DPAPI-encrypted records cannot simply be copied to Linux; plan a secure re-encryption or connector reauthorization |
| LangGraph checkpoints | `agent.py` / `agent_cache.py` use `data/langgraph_checkpoints.sqlite` through `OwnedSqliteSaver` | Replace SQLite saver with `AsyncPostgresSaver`, retaining the existing server-side thread ownership checks |
| RAG vectors | `rag.py` creates embedded Chroma at `chroma_db/` during module import | Replace with managed pgvector; keep authorization filters on every search/delete |
| Uploaded files and manifests | `rag.py` writes files and JSON manifests under `uploads/` | Store bytes in private object storage and metadata/manifests in Postgres; read through owner-checked backend operations |
| OAuth state/tokens | `mcp_oauth.py` keeps OAuth state, access tokens, versions and refresh locks in process memory | Persist state and token metadata in a shared store with TTL, one-time consumption, session binding and epoch checks |
| Pending MCP approvals | `mcp_approval.py` keeps pending approvals and events in process memory | Shared approval records and cross-instance notification/polling; approval must remain one-time and fail closed |
| MCP runtime connections | `mcp_client.py` caches connector sessions/tools per process | Treat caches as disposable; redesign transport for serverless execution |
| Agent/RAG caches | Process-local caches in `agent_cache.py` and `rag.py` | Keep only as optional optimizations; correctness must never depend on cache survival |

## 4. Important runtime constraints

- Vercel supports FastAPI on its Python runtime and supports streamed responses. Clawbit's SSE chat path can be retained, but it must be tested through the actual frontend rewrite and production-like function.
- The FastAPI application is deployed as a Vercel Function, not a permanent ASGI server. Instances can be cold-started, reused, or scaled independently.
- Function shutdown cleanup receives only a short grace period. Durable writes must finish within the request; shutdown must not be used to save state.
- Use a conservative request duration compatible with Hobby until the Vercel plan is confirmed. Long research/tool calls need explicit timeout and cancellation handling.
- Standard Python function bundles have a 500 MB limit. Vercel documents a larger-function beta for eligible Fluid Compute deployments; measure the built backend bundle instead of assuming the current AI dependencies fit.
- `rag.py` creates directories and opens Chroma during import. This is incompatible with the read-only deployment filesystem and must be removed as part of the RAG adapter change.
- `usage_limits.py` assumes a stable local process identity for leases. That assumption is not valid for independently invoked serverless functions.
- `mcp_client.py` launches Notion/Stripe MCP servers through `npx -y`. Do not assume the Vercel Python runtime has a suitable Node/npm binary or that stdio child processes survive between invocations. Move these connectors to supported remote HTTP MCP endpoints or a separately hosted MCP runtime after verifying provider support.

## 5. Safe migration rules

1. Keep the local Windows installation untouched and usable.
2. Back up each SQLite database and the uploads/Chroma directories before any export. For SQLite databases using WAL mode, use SQLite's online backup API (or stop the application and perform a verified checkpoint/backup); never copy only the main `.sqlite`/`.db` file while committed data may remain in `-wal`. Treat `-shm` as transient coordination state, not as a database backup.
3. Build an idempotent, dry-run-first migration tool; never make deployment startup migrate or reset user data.
4. Preserve user IDs/principal IDs, thread/workspace ownership, attachment IDs, history revisions, memory versions, and connector epochs.
5. Do not transfer plaintext secrets through logs, chat, source control, or migration reports.
6. Test import into an empty Preview database first. Verify counts, ownership checks, retrieval, and downloads before migrating any real user data.
7. Keep the local source and backups until an independently verified restore has succeeded.

## 6. Implementation sequence

1. Add deployment-specific configuration and health/readiness checks without changing storage.
2. Add Postgres schema/migrations and adapters, beginning with auth, history, memory and usage.
3. Move LangGraph checkpoints to Postgres and retain ownership enforcement.
4. Move uploads to private Blob and Chroma to pgvector; compare retrieval/evaluation results.
5. Move OAuth/approval state to shared storage and resolve MCP stdio execution.
6. Add Vercel project configuration, same-origin API rewrite, security headers and environment documentation.
7. Deploy Preview, run automated tests, and verify login, chat SSE, upload, retrieval, delete, OAuth and MCP flows.
8. Migrate data only with explicit approval and a tested rollback/restore path.

## 7. Vercel Hobby constraints and data-handling gate

The first deployment target is Vercel Hobby (Free). Use it only for personal/non-commercial use, consistent with Vercel's current Hobby terms. Before making the hosted application available for third-party commercial use, reassess the plan and terms.

Current design constraints to validate in Preview:

- Hobby Functions using Fluid Compute have a maximum duration of 300 seconds. Vercel's general proxied-request timeout is 120 seconds. Since the frontend is planned to call the backend through a same-origin rewrite, keep proxied user-facing requests within the documented proxy limit and test SSE behavior end-to-end; move genuinely long work to a durable job/worker pattern with status polling.
- Hobby Functions use the standard 2 GB memory / 1 vCPU allocation. Hobby users cannot configure a larger allocation.
- Python function bundles have a 500 MB uncompressed size limit. Measure the actual deployed bundle and exclude tests, local databases, Chroma data, uploads, caches and other non-runtime files. Keep runtime dependencies minimal.
- Hobby includes finite monthly usage: current included amounts include 4 active CPU-hours, 360 GB-hours provisioned memory, 1 million function invocations and 100 GB-hours function duration. Monitor usage rather than designing around unlimited free compute.
- Vercel Blob's Hobby allowance is limited (currently 1 GB storage/month and 10 GB transfer/month). Confirm current limits before moving the user's existing upload library there; compare other managed object-storage options if the data volume exceeds this.
- Verify the selected Postgres provider's free-tier limits, backup/restore options, region and connection pooling separately. The database is a separate service and is not included in the Vercel Hobby plan.

**Privacy and AI-training clarification:** Vercel's March 2026 terms update describes optional AI-model training based on code, Vercel Agent chats, build/deployment telemetry and aggregate traffic statistics. The update says Hobby (including Trial Pro) is opted in by default, with a self-serve opt-out in Team and Project Settings; it also says personal information, account details, environment variables, API keys and other sensitive content are anonymized/redacted before use or sharing. This source does **not** establish that ordinary application users' Clawbit chat messages or uploaded documents are automatically used for AI training. Do not overstate that claim. Before connecting the repository, review Team/Project Data Preferences and opt out of code/Agent-chat training if desired. Separately review the privacy, retention and training settings of every model API, database, object-storage and logging provider that will process Clawbit user data.

Until the Preview architecture and provider privacy settings are reviewed:
1. Keep all original local data and backups untouched.
2. Use synthetic/anonymized fixtures for deployment and migration tests.
3. Do not put real connector tokens, private documents or chat history in Preview.
4. Keep real-data migration as a separate, explicit user-approved step after provider selection and privacy review.

References:
- Vercel Hobby plan: https://vercel.com/docs/plans/hobby
- Vercel general limits: https://vercel.com/docs/limits
- Vercel Function limits: https://vercel.com/docs/functions/limitations
- Vercel Python runtime and bundle: https://vercel.com/docs/functions/runtimes/python
- Vercel Function memory: https://vercel.com/docs/functions/configuring-functions/memory
- Vercel Blob pricing/usage: https://vercel.com/docs/vercel-blob/usage-and-pricing
- Vercel Terms of Service: https://vercel.com/legal/terms
- Vercel March 2026 terms update: https://vercel-docs.vercel.sh/changelog/updates-to-terms-of-service-march-2026

## 8. Open decisions before the first live Preview

- **Vercel plan confirmed: Hobby (Free).** Treat the hosted app as a personal/non-commercial deployment; upgrade before commercial use.
- Confirm the storage provider/region and align the Vercel Function region with the database/object-store region. Neon lists Singapore (`ap-southeast-1`) as an available region; Vercel supports `sin1`. Validate current account availability before setting it.
- Existing local installation migration is required; a fresh hosted account is not acceptable. Keep original local files and data untouched.
- Which OAuth/MCP integrations must be available in the first hosted release.

## 9. Local migration inventory baseline (2026-11-09)

Read-only inspection of the existing Windows installation reported:

| Store | Observed state |
| --- | --- |
| Authentication | SQLite integrity OK; 2 users, 2 user-identity rows, 1 legacy owner and 1 legacy owner-identity row; 2 sessions; 0 setup tokens |
| Conversation/history database | SQLite integrity OK; 7 conversations (all active), 30 revisions, 0 orphan revisions; 4 legacy memory records; 1 workspace |
| LangGraph checkpoint database | SQLite integrity OK; WAL journal mode; 840 checkpoints and 1,023 writes; main DB 79.28 MB, WAL 3.86 MB, SHM 0.03 MB at inspection |
| Ownership registry | SQLite integrity OK; 96 threads and 11 workspaces; all 107 resources currently assigned; 1 historical claim covering 93 resources; 0 rollbacks |
| Usage database | SQLite integrity OK; 14 usage rows; 0 active lease rows; 0 connector epochs |
| MCP credential store | `mcp_credentials.sqlite3` was not found at the configured data path |
| Main runtime files | `backend/uploads` 11.43 MB; `backend/chroma_db` 2.35 MB; root-level folders and ownership-backup snapshots are separate and are not assumed to be live data |

The auth inventory reports two user accounts; preserve both users, roles, numeric IDs, password hashes and principal identities. Expire imported sessions rather than copying active browser sessions. Do not assume the legacy owner row is a separate account from the admin user row; verify the matching identity mapping before import.

Legacy memory behavior must be preserved: four `long_term_memory` rows have no `memory_details` / `memory_audit` rows, and the current reader applies legacy defaults (`scope=workspace`, `version=0`, `deleted=0`). Do not fabricate historical audit entries.

The ownership reconciliation was completed using a read-only comparison between `auth.sqlite3` and `ownership.sqlite3`:

| Account role | Resource kind | Current total | Covered by original claim | Outside original claim |
| --- | --- | ---: | ---: | ---: |
| Admin | Threads | 93 | 89 | 4 |
| Admin | Workspaces | 8 | 4 | 4 |
| User | Threads | 3 | 0 | 3 |
| User | Workspaces | 3 | 0 | 3 |
| **Total** | | **107** | **93** | **14** |

All 107 resources map to one of the two existing account principal identities; there are no unassigned or unmapped resources in this snapshot. The 14 resources outside the original claim are currently assigned (8 admin, 6 user), consistent with resources created after the historical claim. The one legacy owner identity matches the admin user's principal identity. All 7 visible conversations and the 1 listed workspace map to an existing account; 0 conversation revisions are orphaned. No records were modified during these inspections.

This is a successful ownership baseline, not proof that every attachment/vector record is correctly linked. Before migration sign-off, reconcile per-account conversation, workspace, memory, upload and Chroma metadata counts. Preserve both users and their distinct principals; do not collapse the regular user into the admin. Do not reassign any resource as part of migration.

The checkpoint database uses WAL mode. A migration backup must use SQLite's online backup API or a controlled application stop and verified checkpoint. Never copy only the main database file while committed transactions may remain in the WAL. The SHM file is transient coordination state, not an authoritative backup input.

These counts are an observation snapshot, not a hard-coded expected production dataset. Re-run counts and hashes at export and post-import time; require exact reconciliation before cutover.

## References

- Vercel FastAPI: https://vercel.com/docs/frameworks/backend/fastapi
- Vercel Python runtime: https://vercel.com/docs/functions/runtimes/python
- Vercel external rewrites: https://vercel.com/docs/routing/rewrites
- Vercel Function limits: https://vercel.com/docs/functions/limitations
- Vercel Blob: https://vercel.com/docs/vercel-blob
- Vercel Postgres / Marketplace integrations: https://vercel.com/docs/postgres
- Neon pgvector: https://neon.com/docs/extensions/pgvector
- LangGraph Postgres checkpoints: https://docs.langchain.com/oss/python/langgraph/checkpointing
