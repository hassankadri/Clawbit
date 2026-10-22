# Batch 4A: local owner authentication

## Compatibility and migration plan

Authentication uses a separate `data/auth.sqlite3` under `CLAWBIT_RUNTIME_DIR`
(the backend directory by default). Existing conversation, checkpoint and Chroma
schemas and records are not changed. Browser conversation/project storage and
attachment references retain their existing keys. No ownership columns are
backfilled.

Only one owner can be initialized, through a local interactive command. This
owner explicitly accepts access to this installation's existing data; this is
not a migration of that data to a new multi-user account. Public registration
and additional accounts remain unavailable until Batch 4B implements ownership
checks throughout storage, retrieval, tools and connectors.

The API gains `/auth/session`, `/auth/login` and `/auth/logout`. Except for the
health check and session/login endpoints, routes require an owner session.
Mutating requests require an allowed Origin and a session-bound CSRF header.
Connector OAuth starts change from GET to POST; callbacks retain GET and require
the same authenticated session that initiated the flow. Existing chat, stream,
upload and model request/response formats remain unchanged.

The new database is initialized idempotently. Existing authentication databases
are backed up using SQLite's backup API before schema upgrades. No existing
application database needs a schema migration in this batch. Backups belong in
the ignored runtime data directory, never in Git.

Passwords use Python's supported scrypt implementation with N=131072, r=8, p=1
and a random salt. No dependency installation is required. This follows
[OWASP's scrypt recommendation](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
Login uses an anonymous pre-session and a CSRF token, following
[OWASP's login CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Setup and operation

From `backend`, run `.\.venv\Scripts\python.exe setup_owner.py` in an interactive
terminal. Explicitly confirm `INITIALIZE`, choose a username, and enter the
passphrase twice. Password entry fails closed if the terminal cannot hide input.
The database enforces a singleton owner even when setup commands race.
There is no password argument, generated owner credential or registration route.

Start the backend with:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000 --no-access-log
```

Start the frontend with `npm run dev` from `frontend`. Sign in at
`http://localhost:3000`. Use the same hostname for the API: cookies set for
`localhost` do not belong to `127.0.0.1`. Either hostname works when used
consistently. Keep runtime directories accessible only to the OS account that
runs Clawbit. Existing browser history remains local to that browser profile;
signing out does not delete it or protect it from someone with filesystem or
browser developer-tools access.

The top-bar sign-out button calls the server before clearing authenticated UI
state. A network failure leaves the UI signed in with a retryable error. Refresh
and window focus restore/check the session; expiry and API 401 responses remove
protected views and cancel tracked frontend requests/uploads. Existing local
storage keys, model consent and saved conversation IDs are preserved.

## Session and CSRF contract

- `GET /auth/session`: returns `{user, csrf_token, expires_at}`. An anonymous
  request obtains a ten-minute pre-session; `user` is null until login.
- `POST /auth/login`: accepts `{username, password}` with the pre-session cookie,
  exact allowed `Origin`, and `X-CSRF-Token`. Successful login deletes the old
  session and issues a fresh eight-hour session and CSRF token.
- `POST /auth/logout`: requires the authenticated cookie, Origin and CSRF token;
  deletes the server session and expires the browser cookie.

CSRF values are separate HMAC-derived secrets returned in JSON and held only in
frontend memory. Session bearer tokens never appear in JSON or browser storage.
The cookie is HTTP-only, host-only, `Path=/`, `SameSite=Lax`. Sessions have a fixed
absolute expiry, survive backend restart, and are revoked by deleting their
database row. Expired rows are pruned when a session is issued. The browser does
not extend the expiry on refresh.

Failed login attempts use a persistent, transaction-protected installation-wide
budget: five attempts per sixty seconds, reset on successful login. Unknown
usernames use the same expensive password-verification path as incorrect
passwords. The short global cooldown can temporarily block the real owner under
attack; this is deliberately basic protection, not Batch 4B's full rate limiter.

All routes default to requiring an authenticated owner, including API docs and
future routes. Only `GET /`, `GET /auth/session` and `POST /auth/login` are public.
Allowed CORS preflights return no protected data. Unauthorized requests are
rejected before upload parsing or provider/agent work. Authenticated mutating
requests without a valid Origin and CSRF header receive 403.

Protected existing routes include `/models`, `/chat`, `/chat/stream`,
`/attachments/upload`, attachment deletion, and every MCP catalog/status,
refresh, connect, disconnect and callback endpoint. There are no standalone
conversation/workspace/memory HTTP routes in the current code; their server data
is accessed through protected chat/tool flows. Browser-local views mount only
after session validation. No model registry, model consent, provider free-tier
policy, RAG pipeline or checkpoint schema is changed.

## HTTPS and origins

Local mode is the default and accepts requests only with a loopback hostname.
Its default allowed origins are exactly `http://localhost:3000` and
`http://127.0.0.1:3000`. Do not use local mode through a public tunnel.

For an HTTPS deployment, configure the process environment explicitly:

```text
CLAWBIT_AUTH_MODE=production
CLAWBIT_ALLOWED_ORIGINS=https://clawbit.example
CLAWBIT_FRONTEND_URL=https://clawbit.example
CLAWBIT_PUBLIC_BACKEND_URL=https://api.clawbit.example
NEXT_PUBLIC_API_URL=https://api.clawbit.example
```

`NEXT_PUBLIC_API_URL` is a frontend build-time setting. Alternatively, a same-origin
reverse proxy can forward `/api/*` to the backend with `/api` stripped; that is
the HTTPS frontend default when no API URL is configured. The deployment must
provide that proxy; Next.js does not create it automatically.

Production requires HTTPS origins, refuses HTTP requests, and uses the
`__Host-clawbit_session` cookie with `Secure`. Terminate TLS at a trusted proxy
and configure Uvicorn's proxy-header trust for that proxy only so the backend
sees the correct scheme. Keep frontend and API on the same site (such as the
sibling subdomains above); unrelated domains are unsupported with SameSite=Lax.
Do not use wildcard CORS origins or public `forwarded-allow-ips=*`.
HTTPS requests on a local development host also receive `Secure` cookies.

Connector start requests now use POST with CSRF. OAuth state records bind the
provider, PKCE verifier where supported, initiating session and frontend origin.
Callbacks require that authenticated cookie, consume state once, and recheck the
session before saving credentials. Callback failures return a fixed message;
provider exceptions and tokens are not reflected into redirect URLs or logged
by the callback handler. Disable or redact OAuth callback query strings in
reverse-proxy/access logs, which otherwise may contain authorization codes.

When no public backend URL is configured, OAuth uses the authenticated request's
backend origin, avoiding a localhost/127.0.0.1 cookie mismatch. Register the exact
callback URI with the connector provider. If a public URL is configured, sign
in using that API hostname as well. Slack still requires its existing HTTPS
callback configuration.

## Data safety and remaining boundaries

The existing local schemas were inspected read-only. No application database
schema was changed and no owner was created in the real installation during
implementation. Tests initialize isolated temporary databases. The auth schema
uses `user_version=1`; initialization is repeatable and backs up an existing
version-zero auth database before adding its tables. Unknown newer schema
versions fail closed. SQLite backups are stored beside that database with a
`.backup` suffix and are ignored by Git.

Keep the entire existing runtime directory and browser profile backed up.
Do not delete the owner/auth database as a password-reset procedure: that would
reopen local initialization and invalidate sessions. Password recovery/change
and owner transfer need a separate explicitly authorized local workflow.

This is a single-owner gate, not multi-user isolation. Connector credentials,
agent tools, RAG indices and legacy data retain their existing installation-wide
behavior. OAuth tokens/state remain in the existing in-memory connector store;
use one backend worker for those connectors. Authentication sessions themselves
persist across workers/restarts. Already admitted backend operations are not
transactionally rolled back by logout; frontend disconnect/cancellation is best
effort and subsequent requests are denied.

Batch 4B must add complete per-user ownership checks and deliberate legacy-data
migration across conversations, workspaces, uploads, RAG, memory, checkpoints,
tools and connector credentials; broader abuse/rate controls and deployment
hardening remain separate work. Public registration must stay disabled until
those boundaries are complete. This application is not declared production-ready.

## Files in this batch

Created:

- `backend/auth.py`
- `backend/auth_store.py`
- `backend/setup_owner.py`
- `backend/tests/test_auth.py`
- `frontend/components/auth/AuthProvider.tsx`
- `frontend/components/auth/LoginForm.tsx`
- `frontend/components/auth/LogoutButton.tsx`
- `frontend/lib/auth.ts`
- `frontend/tests/auth.test.mjs`
- `docs/BATCH_4A_AUTH.md`

Modified:

- `backend/app.py`
- `backend/mcp_oauth.py`
- `backend/README.md`
- `backend/tests/conftest.py`
- `backend/tests/test_models.py`
- `backend/tests/test_mcp_compatibility.py`
- `backend/tests/test_upload_security.py`
- `frontend/app/layout.tsx`
- `frontend/components/layout/Topbar.tsx`
- `frontend/lib/api.ts`
- `frontend/tests/models.test.mjs`

Some modified files were already untracked or changed by earlier batches.
Their existing functionality and assertions were retained; existing API tests
now authenticate through the actual login/CSRF flow. Other dirty files in the
working tree are pre-existing work and are not part of this batch.

## Final verification — 2026-10-20

**Verdict: PASS for Batch 4A's single-owner, offline acceptance criteria, with
the two documented historical MCP failures excluded.** No new test failures
remain. This is not a production-readiness or multi-user security verdict.

Commands below ran from `backend` or `frontend` respectively:

| Check | Result |
| --- | --- |
| `.\.venv\Scripts\python.exe -m pytest tests/test_models.py tests/test_upload_security.py tests/test_mcp_compatibility.py -q` | 194 passed |
| `.\.venv\Scripts\python.exe -m pytest -q -W error::RuntimeWarning` | 513 passed, 2 historical failures, 8 deprecation warnings |
| `.\.venv\Scripts\python.exe -m pytest tests/test_auth.py -q -W error::RuntimeWarning` | 51 passed, 1 deprecation warning |
| Python `py_compile.compile(..., doraise=True)` over backend root and test modules | All 32 files compiled |
| `npm test` | 35 passed |
| `.\node_modules\.bin\tsc.cmd --noEmit --incremental false` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed; all 12 static pages generated |
| `git diff --check` | Passed |
| `git diff --stat`, `git status --short` | Reviewed; prior dirty work retained |

The full run had already collected its tests when the final local-HTTPS cookie
regression was added. The subsequent 51-test authentication run verifies that
last fix and its regression; it overlaps the full suite and is not an additional
51 unique tests. The source suite now contains one more test than that full run.
Runtime warnings were treated as errors in both final backend runs.

The unchanged historical failures are:

- `tests/test_mcp.py::test_local_mcp_server_discovers_project_status_tool`
- `tests/test_mcp.py::test_local_mcp_project_status_tool_executes`

Both expect the old default `get_project_status` local MCP tool, which is absent
from the current connector configuration. The separate GitHub connect, discovery,
tool execution, cache and disconnect tests pass. No test was removed or weakened
to hide those failures. Existing `datetime.utcnow` and Starlette/httpx deprecation
warnings remain; dependencies were not upgraded.

The final security review and regression tests cover:

- Explicit interactive owner setup, hidden password entry, password validation,
  salted scrypt verification, and racing/repeated initialization.
- Anonymous and tampered-cookie rejection across the actual route inventory,
  session rotation, hashed session storage, persistence after restart, absolute
  expiry, revocation, logout and replay rejection.
- Pre-session login CSRF, authenticated mutation CSRF, exact Origin checks,
  explicit credentialed CORS, production HTTPS enforcement and cookie flags.
- Persistent failed-login throttling and bounded, generic login failures,
  including malformed, oversized and invalid-Unicode input.
- Authenticated chat/SSE, all 13 models, model consent/free-tier enforcement,
  upload/attachment security and GitHub MCP management through the real auth
  middleware with external providers mocked.
- OAuth provider/session binding, single-use and expired states, denial of a
  callback from another login, and a session recheck before saving credentials.
- Frontend restoration, login form handlers, protected-view gating, logout,
  expiry, credentials/CSRF on JSON/SSE/uploads/connectors, cancellation after
  streaming headers, and protection from stale responses invalidating a new login.

Frontend tests run real modules/components with Node, React server rendering and
limited browser/hook stubs; they are not browser DOM end-to-end tests. No live
inference or real OAuth exchange was run. No real owner was initialized.

Existing data was preserved by leaving application schemas, persisted IDs,
attachment references and browser storage keys unchanged. Persistence tests
use temporary runtime directories, and anonymous HTTP access is denied before
the corresponding data or provider work starts. The existing browser profile
and local files remain subject to the OS-access limitation described above.

All 21 batch files were reviewed for naming, typing, comments and readability;
the final whitespace review also covered untracked files. A missing final
newline in the modified OAuth module was corrected and that module recompiled.
Existing unrelated formatting was retained.

The final tracked working-tree diff is 21 files, 3,007 insertions and 1,492
deletions **including earlier batches**; new untracked files are not counted by
`git diff --stat`. Batch 4A itself touches the 21 files listed above: 10 created
and 11 modified. No commits, pushes, resets, stashes or branch changes occurred;
the branch remains `checkpoint/clawbit-pre-release-qa`. No `.env` or dependency
changes were made by this batch.
