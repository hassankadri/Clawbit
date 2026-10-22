"""Bounded research policy layered onto the existing graph."""

from langchain_core.messages import HumanMessage

import memory_store
from evidence import EVIDENCE_POLICY, current_evidence, evidence_note
from untrusted_content import untrusted_data
from observability import event


def research_tools_allowed(tools: list) -> list:
    """Only advertised read-only connector tools may participate in research."""
    return [
        item for item in tools
        if not (item.metadata or {}).get("clawbit_mcp")
        or (item.metadata or {}).get("readOnlyHint") is True
    ]


def evidence_instructions() -> str:
    ledger = current_evidence()
    if not ledger:
        return EVIDENCE_POLICY
    with ledger.lock:
        identifiers = ", ".join(ledger.records) or "none"
    return EVIDENCE_POLICY + "\nSources available in this execution: " + identifiers


def memory_messages(config: dict) -> list[HumanMessage]:
    """Optional context failures do not turn a valid chat into a provider error."""
    workspace = config.get("workspace_id") or config.get("thread_id")
    query = config.get("user_query", "")
    if not workspace or not query:
        return []
    try:
        context = memory_store.store.context(query, workspace)
    except Exception as exc:
        event("memory", "failed", error=exc, action="read", category="persistence")
        evidence_note("Saved memory could not be read; this response proceeds without it.")
        return []
    return [HumanMessage(content=untrusted_data("saved_memory", context))] if context else []


def partial_research_answer() -> str:
    event("research", "partial", category="tools")
    evidence_note("The research tool budget was reached; further tool calls were not executed.")
    ledger = current_evidence()
    sources = []
    if ledger:
        with ledger.lock:
            sources = list(ledger.records.values())
    if not sources:
        return (
            "Research stopped at its tool limit before usable evidence was obtained. "
            "No source-backed conclusion is available."
        )
    references = "\n".join(f"- {source['file']} [{source['source_id']}]" for source in sources)
    return (
        "Research reached its tool limit. These sources were retrieved, but the requested "
        "synthesis is incomplete; their presence does not establish a conclusion.\n\n" + references
    )
