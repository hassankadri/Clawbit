# Batch 2 security and compatibility

Thread IDs remain opaque, case-preserving identifiers. New clients already use
UUIDs, but persisted uploads and tests also use IDs such as `attachment-test-001`.
Enforcing UUID-only IDs would disconnect those records and checkpoints. The
shared validator therefore accepts 1–128 ASCII letters, digits, hyphens and
underscores, beginning with a letter or digit, and rejects Windows device names.
It does not trim, normalize, rename, migrate or delete existing IDs. Unsafe IDs
are rejected with HTTP 400 before database, checkpoint or filesystem access.

Upload responses retain their existing fields. New stored filenames contain a
generated attachment UUID and the validated extension; original names remain
metadata. Existing filenames and attachment references remain readable when
contained in the correct thread directory and free of symlinks/junctions.

Uploads are limited to 10 MiB, 200 PDF pages and 10 attachments per thread.
Only PDF, DOCX, TXT, MD, CSV, PNG, JPEG and WEBP are accepted. A claimed MIME type
no longer rescues an unsupported extension. Content checks run before extraction
or embeddings. Pillow is a new, directly required image-validation dependency;
no existing dependencies or embedding providers are upgraded.

Malformed files and failed indexing are rejected rather than saved with a
`rag_error` and potentially partial index state. Manifest writes are atomic and
failed ingestion is rolled back. Resource limits also bound DOCX expansion,
image pixels, extracted text and chunk counts. Oversized uploads return 413;
other invalid uploads return 400, a full/busy thread returns 409, and ingestion
service failures return 503 without exposing internal exception text.

Additional resource ceilings are 20 MiB expanded DOCX content (512 ZIP entries),
20 million image pixels, one image frame, one million extracted characters and
1,500 document chunks. Text uploads require UTF-8 (an optional BOM is accepted).
Encrypted PDFs and macro-enabled or malformed Office documents are rejected.
These stricter checks can reject previously accepted malformed or oversized files;
existing files are never renamed or deleted as a migration.

Thread mutations use a nonblocking OS file lock, including across workers.
Symlinks, Windows junctions and hardlinked files are rejected. Upload storage must
remain writable only by the application/trusted local administrators; path checks
are not an OS sandbox against another privileged process racing filesystem changes.

A pending-operation journal is written before reading upload chunks and before
indexing. If the vector store is unavailable during rollback, the file is removed,
the recovery marker is retained, and the request returns 503. Only attachment IDs
in the committed manifest are searchable, so pending vectors cannot be retrieved.
The next upload/deletion in that thread retries cleanup before doing new work.
This also means legacy vectors with no manifest record are not exposed; no stored
vectors or user documents are bulk-migrated or deleted. A committed upload remains
valid if only removal of its journal fails. Storage recovery is retry-driven,
not a background service.

The existing frontend Remove action only removes an attachment from its pending
selection; there was no backend deletion endpoint. This behavior is preserved.
Stored attachment deletion is provided by a thread-scoped backend endpoint, so
storage, manifests and index entries can be removed together and capacity freed.

`CLAWBIT_RUNTIME_DIR` optionally relocates memory/upload/vector storage; its
default preserves the existing backend directories. Tests set a fresh temporary
runtime directory before imports and disable dotenv loading and live services.

The calculator keeps the same tool name, expression argument and string/error
responses. Its AST interpreter allows real-number arithmetic, unary signs,
parentheses, `abs`, `round`, `min`, `max`, bounded `sum`/`pow`, and an explicit
allowlist of common `math` functions/constants. Lists/tuples are accepted only as
bounded numeric function arguments. Arbitrary Python expressions and unlisted
attributes/functions are intentionally rejected. Limits: 1,024 input characters,
128 AST nodes, depth 24, 1,024-bit integers, exponent magnitude 1,000, 32 function
arguments/sequence elements, factorial/permutation arguments 170 and combination
arguments 1,000. Non-finite and complex results are rejected.

Regression tests use pytest, local PDF/DOCX/image fixtures, simulated partial
index failures and a real isolated Chroma collection with local fake embeddings.
No live Gemini/Groq/embedding or connector calls are required. The two pre-existing
`tests/test_mcp.py` tests expect a local `get_project_status` tool; the current
connector loader has no such default server. They still fail with no connectors
configured and have not been changed or skipped by this work.

Final verification (2026-10-19): the original 11 Batch 2 files were reviewed;
`backend/tests/test_mcp_compatibility.py` was added as the twelfth file solely for
the requested offline GitHub compatibility verification. Production MCP code and
the original MCP tests are unchanged.

The manifest is the durable commit decision. Post-commit errors, cancellation
after journal removal, and temporary inability to read the manifest must retain
the committed attachment. Regression tests exercise each case, plus subsequent
recovery. Unknown commit status fails closed without deleting the file.

Commands run from `backend` with the installed `.venv/Scripts/python.exe`:

- `-m pytest tests/test_calculator_security.py tests/test_upload_security.py tests/test_mcp_compatibility.py tests/test_api.py tests/test_rag.py tests/test_rag_eval.py tests/test_memory.py -q`:
  **181 passed** (168 security, 3 GitHub compatibility, 10 existing affected tests).
- `-m pytest -q --tb=short`: **181 passed, 2 failed, 8 deprecation warnings**.
- `-m py_compile tool.py safe_calculator.py upload_security.py app.py rag.py database.py tests/conftest.py tests/test_calculator_security.py tests/test_upload_security.py tests/test_mcp_compatibility.py`:
  **passed**.
- `git diff --check` from the repository root: **passed**.

Both failing tests were also executed from an isolated temporary copy of local
HEAD `de16b8e`, using its original MCP client, OAuth module, tests and conftest,
with connector credentials removed. Both failed identically: discovery asserted
`get_project_status` in an empty tool list; execution raised `StopIteration`
(surfaced by asyncio as `RuntimeError`). Those three MCP source/test files match
HEAD exactly after newline normalization. This proves the failures predate Batch 2.
No tests were skipped or changed to conceal these failures.

The offline GitHub checks cover runtime connection and authorization-header
construction, discovery through the adapter boundary, tool invocation, caching,
disconnect, environment configuration and rejected authentication. Live remote
GitHub/OAuth, live model responses and paid embeddings were not exercised.

Final files modified: `backend/tool.py`, `backend/app.py`, `backend/database.py`,
`backend/rag.py`, `backend/requirements.txt`, `backend/tests/conftest.py`.
Files created: `backend/safe_calculator.py`, `backend/upload_security.py`,
`backend/tests/test_calculator_security.py`, `backend/tests/test_upload_security.py`,
`backend/tests/test_mcp_compatibility.py`, `docs/BATCH_2_SECURITY.md`.
No files were deleted.

Batch 2's six tracked files account for 339 insertions and 320 deletions, plus
the six new files above. The complete tracked working-tree `git diff --stat`
also includes preserved pre-existing agent and frontend changes:

```text
 backend/agent.py                      | 2195 ++++++++++++++++++++++++++-------
 backend/app.py                        |  202 +--
 backend/database.py                   |   11 +-
 backend/rag.py                        |  389 ++++--
 backend/requirements.txt              |    1 +
 backend/tests/conftest.py             |   39 +-
 backend/tool.py                       |   17 +-
 frontend/components/chat/Markdown.tsx |  165 ++-
 frontend/package.json                 |    3 +-
 9 files changed, 2198 insertions(+), 824 deletions(-)
```

Pre-existing `backend/agent.py`, `frontend/components/chat/Markdown.tsx`,
`frontend/package.json`, all three `frontend/tests/` files and
`Clawbit-MCP-debug.zip` retain their recorded SHA-256 hashes. Batch 1 has two
`.mjs` files and a README, with no redundant `.cjs` files. The branch remains
`checkpoint/clawbit-pre-release-qa`; no commit, push, reset, stash or branch
switch was performed. Security and affected-flow checks pass; the full-suite
green acceptance condition remains blocked only by the verified baseline MCP
test mismatch.
