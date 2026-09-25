# Clawbit engineering rules

- Inspect relevant code, callers, tests and nested instructions before editing. For Phase 6, read `docs/PHASE_6.md`; follow `frontend/AGENTS.md` for frontend work.
- Preserve working chat, model/provider selection, uploads, RAG, MCP, memory and agent behavior. Preserve existing thread IDs, checkpoints, attachment references and data unless an explicitly scoped migration is required.
- Make minimal targeted changes. No unrelated refactors, cleanup or feature removal.
- Do not upgrade dependencies unless explicitly requested. Do not change APIs or schemas unless required by the current phase; document compatibility and migration implications first.
- Implement only one Phase 6 subphase per task. Stop after its acceptance criteria and verification; do not begin the next subphase automatically.
- After implementation, run relevant lint, typecheck and tests. Frontend: `npm run lint` and installed `tsc --noEmit --incremental false` from `frontend`; backend: relevant `python -m pytest tests/...` from `backend`. Run affected-flow checks where applicable; do not install dependencies just to run checks.
- Backend imports/tests can initialize databases and runtime directories. Use isolated test data for persistence changes; never damage existing user data.
- Never hide failures by deleting functionality/tests, weakening assertions or disabling checks. Report failures, pre-existing issues and unavailable checks honestly.
- Never commit or push unless explicitly requested. Do not switch branches, merge or perform destructive operations without explicit authorization.
- Finish with exact files changed, commands/tests run and their results, remaining limitations and acceptance status. Documentation-only tasks need document verification, not application execution.
