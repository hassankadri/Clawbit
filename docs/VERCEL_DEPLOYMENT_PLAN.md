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
- **Vercel Blob (private access):** uploaded document/image bytes. Keep attachment metadata, ownership, status and manifests in Postgres; never expose private blob URLs without an authorization check.
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
2. Back up each SQLite database and the uploads/Chroma directories before any export.
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

## 7. Open decisions before the first live Preview

- Vercel plan (Hobby, Pro or Enterprise), which sets the available function execution budget.
- Whether to use a stable custom domain, or the stable Vercel production hostname.
- Whether the hosted installation starts fresh, or whether the existing local account/history/uploads must be migrated.
- Which OAuth/MCP integrations must be available in the first hosted release.

## References

- Vercel FastAPI: https://vercel.com/docs/frameworks/backend/fastapi
- Vercel Python runtime: https://vercel.com/docs/functions/runtimes/python
- Vercel external rewrites: https://vercel.com/docs/routing/rewrites
- Vercel Function limits: https://vercel.com/docs/functions/limitations
- Vercel Blob: https://vercel.com/docs/vercel-blob
- Vercel Postgres / Marketplace integrations: https://vercel.com/docs/postgres
- Neon pgvector: https://neon.com/docs/extensions/pgvector
- LangGraph Postgres checkpoints: https://docs.langchain.com/oss/python/langgraph/checkpointing
