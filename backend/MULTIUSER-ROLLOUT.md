
# Clawbit multi-user rollout

## Account behavior

- The existing v4 owner is migrated to user ID `1` with role `admin`.
- Its existing `principal_id` is copied unchanged, preserving ownership of existing chats, workspaces, uploads, RAG records, memories, MCP credentials, OAuth connections, approvals and usage history.
- Existing session hashes and expiration timestamps are retained during the v4-to-v5 authentication migration.
- New public registrations receive role `user`; the client cannot set its own role.
- Login accepts either email or username. New public accounts use the normalized email as their username.
- Public registration is enabled only after the administrator has been initialized locally.

## Apply safely

1. Stop the backend.
2. Back up the complete runtime directory configured by `CLAWBIT_RUNTIME_DIR`, including `data/`, uploads, Chroma data and LangGraph checkpoints. Keep the backup outside the live runtime directory.
3. Apply the backend files in this update.
4. Start the backend. `AuthStore.initialize()` creates a timestamped SQLite backup and migrates auth schema v4 to v5. Do not delete the old auth database or ownership registry.
5. Check that the existing administrator can still sign in. Their existing browser session is retained if it has not expired.
6. Check public registration using a separate browser/incognito profile.

For a brand-new deployment with no administrator, run `setup_owner.py` interactively on the backend host before exposing registration. Existing installations with an owner do not need to run it again.

## Validation

Run these first from the backend folder:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_auth.py tests/test_auth_setup.py tests/test_login_throttle.py tests/test_presession_limits.py tests/test_multiuser_auth.py -q
```

Then run the full suite:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

From the frontend folder:

```powershell
npm test
npm run lint
npm run build
```

## Current limitations before unrestricted public launch

- Registration validates email syntax and uniqueness but does not send an email verification message.
- Password recovery is administrator-assisted for now: run `reset_user_password.py` on the backend host. It revokes only the selected account's sessions and retains its data.
- Provider API keys remain shared server-side credentials. Users' requests can consume the deployment owner's provider quota and money. Review and set `CLAWBIT_LIMIT_*` values for your expected cost before inviting the public.
- Add an anti-bot challenge before a large public launch. Current signup controls include global, per-source and per-email attempt limits.
- Run behind HTTPS in production and configure exact `CLAWBIT_ALLOWED_ORIGINS`. Do not expose local authentication mode to the internet.
- Keep one Uvicorn worker as required by the existing process-local MCP/OAuth connector state.

## Isolation boundary

Identity is `principal_id`, not a client-supplied user ID.

The authentication middleware derives it from the validated HttpOnly cookie session and binds it through `owner_context`.

Existing ownership, history, checkpoint, RAG/upload, memory, credential, OAuth, approval and usage stores continue to scope work to that principal.

Never add an API that accepts a client-supplied principal ID or role.
