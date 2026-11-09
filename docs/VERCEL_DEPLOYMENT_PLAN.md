# Clawbit Vercel Deployment Plan

**Status:** clean-slate reset selected; deployment implementation not started  
**Baseline:** `eb1428b50f901a8fc67782e34225e8c230f4ea87`  
**Working branch:** `deployment/vercel-migration`

This plan is intentionally separate from the pre-deployment audit branch. **Decision (2026-11-09): permanently erase the existing local runtime data and start from a clean installation with new identities and IDs.** This includes local accounts, sessions, histories, memories, checkpoints, ownership records, usage state, backups, uploads and Chroma vectors. Source code, project files, `.env` configuration and dependencies are not part of the data wipe. No local files have yet been deleted by ChatGPT.

## 1. Recommended Vercel layout

Use two Vercel projects from the same Git repository:

1. **Frontend project** — Root Directory `frontend/`, Next.js.
2. **Backend project** — Root Directory `backend/`, FastAPI Python runtime. The backend directory already contains `app.py` and `requirements.txt`, which are recognized by Vercel when that directory is the project root.

The browser should continue calling the same-origin `/api` path. Configure the frontend project to rewrite `/api/:path*` to the backend project's stable deployment URL, stripping the `/api` prefix. This matches the existing production default in `frontend/lib/auth.ts`, while keeping the browser's session cookie on the frontend origin. Do not cache API rewrites, especially authentication, chat streams, uploads, and connector routes.

Use the frontend origin for:
- `CLAWBIT_ALLOWED_ORIGINS`
- `CLAWBIT_FRONTEND_URL`
- OAuth redirect URLs registered with Google and Slack must use the frontend's same-origin `/api/mcp/oauth/<provider>/callback` URL. The frontend `/api` rewrite strips the prefix and forwards callbacks to FastAPI, preserving the host-only session cookie. Production callback generation uses the validated request `Origin` plus `/api`; it must never point to the separate backend Vercel hostname.

Validate the forwarded scheme/host behavior in a Vercel Preview before allowing production authentication. Do not assume the local `production_server.py` proxy allowlist is the correct Vercel configuration.

## 2. Confirmed $0/month target architecture (within free quotas)

The user's constraint is **no paid hosting plan and no monthly infrastructure bill**. Use the free tiers below and configure usage alerts/limits. Zero cost is conditional on staying within included quotas; providers can require account verification/payment setup, and overages or optional paid features must not be enabled.

| Layer | Service | Intended role | Free-tier constraint |
| --- | --- | --- | --- |
| Frontend | Vercel Hobby | Next.js UI and same-origin API proxy | Personal/non-commercial use only; included monthly quotas apply |
| Backend | Vercel Hobby Python runtime | FastAPI application as a serverless function | Python runtime is beta; 500 MB uncompressed bundle limit; 2 GB / 1 vCPU on Hobby; Fluid Compute up to 300 seconds; proxied rewrites have a separate 120-second timeout |
| Transactional database | Neon Free Postgres | Auth, users/principals, ownership, history, memory, usage/quotas, connector records, OAuth/approval state and checkpoints | Current Free plan has finite compute/storage quotas; budget queries/connections and monitor usage |
| Vector database | Neon Postgres + pgvector | Replace local Chroma | Same Neon database/storage/compute quota; validate embedding dimension and retrieval quality |
| Private file storage | Neon Object Storage (private S3-compatible bucket) | Original uploaded bytes | Current Neon Free plan lists 5 GB object storage per project; same project/branch and credential model as Postgres |

**No extra paid backend host, Redis, Vercel Blob, Cloudflare R2, or Vercel Postgres add-on.** Neon Object Storage is S3-compatible and can be accessed from Python using boto3 with branch-scoped storage credentials. Provision a private bucket (private by default); keep access keys only in Vercel environment variables. Never expose storage credentials or private object URLs to the browser. Upload metadata/manifests and ownership stay in Postgres.

Vercel supports FastAPI entrypoints (app.py is a recognized entrypoint) and Python streaming. The actual backend bundle must be measured; remove local Chroma/SQLite dependencies and test the full app import before deployment. Python packages are not tree-shaken, and the function must fit within 500 MB uncompressed.

**Timeout behavior:** the Vercel Hobby function can run up to 300 seconds with Fluid Compute, but an external rewrite is capped at 120 seconds. Keep browser-proxied chat operations comfortably below 120 seconds. If an agent workflow can run longer, implement durable job records and polling/resume rather than holding a proxy request open. SSE needs a Preview end-to-end test.

Do not treat Vercel Function /tmp as durable storage. It is scratch space only. No local SQLite, filesystem upload, or embedded Chroma data may be used as authoritative state in production.

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

## 5. Clean-slate reset decision

The user explicitly authorized permanent deletion of the existing runtime data and a complete fresh start. This replaces the earlier migration strategy.

- Delete local runtime data only from the confirmed project paths: `backend/data/`, `backend/uploads/`, `backend/chroma_db/`, root `uploads/`, and root `chroma_db/`. This removes local SQLite databases, checkpoint WAL/SHM files, ownership-backup snapshots, manifests, attachment files and embedded Chroma vectors.
- Do not delete source code, frontend/backend project files, Git history, dependencies, `.env` configuration or unrelated folders.
- Do not create a backup of the data being intentionally erased. This is a permanent reset decision; the user has accepted losing the old local data.
- Do not import any old local IDs, accounts, password hashes, principal IDs, threads, workspaces, checkpoints, memories, upload metadata, files, vectors or connector secrets into Vercel.
- Provision new empty cloud database and private object storage; create a new administrator identity during fresh setup. Allow the application to generate new user/principal/workspace/thread/attachment IDs. Never synthesize IDs by editing database files manually.
- Fresh-start verification must prove all old runtime stores are absent before initializing new local state and that all cloud state starts empty before first signup/setup.
- Do not run deletion automatically on application startup or as part of Vercel build/deployment. Local deletion is a one-time, explicit operator action against the verified Windows project root.
- Existing `.env` values are configuration/secrets, not user data; retain them until new hosted environment variables are configured and verified. Rotate any credentials that may have been exposed or are no longer wanted.


## 6. Implementation sequence

1. Add deployment-specific configuration and health/readiness checks without changing storage.
2. Add Postgres schema/migrations and adapters, beginning with auth, history, memory and usage.
3. Move LangGraph checkpoints to Postgres using the official Postgres checkpoint saver and retain ownership enforcement.
4. Move upload bytes to private Cloudflare R2 and metadata/manifests to Postgres; replace Chroma with pgvector and compare retrieval/evaluation results.
5. Persist OAuth/approval state in Postgres and remove or isolate unsupported MCP stdio/npx child-process connectors from the Vercel Function.
6. Add Vercel project configuration, same-origin API rewrite, security headers and environment documentation.
7. Deploy Preview, run automated tests, and verify login, chat SSE, upload, retrieval, delete, OAuth and MCP flows.
8. Start with empty managed storage and verify new identity/resource IDs. No legacy-data migration.

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

- **Vercel Hobby (Free) confirmed.** This deployment must remain personal/non-commercial. No paid services or automatic overages.
- Use Neon Postgres and Neon Object Storage in AWS Asia Pacific (Singapore, `aws-ap-southeast-1`), which is listed as a supported Object Storage region. Set the Vercel backend project to the single Hobby function region `sin1` (Singapore) using `backend/vercel.json`; verify both services show the same region before provisioning.
- **Full reset authorized:** permanently erase the existing local runtime data and provision a brand-new hosted installation with new identities and IDs.
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

## 10. Upload and vector inventory follow-up (2026-11-09)

A read-only content/ownership inventory reported:

- `backend/uploads`: 67 thread directories, all mapped to the admin principal; 17 manifest attachment records; 11.33 MB of existing referenced files counted.
- 5 manifest records did not resolve to an existing file.
- 1 manifest/path entry was classified as invalid by the first-pass scanner; the exact reason has not yet been isolated.
- 5 physical files were not referenced by the manifests.
- Chroma: 1 collection, 35 total embeddings, all 35 have `thread_id` metadata; 8 distinct threads, all mapped to the admin principal. No vector was missing thread metadata.
- No user-owned uploads or vectors were reported by this scan.

**Migration gate:** Do not migrate or discard any of the five missing-file records, the invalid record, or five unreferenced files until a second read-only diagnostic classifies the exact failure modes and checks each file against its manifest and Chroma attachment metadata. Preserve original folders and Chroma DB. The 35 vectors should be reindexed/compared after import, not treated as proven equivalent solely because thread metadata exists.

## 11. Fresh-reset inventory and acceptance criteria

The local inspection baseline is retained only as a record of what the reset removes; none of those records or files should be imported. The local cleanup targets must be exactly:

1. `backend/data/` (all SQLite files, WAL/SHM files, and ownership-backup snapshots)
2. `backend/uploads/`
3. `backend/chroma_db/`
4. root `uploads/`
5. root `chroma_db/`

After the user runs the one-time Windows cleanup, confirm these paths are absent/empty before starting the local app. The application may then recreate empty runtime stores and generate new IDs. The hosted Preview must independently start with empty managed services and a separately generated administrator identity.

Do not delete any code, project configuration, Git history, virtual environment, node_modules, frontend build output, or `.env` as part of the data reset. Do not add any automatic reset command to deploy/build/startup.

## 12. $0/month implementation gates

The following work is mandatory before a usable Preview; the Next.js rewrite change alone does not make the app deployable.

1. Introduce a Postgres data layer and migrations for auth/users/sessions, ownership, history/revisions, memories, usage budgets, connector epochs, OAuth state, pending approvals and app metadata. Preserve account isolation; create a new cloud admin through the existing first-time setup flow. Store session hashes only.
2. Replace SQLite checkpoint persistence with **langgraph-checkpoint-postgres** / **AsyncPostgresSaver**; run setup/migrations as a controlled one-time admin operation, not on every function invocation.
3. Replace Chroma with pgvector. Confirm the selected embedding model's actual output dimension, add an appropriate index strategy (or begin with exact search), persist per-thread/per-principal metadata filters, and validate cross-user isolation.
4. Replace local upload files/manifests with private Neon Object Storage bytes plus Postgres metadata. Generate unpredictable object keys; authorize every read, write and delete in the backend. Use short-lived presigned operations only after owner authorization.
5. Replace process-only OAuth state and pending MCP approvals with Postgres records that enforce TTL, one-time consumption, session binding and owner/principal binding.
6. Remove production reliance on local data/, uploads/, chroma_db/, FlashRank writable cache, process PID leases, and process-only mutable connector state. FlashRank cache is under `/tmp` and may be discarded on cold start; connector caches are disposable only.
7. Resolve Notion/Stripe stdio npx connectors. Vercel Python functions must not rely on spawned local MCP processes or npm availability; use supported remote HTTP MCP endpoints or mark unsupported connectors unavailable in the first release.
8. Reduce runtime dependencies and test bundle size under 500 MB. Remove chromadb, langchain-chroma, langgraph-checkpoint-sqlite, aiosqlite if no remaining runtime path needs them. Add a supported Postgres driver/checkpointer and S3 SDK with pinned versions.
9. Add a durable async-job path for workflows that may exceed the 120-second external-rewrite timeout. Keep proxied SSE responses bounded; test browser aborts, client reconnects and function timeouts.
10. Deploy only after backend unit/integration tests pass against a clean Neon branch and an isolated private object-storage bucket. Verify startup/login, user isolation, history, checkpoints, new uploads, RAG indexing/retrieval/deletion, OAuth state and cold-start durability.

**Free quota facts checked 2026-11-09:** Vercel Hobby includes 1 million Function invocations, 100 GB-hours Function Duration, 4 CPU-hours and 360 GB-hours provisioned memory/month; Hobby is personal/non-commercial only. Neon Free currently includes 100 CU-hours/project/month, 1 GB Postgres storage/project, 5 GB public network transfer/project/month, and the Neon Free backend announcement lists 5 GB object storage/project. Compute scales to zero after 5 minutes idle; when compute or transfer quotas are exhausted, connections may be suspended until the quota resets. Do not assume unlimited availability. Confirm the live account quota and current object-storage pricing/limits before provisioning. Set alerts; do not enable paid add-ons or usage-based paid compute. This is infrastructure-only cost guidance: calls to Gemini, Groq, OpenRouter, Tavily or other external model/search APIs have separate provider quotas and may cost money. Keep the selected providers on their free allowance or use local/offline functionality; do not assume Vercel/Neon quotas include model tokens.

## References

- Vercel FastAPI: https://vercel.com/docs/frameworks/backend/fastapi
- Vercel Python runtime: https://vercel.com/docs/functions/runtimes/python
- Vercel external rewrites: https://vercel.com/docs/routing/rewrites
- Vercel Function limits: https://vercel.com/docs/functions/limitations
- Vercel Blob: https://vercel.com/docs/vercel-blob
- Vercel Postgres / Marketplace integrations: https://vercel.com/docs/postgres
- Neon pgvector: https://neon.com/docs/extensions/pgvector
- LangGraph Postgres checkpoints: https://docs.langchain.com/oss/python/langgraph/checkpointing
