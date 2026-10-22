# Free model integration

Compatibility: the three existing model IDs, default, aliases, chat/SSE contracts,
thread IDs, checkpoints and attachment references are retained. Successful chat
responses retain their shape. Provider failures now return appropriate HTTP
errors instead of a successful HTTP 200 containing an error answer; SSE failures
retain the `error` event and add `status_code` and optional `retry_after` fields.
Unknown model IDs
now fail with a safe error instead of silently selecting Gemini. `/models` is an
additive discovery endpoint; chat requests add optional `provider_consent` (the
exact selected model ID). No database migration is required.

The local owner confirmed Google and Groq free-only accounts with billing disabled
on 2026-10-19, recorded in `backend/free_tier_policy.json`. This is an operator
attestation, not independent billing verification. Set the relevant flag to false
before changing accounts or enabling billing. Never enable paid billing or buy
credits to resolve quota errors. Keep provider spend limits and automatic top-ups
disabled. Code cannot independently guarantee zero spend on a billing-enabled
account. The attestation is bound to SHA-256 fingerprints of the confirmed keys;
changing a key disables that provider until the account is reconfirmed. These are
one-way fingerprints, not credentials. Existing Google embeddings are subject to
the same account guard and initialize lazily so missing Google credentials do not
prevent other providers from starting.

Catalog checks are read-only, cache successes for five minutes and failures for
30 seconds, and fail closed. Missing keys, removed IDs, nonzero OpenRouter prices
(including any additional advertised dimensions), expired models, exhausted free
quota or unverified capabilities disable inference. OpenRouter uses only the six
exact allowlisted `:free` IDs, zero maximum prompt/completion/request/image prices,
no fallback, no plugins and no automatic router. Inference retries are disabled.

New models require explicit per-request consent before any history, attachment,
memory, tool schema or tool result is sent. The UI requests informed consent when
selecting one, held in session storage per model. Selecting a saved default does
not confer consent. Free providers may retain or use content; consent is not a
confidentiality guarantee. Do not send credentials or confidential content.

Catalog evidence (2026-10-19, no inference): Google and Groq discovery APIs list
all seven configured IDs. OpenRouter lists all six requested IDs with zero prompt
and completion prices and tool support; only Super VL and MiniMax among those six
advertise image inputs. OpenRouter account metadata reports a free account and
50 remaining daily requests. Groq Qwen advertises vision; GPT-OSS is text-only.
Clawbit supports text and inline images, with documents continuing through RAG;
it does not claim native PDF/video support. Context estimates are conservative
UTF-8 byte bounds plus image allowances, not exact provider tokenization.

Sources:
- https://console.groq.com/docs/models
- https://console.groq.com/docs/rate-limits
- https://console.groq.com/docs/model/qwen/qwen3.8-27b
- https://console.groq.com/docs/tool-use/overview
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
- https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
- https://openrouter.ai/api/v1/models
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/docs/api/reference/limits

Integrated and offline-tested; live provider verification pending. Catalog and
account checks do not prove successful hosted inference. The optional smoke CLI
requires explicit opt-in; ordinary tests and builds never call live inference.

Final read-only catalog recheck on 2026-10-20: all 13 registry entries passed the
runtime eligibility checks. This includes the 11 targets below and the preserved
`gemini-3.1-flash-lite` (unchanged default) and `gemini-3.5-flash`.

## Acceptance matrix

Text, streaming and tools below describe implemented, offline-tested support,
not successful hosted inference. Free verification combines provider catalog and
pricing evidence with the owner's Google/Groq billing attestation; OpenRouter
also uses authenticated free-account/quota metadata. Status **Offline** means
**Integrated and offline tested**. No model has been live inference tested.

| Model | Provider | Present before | Integrated | Free verified | Text | Streaming | Tools | Vision | Live tested | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `openai/gpt-oss-20b` | Groq | Yes | Yes | Yes* | Yes | Yes | Yes | No | No | Offline |
| `openai/gpt-oss-120b` | Groq | No | Yes | Yes* | Yes | Yes | Yes | No | No | Offline |
| `qwen/qwen3.8-27b` | Groq | No | Yes | Yes* | Yes | Yes | Yes | Yes | No | Offline |
| `gemini-3.8-flash` | Google | No | Yes | Yes* | Yes | Yes | Yes | Yes | No | Offline |
| `gemini-3.5-flash-lite` | Google | No | Yes | Yes* | Yes | Yes | Yes | Yes | No | Offline |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | OpenRouter | No | Yes | Yes* | Yes | Yes | Yes | No | No | Offline |
| `nvidia/nemotron-3-super-120b-a12b:free` | OpenRouter | No | Yes | Yes* | Yes | Yes | Yes | No | No | Offline |
| `nvidia/nemotron-3.5-lightning:free` | OpenRouter | No | Yes | Yes* | Yes | Yes | Yes | No | No | Offline |
| `cohere/north-mini-code:free` | OpenRouter | No | Yes | Yes* | Yes | Yes | Yes | No | No | Offline |
| `nvidia/nemotron-3.5-super-vl:free` | OpenRouter | No | Yes | Yes* | Yes | Yes | Yes | Yes | No | Offline |
| `minimax/minimax-m3.1-flash:free` | OpenRouter | No | Yes | Yes* | Yes | Yes | Yes | Yes | No | Offline |

*Eligibility is conditional on the account safeguards above and current catalog
checks. It is not a guarantee against later account-level billing changes.

## Exact files changed in this integration

Paths are relative to the project root. Earlier Batch 1-3 changes in these files
were retained; the existing working tree contains additional unrelated changes.

| File | Integration change |
|---|---|
| `backend/models.py` | Central registry, capability/account/catalog guards, SDK factories, lazy guarded embeddings. |
| `backend/openrouter_model.py` (new) | Fixed-endpoint OpenRouter transport, streaming, tools, zero-price routing. |
| `backend/free_tier_policy.json` (new) | Owner's free-account attestation bound to current credential fingerprints. |
| `backend/model_smoke.py` (new) | Explicit-opt-in, one-request-per-model text smoke CLI. |
| `backend/agent.py` | Consent, input budgets, safe provider errors, tool-response validation. |
| `backend/app.py` | Model discovery endpoint, request guards, capability-aware images, safe chat/SSE errors and final-answer delivery. |
| `backend/tool.py` | Consent guard for optional model-based query rewriting. |
| `backend/rag.py` | Lazy guarded embeddings; remove unused eager vision client. Existing RAG pipeline retained. |
| `backend/requirements.txt` | Declare already-installed `httpx==0.28.1`; no dependency installation or upgrade. |
| `backend/tests/conftest.py` | Isolated, offline provider/account fixtures and disabled tracing. |
| `backend/tests/test_api.py` | Assert explicit rejection of unknown IDs. |
| `backend/tests/test_models.py` (new) | 104 provider, adapter, API, agent, checkpoint, consent and capability regression cases. |
| `frontend/lib/models.ts` | Known-model placeholders, validated catalog merge, per-model consent and image guards. |
| `frontend/lib/api.ts` | Fetch server catalog and include consent in normal/stream requests. |
| `frontend/lib/settings.ts` | Keep valid saved defaults while availability is being checked. |
| `frontend/hooks/useModels.ts` (new) | Refresh server availability and fail closed on discovery errors. |
| `frontend/components/layout/ModelChoices.tsx` (new) | Shared provider grouping, availability reasons and consent selection. |
| `frontend/components/layout/Composer.tsx` | Integrate live choices and upload/send guards. |
| `frontend/components/projects/ProjectCommandBar.tsx` | Same choices and guards for project chats. |
| `frontend/components/settings/SettingsWorkspace.tsx` | Verified defaults and provider labels. |
| `frontend/tests/register-tsx.mjs` | Extend existing lightweight loader to TypeScript and project aliases. |
| `frontend/tests/models.test.mjs` (new) | Nine frontend model/consent/API integration tests. |
| `docs/FREE_MODELS.md` (new) | Policy, sources, compatibility, results and handoff. |

## Verification results

Commands used the existing installed environments. Backend commands ran from
`backend`; frontend commands ran from `frontend`.

| Command | Result |
|---|---|
| `.\.venv\Scripts\python.exe -m pytest tests/test_models.py -q -x` | 103 passed at the focused run; the final context/schema-budget case was then added and passed in the full suite (104 model cases total). |
| `.\.venv\Scripts\python.exe -m pytest tests/test_untrusted_content.py tests/test_api.py tests/test_upload_security.py -q` | 127 passed. |
| `.\.venv\Scripts\python.exe -m pytest -q` | **440 passed, 2 known baseline failures**, 8 warnings. |
| `.\.venv\Scripts\python.exe -m compileall -q models.py openrouter_model.py model_smoke.py agent.py app.py tool.py rag.py tests` | Passed. |
| `npm test` | **20 passed, 0 failed** (9 model tests plus 11 existing Markdown tests). |
| `.\node_modules\.bin\tsc.cmd --noEmit --incremental false` | Passed. |
| `npm run lint` | Passed. |
| `npm run build` | Passed, 12 static pages generated. |
| `git diff --check` | Passed; only existing line-ending notices. |
| Read-only `models.model_catalog()` | 13/13 eligible, no inference. |

The two unchanged failures are
`tests/test_mcp.py::test_local_mcp_server_discovers_project_status_tool` and
`tests/test_mcp.py::test_local_mcp_project_status_tool_executes`. They expect the
removed default `get_project_status` tool. MCP production behavior and those
assertions were not changed to hide the baseline failures. No new regression was
observed. GitHub interoperability is tested with local mocked tools; no real
repository write operations were issued. Backend persistence tests use isolated
temporary data, and provider network access is blocked during tests.

Windows sandbox restrictions blocked async loopback sockets and the production
build's directory access. Those checks succeeded outside the sandbox using the
same installed environments. No dependencies were installed to run checks.

## Remaining verification and operator actions

Implementation and offline acceptance are complete. Actual hosted text,
streaming, tools and vision behavior remain unverified. No live inference was
authorized or run. Optional minimal text checks can be explicitly opted into
from `backend`, for example:

```powershell
.\.venv\Scripts\python.exe model_smoke.py openai/gpt-oss-120b --allow-free-inference
```

This issues at most one initial text request per selected model, checks current
free eligibility first, and reports streaming/tools/vision as not tested. It
does not automatically run those additional capability checks. Quotas, provider
availability and pricing may change. Context accounting is conservative rather
than an exact provider tokenizer. Free-provider consent is not a confidentiality
guarantee.

No `.env` changes, secret exposure, billing changes, purchased credits, paid
fallback, commits, pushes, branch switches, stashes or resets occurred. The
existing Batch 1-3 protections and user data were preserved. Final tracked diff
at handoff: 18 files, 2,754 insertions and 1,203 deletions, including pre-existing
Batch 1-3 changes and excluding untracked new files. This is a working-tree
summary, not a task-only change count.

## Gemini 3.8 smoke failure follow-up (2026-10-20)

Confirmed local defects, reproduced without contacting inference endpoints:

1. The installed `langchain-google-genai` 4.2.4 adapter injects
   `candidate_count=1`, and Clawbit supplies `temperature=0.3`. Google's specific
   [Gemini 3.8 migration guide](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.8)
   says to remove `candidate_count`, `temperature`, `top_p` and `top_k`.
   The [parameter changes guide](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.6)
   distinguishes ignored/deprecated sampling parameters from future rejection.
   This is a confirmed request incompatibility; it does not establish the HTTP
   status of the user's historical failure. A narrow SDK subclass now removes
   these fields from the final Gemini 3.8 config, including call-time overrides.
   Other Gemini model configs are unchanged. No dependency upgrade was needed.
2. Even a successful Gemini response failed the smoke check: the adapter returns
   `AIMessage.content` as text blocks, while the CLI required a string and raised
   `ValueError("Invalid response")`. `provider_error()` then converted that local
   validation error into the generic provider-unavailable message. The CLI now
   accepts string/text-block answers and rejects reasoning-only responses.
3. The coroutine warning comes from LangChain Core 1.4.0's
   `_generate_response_from_error()` in `language_models/chat_models.py`, which
   calls `response.json()` synchronously. `aiohttp.ClientResponse.json()` is
   async. Installed `google-genai` 2.12.1 correctly awaits JSON while handling the
   original failed response; the warning occurs afterward during LangChain's
   error-metadata collection. A mocked HTTP 503 reproduces this with an original
   `google.genai.errors.ServerError(code=503)`; the collector then creates a
   second, unawaited coroutine. The warning is not the cause of that HTTP failure.
   Google SDK errors are now sanitized before they reach the collector in all
   four sync/async and normal/stream paths. This also prevents raw provider error
   bodies from being copied to callback metadata. Cancellation remains uncaught.

The original live exception cannot be reconstructed from the reported output:
the old CLI discarded its type/status, and no matching saved warning log was
found. It would be inaccurate to claim that the historical request definitely
failed with HTTP 400 or 503. New failed smoke rows add safe `error_type` and
`status_code` diagnostics; raw error text, bodies and request credentials remain
excluded. HTTP 503 now retains its status through the safe error mapper.

The smoke request still sends the same harmless prompt with a 64-token output
cap. For Gemini 3.8 only, it explicitly requests `thinking_level="low"` to reduce
thinking within that small budget. The [model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
supports low/medium/high and rejects minimal. Normal chat retains the provider's
thinking-level default; `include_thoughts=False` and no legacy thinking budget
are preserved. Wire tests confirm a non-empty user text turn. The existing SDK
continues to handle conversation/tool/image serialization; no history, tool or
RAG format migration was made.

Files changed in this follow-up:

- `backend/models.py`: narrow Gemini config compatibility and safe SDK error
  boundary; safe exception-type diagnostics and HTTP 503 mapping.
- `backend/model_smoke.py`: text-block support, low-thinking minimal smoke and
  safe failure diagnostics. Explicit opt-in remains mandatory.
- `backend/tests/test_gemini_compatibility.py` (new): 23 offline cases covering
  actual SDK wire requests, sync/async streams, error callbacks, retry limits,
  preserved existing models, response blocks and reasoning exclusion.
- `docs/FREE_MODELS.md`: this investigation and verification record.

Verification from `backend`:

- `.\.venv\Scripts\python.exe -m pytest tests/test_gemini_compatibility.py -q -W error::RuntimeWarning`:
  first 13 regression cases passed before the additional compatibility cases.
- `.\.venv\Scripts\python.exe -m pytest -q -W error::RuntimeWarning`:
  **463 passed, 2 unchanged baseline MCP failures, 8 pre-existing deprecation
  warnings**. All 23 new cases passed. The two failures remain the historical
  `get_project_status` expectations listed above. No new regression was observed.
- `.\.venv\Scripts\python.exe -m compileall -q models.py model_smoke.py tests/test_gemini_compatibility.py`:
  passed.
- `git diff --check`: passed (existing line-ending notices only).

No live inference was run during this fix. Google's current
[pricing table](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash)
still lists standard Gemini 3.8 text input/output as free on the Free Tier.
Another single minimal text smoke is reasonable under the confirmed
billing-disabled account and existing runtime eligibility checks. It requires
new explicit authorization for the agent to run it; the user can also invoke the
existing CLI with `gemini-3.8-flash --allow-free-inference`. Success is not
guaranteed: the small token budget, quota, access and provider availability still
apply. **The live issue is not declared resolved until that test actually passes.**

Free-account fingerprints, billing/allowlist/consent guards, timeout and configured
single-attempt policy remain intact. No `.env`, dependency versions, provider
endpoints, MCP implementation, frontend, RAG, stored data or Git history changed
in this follow-up.

## OpenRouter availability after Batch 4A — 2026-10-20

The frontend registry, selected request ID, backend allowlist and provider payload
all use `nvidia/nemotron-3-super-120b-a12b:free`. That ID remains correct in
[OpenRouter's model documentation](https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free/api).
No ID replacement, authentication bypass or environment change is required.
The existing absolute backend `.env` loading and account/free-tier checks worked
during read-only checks of all three configured providers.

The reported SSE sequence locates the failure after local checks: normalization,
consent and model availability validation occur before the streaming response.
An SSE `start` followed by the fixed 404 message therefore is not the local
unknown-ID or missing-catalog error. OpenRouter can return 404 when no endpoint
can serve the request under its routing constraints; the previous generic error
incorrectly implied that the model had been removed.

The read-only public
[Super endpoint metadata](https://openrouter.ai/api/v1/models/nvidia/nemotron-3-super-120b-a12b:free/endpoints)
reported one Nvidia endpoint with `status=-5`, zero prompt/completion pricing,
supported tools/reasoning parameters, and 0% uptime in both recent windows.
OpenRouter's
[first-party endpoint reference](https://github.com/OpenRouterTeam/skills/blob/main/skills/openrouter-models/SKILL.md#api-response-shapes)
defines status 0 as operational and nonzero as degraded. This confirms the
current upstream endpoint problem. The original raw error body was deliberately
not retained by Clawbit, so no claim is made about its private diagnostic text.

The application defect was treating membership in the global model catalog as
operational availability. The targeted fix adds a read-only endpoint check:
at least one endpoint must match the exact free ID, have operational status,
have explicitly zero pricing, and support tools. Missing, malformed, degraded,
paid or mismatched endpoint records fail closed. Positive and negative results
are cached for thirty seconds, allowing recovery without a backend restart.
The existing frontend refreshes the catalog every minute.

Known endpoint outages now appear as unavailable entries in `/models` and are
rejected with HTTP 503 before agent work or SSE starts. If an endpoint becomes
unavailable after validation, OpenRouter HTTP/in-band 404 errors become a fixed
503 message about eligible free endpoints, with no raw provider response leaked.
The original provider status remains available as a safe internal numeric
diagnostic. Other providers retain their existing 404 handling.

The thirteen-entry catalog and response schema are preserved. Authenticated API
regressions measured a complete 5,785-byte JSON catalog; a real configured
read-only catalog serialized to 5,918 bytes. Batch 4A's `X-CSRF-Token` header on
GET requests introduces a CORS OPTIONS preflight, whose body is only `OK` and
whose headers account for a small network entry. A preflight is not the model
catalog. The reported browser row was not captured during this investigation;
the 0.3 KB observation is consistent with that preflight, while a truncated
authenticated GET response was not reproduced.

Read-only configured-status snapshot (eligibility, not live inference):

| Registered model ID | Result |
| --- | --- |
| `gemini-3.1-flash-lite` | Eligible |
| `gemini-3.5-flash` | Eligible |
| `gemini-3.8-flash` | Eligible |
| `gemini-3.5-flash-lite` | Eligible |
| `openai/gpt-oss-20b` | Eligible |
| `openai/gpt-oss-120b` | Eligible |
| `qwen/qwen3.8-27b` | Eligible |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | Eligible |
| `nvidia/nemotron-3-super-120b-a12b:free` | No operational zero-cost tool endpoint |
| `nvidia/nemotron-3.5-lightning:free` | Eligible |
| `cohere/north-mini-code:free` | Eligible |
| `nvidia/nemotron-3.5-super-vl:free` | No operational zero-cost tool endpoint |
| `minimax/minimax-m3.1-flash:free` | Eligible |

These are time-dependent provider observations. All thirteen remain registered;
none were removed or marked available by a hardcoded production override.
Account verification, key fingerprints, free quota, exact allowlisting, consent,
zero maximum prices, required parameter support, disabled fallbacks and the
single-attempt transport policy remain enforced.

Files changed by this fix:

- `backend/models.py`: endpoint availability validation/cache, shared strict
  zero-pricing check and OpenRouter-specific error classification.
- `backend/openrouter_model.py`: pass provider context to safe error handling.
- `backend/tests/conftest.py`: isolated mocked endpoint metadata for existing
  offline tests; production checks remain enabled.
- `backend/tests/test_openrouter_availability.py`: 25 new regression cases.
- `frontend/tests/models.test.mjs`: two Nemotron Super/catalog regressions.
- `docs/FREE_MODELS.md`: investigation, status snapshot and verification.

Verification:

- Backend affected run:
  `.\.venv\Scripts\python.exe -m pytest tests/test_openrouter_availability.py tests/test_models.py tests/test_gemini_compatibility.py tests/test_auth.py tests/test_mcp_compatibility.py tests/test_upload_security.py -q -W error::RuntimeWarning`.
  The initial run passed 292 tests and exposed an incorrect new test assumption
  that a complete catalog must exceed 6,000 bytes. The 5,785-byte response was
  valid. That test now checks all thirteen exact IDs/providers and JSON format.
- Focused corrected run:
  `.\.venv\Scripts\python.exe -m pytest tests/test_openrouter_availability.py -q -W error::RuntimeWarning`:
  **25 passed**. Together with the **268 existing affected cases** that passed
  in the main run, all 293 distinct affected cases passed across these runs.
  The runs overlap and must not be added as independent test counts.
- The new cases exercise actual authenticated API admission, CORS preflight vs
  GET catalog, endpoint failure/recovery, safe 404 handling, and real transport
  SSE serialization through mocked HTTP. They assert unchanged free routing and
  no inference request on a known outage.
- `npm test`: **37 passed**, including both new frontend regressions and existing
  authentication/model/Markdown coverage.
- `.\node_modules\.bin\tsc.cmd --noEmit --incremental false`, `npm run lint`,
  and `npm run build`: passed. The build generated all twelve static pages.
- Python compilation and whitespace checks passed for all changed Python files.
- `git diff --check`: passed; existing line-ending notices only.

Authentication, MCP, uploads, RAG and stored data were not changed by this fix.
No `.env`, dependencies, commits, pushes or branches changed. Only catalog,
account-status and endpoint metadata GET requests contacted real providers;
no real generation or paid inference was run.

The false-availability and misleading-error defects are fixed. A code change
cannot restore an unavailable upstream endpoint. Live Nemotron Super streaming
must not be declared restored until its service recovers and a separately
authorized free-tier smoke test produces tokens. No paid model, fallback,
privacy-policy relaxation or billing change is an acceptable workaround.
