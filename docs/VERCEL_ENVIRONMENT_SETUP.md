# Clawbit Vercel Environment and First-Time Setup

This document describes the **fresh hosted installation**. The previous local runtime data was intentionally deleted by the project owner; no local accounts, IDs, chats, memories, checkpoints, uploaded files, vectors or connector credentials are imported.

## Vercel projects

Create two Vercel Hobby projects from the same Git repository and select the branch `deployment/vercel-migration` for the first Preview:

| Project | Root Directory | Runtime |
| --- | --- | --- |
| Clawbit frontend | `frontend/` | Next.js |
| Clawbit backend | `backend/` | FastAPI / Python |

The backend project has `backend/vercel.json`, which selects Singapore (`sin1`) and limits the function to 110 seconds. The frontend must keep browser API requests on its own origin using `/api`; `frontend/next.config.ts` rewrites those requests to the backend project.

### Frontend project environment

Set the following in Vercel:

- `CLAWBIT_BACKEND_URL`: the backend Vercel deployment origin, for example `https://<backend-project>.vercel.app`. Do not append `/api`; the rewrite strips the prefix.
- Leave `NEXT_PUBLIC_API_URL` unset for production. The browser must use same-origin `/api`, not call the backend hostname directly.

For Preview deployments, set `CLAWBIT_BACKEND_URL` to the matching Preview backend deployment. Do not point an untrusted Preview frontend at a production database unless that is an intentional, separately reviewed decision.

### Backend project environment

Set these server-only variables:

| Variable | Purpose |
| --- | --- |
| `CLAWBIT_AUTH_MODE` | Set to `production` to enable Secure, host-only session cookies and strict origin checks. |
| `CLAWBIT_ALLOWED_ORIGINS` | Exact comma-separated frontend origins, for example `https://<frontend-project>.vercel.app`. No paths, wildcard or trailing slash. |
| `CLAWBIT_FRONTEND_URL` | Frontend origin used as the OAuth completion fallback. |
| `CLAWBIT_PUBLIC_BACKEND_URL` | Optional fallback callback base. If set, use the frontend same-origin `/api` URL, never the separate backend hostname. Normal browser OAuth starts derive this from the validated request Origin. |
| `CLAWBIT_PERSISTENCE_BACKEND` | Set to `postgres`. |
| `CLAWBIT_CHECKPOINT_BACKEND` | Set to `postgres`. |
| `DATABASE_URL` | Neon **pooled** PostgreSQL connection URL for request-time database operations. Use the URL that has Neon's pooler hostname. |
| `CLAWBIT_MCP_STATE_KEY` | A fresh Fernet key for encrypting connector credentials. Generate it with the command below; store it as a Vercel secret. |
| `LANGGRAPH_STRICT_MSGPACK` | Set to `true`; the app also enforces this when the PostgreSQL checkpoint backend is selected. |
| `AWS_ENDPOINT_URL_S3` | The Neon Object Storage endpoint for the same branch as the database. |
| `AWS_ACCESS_KEY_ID` | Neon storage credential token ID with `storage:read` and `storage:write` scopes. |
| `AWS_SECRET_ACCESS_KEY` | Secret returned when the Neon storage credential is created. Store it immediately. |
| `AWS_REGION` | Set to `ap-southeast-1` for Singapore. |
| `NEON_OBJECT_STORAGE_BUCKET` | Name of the private Neon bucket, for example `uploads`. |
| `GOOGLE_API_KEY` | Google Gemini model and embedding access. |
| `GROQ_API_KEY` | Groq model access, if used. |
| `OPENROUTER_API_KEY` | OpenRouter model access, if used. |
| `TAVILY_API_KEY` | Tavily search access, if used. |

Optional OAuth connector variables:

- `GOOGLE_MCP_CLIENT_ID` and `GOOGLE_MCP_CLIENT_SECRET`
- `SLACK_MCP_CLIENT_ID` and `SLACK_MCP_CLIENT_SECRET`

Register Google and Slack redirect URLs as the frontend same-origin paths:

- `https://<frontend-domain>/api/mcp/oauth/google-drive/callback`
- `https://<frontend-domain>/api/mcp/oauth/slack/callback`

Do not set `CLAWBIT_TURNSTILE_TEST_MODE` in production. Without `CLAWBIT_TURNSTILE_SECRET_KEY`, public account registration intentionally remains disabled; create the first administrator through the one-time CLI step below. If public signup is later enabled, configure Cloudflare Turnstile with the production site key in the frontend and secret key in the backend.

Do **not** set `CLAWBIT_TRUSTED_PROXIES` on Vercel; `production_server.py` is the standalone Uvicorn launcher, not the Vercel entrypoint.

## Neon provisioning

Create one Neon project in Singapore (`aws-ap-southeast-1`) and keep the database and Object Storage on the same branch. Use the Neon Free plan and remain within its included quotas.

Create a **private** bucket called `uploads`. Do not set `public_read`. Create a branch-scoped storage credential with both `storage:read` and `storage:write` scopes. The endpoint and storage credentials are branch-specific; do not reuse a Preview branch credential for production.

Use two database URLs:

- `DATABASE_URL`: pooled endpoint used by the deployed application.
- `DATABASE_DIRECT_URL`: direct endpoint used only by one-time schema setup commands. Do not use the direct endpoint for Vercel request traffic.

## First-time schema and administrator setup

Run these commands locally from the backend folder, using the matching Neon environment values. Never paste the connection strings, Fernet key, API keys or storage credentials into chat, Git, screenshots or source files.

PowerShell example:

```powershell
cd D:\My Projects\Clawbit AI\backend

$env:CLAWBIT_PERSISTENCE_BACKEND = "postgres"
$env:CLAWBIT_CHECKPOINT_BACKEND = "postgres"
$env:DATABASE_DIRECT_URL = "<Neon direct connection URL>"
$env:DATABASE_URL = "<Neon pooled connection URL>"

python setup_postgres_schema.py
python setup_postgres_checkpoints.py
```

The first script creates the Clawbit auth, ownership, history, memory, usage, OAuth, approval, upload-metadata and pgvector tables. It is idempotent and does not truncate tables. The second script runs the official LangGraph PostgreSQL checkpoint migrations. Run both once against the new empty Neon branch before deploying backend code with PostgreSQL mode enabled.

Generate the connector-encryption key locally:

```powershell
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode('ascii'))"
```

Add that value to the backend Vercel environment as `CLAWBIT_MCP_STATE_KEY`. Never commit it.

To create the first administrator, set the same backend environment values locally, including `CLAWBIT_PERSISTENCE_BACKEND=postgres` and the pooled `DATABASE_URL`, then run:

```powershell
python setup_owner.py
```

The script prompts for the initial admin credentials and inserts the first account into Neon. No old account or principal ID is reused. Keep the admin passphrase secure. After successful setup, sign in through the frontend Preview and verify that the account can create a fresh conversation and workspace.

## First Preview acceptance checklist

- [ ] Backend and frontend Preview deployments build successfully on the selected branch.
- [ ] Backend health route responds through the frontend same-origin `/api` rewrite.
- [ ] HTTPS-only `__Host-clawbit_session` cookie is set on the frontend origin; sign in, refresh and sign out work.
- [ ] First-admin setup is complete; public signup remains closed unless Turnstile is configured.
- [ ] Chat messages, history revisions, saved memories, usage counters and LangGraph checkpoints survive separate function invocations.
- [ ] Two test accounts cannot access each other's threads, workspaces, memories, uploads, vectors, checkpoint state or pending approvals.
- [ ] PDF/text/image upload, preview, retrieval, attachment download and delete work through private Object Storage and pgvector.
- [ ] Google Drive and Slack OAuth start/callback complete through the same-origin proxy using the same session.
- [ ] Notion and Stripe stdio MCP servers remain disabled in Vercel serverless mode until a remote HTTP MCP transport is implemented.
- [ ] The deployed Python bundle stays below Vercel's 500 MB uncompressed limit.
- [ ] Hobby and Neon usage stays inside free quotas; no paid plan, paid add-on or overage is enabled.

## Important limitations

- Vercel Hobby is for personal, non-commercial use. Reassess the plan before using Clawbit for a commercial product or service.
- The function max duration is configured to 110 seconds to stay below the 120-second proxied-request ceiling. Long-running agent work needs a durable job/worker design rather than a longer open browser request.
- Vercel's Python runtime has a 500 MB uncompressed function bundle limit. The runtime `requirements.txt` intentionally excludes Chroma and SQLite checkpoint packages; those remain in `requirements-local.txt` for desktop development.
- Neon Free has finite per-project compute, database storage, object storage and egress allowances. If a quota is exhausted, writes or compute can be suspended until reset; the service does not silently provide unlimited free capacity.
- Model/search providers have their own rate limits and possible charges. Vercel/Neon free tiers do not include Gemini, Groq, OpenRouter or Tavily token/search usage.
- Vercel Preview deployments must use Preview-safe backend/database settings. Avoid pointing Preview code at a live production database.
