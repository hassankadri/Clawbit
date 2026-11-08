
"""HTTP-level isolation tests using two real registered Clawbit accounts."""

from fastapi.testclient import TestClient
import pytest

import app as api
import rag
from test_upload_security import LocalIndex

ADMIN_PASSWORD = "Saffron rivers carry seven boats!"
USER_PASSWORD = "Mango trees grow beyond seven quiet hills!"
ORIGIN = "http://localhost:3000"


def register(client: TestClient, email: str) -> str:
    """Register one account through the real pre-session + CSRF flow."""
    client.headers["Origin"] = ORIGIN

    response = client.get("/auth/session")
    assert response.status_code == 200, response.text
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]

    response = client.post(
        "/auth/register",
        json={"email": email, "password": USER_PASSWORD},
    )
    assert response.status_code == 200, response.text

    payload = response.json()
    assert payload["user"]["role"] == "user"
    client.headers["X-CSRF-Token"] = payload["csrf_token"]

    return payload["user"]["principal_id"]


@pytest.fixture
def isolated_upload_storage(tmp_path, monkeypatch):
    """Keep uploaded files and the vector index local to this test."""
    root = tmp_path / "uploads"
    root.mkdir()

    monkeypatch.setattr(rag, "UPLOAD_ROOT", root)
    monkeypatch.setattr(rag, "vectorstore", LocalIndex())
    monkeypatch.setattr(
        rag,
        "_rerank_documents",
        lambda query, docs, limit: docs[:limit],
    )

    rag._RAG_CACHE.clear()
    yield
    rag._RAG_CACHE.clear()


def test_two_registered_accounts_cannot_access_each_others_data(
    auth_store, isolated_upload_storage,
):
    """Account B cannot read, overwrite, delete, or claim Account A resources."""

    # Bootstrap the existing administrator.
    auth_store.create_owner("isolation-admin", ADMIN_PASSWORD)

    with (
        TestClient(api.app, base_url="http://localhost:8000") as alice,
        TestClient(api.app, base_url="http://localhost:8000") as bob,
    ):
        # Create two independent normal accounts.
        alice_id = register(alice, "alice-isolation@example.com")
        bob_id = register(bob, "bob-isolation@example.com")

        assert alice_id != bob_id

        thread = "alice-private-thread"
        workspace = "alice-private-workspace"

        # 1. Alice creates a conversation.
        created = alice.post("/history", json={
            "thread_id": thread,
            "workspace_id": workspace,
            "id": "alice-display-id",
            "title": "Alice private chat",
            "model": "gemini-3.1-flash-lite",
            "mode": "normal",
        })

        assert created.status_code == 200, created.text

        # Add private conversation content.
        imported = alice.post(f"/history/{thread}/import", json={
            "version": 0,
            "import_id": "alice-import",
            "confirmed_principal": alice_id,
            "updatedAt": 1000,
            "messages": [
                {
                    "id": "alice-user",
                    "role": "user",
                    "content": "ALICE_PRIVATE_CHAT_MARKER",
                },
                {
                    "id": "alice-ai",
                    "role": "assistant",
                    "content": "ALICE_PRIVATE_REPLY_MARKER",
                },
            ],
        })

        assert imported.status_code == 200, imported.text

        # 2. Alice creates workspace and account-scoped memories.
        workspace_memory = alice.post("/memories", json={
            "content": "ALICE_PRIVATE_WORKSPACE_MEMORY_MARKER",
            "scope": "workspace",
            "workspace_id": workspace,
            "confirmed": True,
        })

        assert workspace_memory.status_code == 200, workspace_memory.text
        workspace_memory_id = workspace_memory.json()["id"]

        user_memory = alice.post("/memories", json={
            "content": "ALICE_PRIVATE_USER_MEMORY_MARKER",
            "scope": "user",
            "confirmed": True,
        })

        assert user_memory.status_code == 200, user_memory.text
        user_memory_id = user_memory.json()["id"]

        # 3. Alice uploads a private document.
        upload = alice.post(
            "/attachments/upload",
            data={"thread_id": thread},
            files={
                "file": (
                    "alice-private.txt",
                    b"ALICE_PRIVATE_FILE_MARKER",
                    "text/plain",
                )
            },
        )

        assert upload.status_code == 200, upload.text
        attachment = upload.json()["attachment_id"]

        # Positive controls: Alice can access her own resources.
        assert "ALICE_PRIVATE_CHAT_MARKER" in str(
            alice.get(f"/history/{thread}").json()
        )

        assert "ALICE_PRIVATE_WORKSPACE_MEMORY_MARKER" in str(
            alice.get(
                "/memories",
                params={
                    "scope": "workspace",
                    "workspace_id": workspace,
                },
            ).json()
        )

        assert "ALICE_PRIVATE_USER_MEMORY_MARKER" in str(
            alice.get("/memories", params={"scope": "user"}).json()
        )

        assert alice.get(
            f"/sources/{thread}/{attachment}/content"
        ).content == b"ALICE_PRIVATE_FILE_MARKER"

        # 4. HISTORY ISOLATION
        # B cannot enumerate, read, update, delete, import, or claim A's thread.

        assert thread not in str(bob.get("/history").json())

        assert bob.get(f"/history/{thread}").status_code == 404
        assert bob.get(f"/history/{thread}/revisions").status_code == 404

        assert bob.patch(
            f"/history/{thread}",
            json={"version": 0, "title": "stolen"},
        ).status_code == 404

        assert bob.delete(
            f"/history/{thread}?version=0"
        ).status_code == 404

        assert bob.post(
            f"/history/{thread}/import",
            json={
                "version": 0,
                "import_id": "forged-import",
                "confirmed_principal": alice_id,
                "updatedAt": 2000,
                "messages": [],
            },
        ).status_code == 404

        assert bob.post("/history", json={
            "thread_id": thread,
            "workspace_id": "bob-workspace",
            "id": "bob-id",
            "title": "takeover",
            "model": "gemini-3.1-flash-lite",
            "mode": "normal",
        }).status_code == 404

        # 5. MEMORY ISOLATION
        # B cannot read or modify either type of Alice's memories.

        foreign_workspace_memories = bob.get(
            "/memories",
            params={
                "scope": "workspace",
                "workspace_id": workspace,
            },
        )

        assert foreign_workspace_memories.status_code == 404, (
            "Bob must not access Alice's workspace memories."
        )

        assert bob.post("/memories", json={
            "content": "BOB_WORKSPACE_WRITE_ATTEMPT",
            "scope": "workspace",
            "workspace_id": workspace,
            "confirmed": True,
        }).status_code == 404

        assert "ALICE_PRIVATE_USER_MEMORY_MARKER" not in str(
            bob.get("/memories", params={"scope": "user"}).json()
        )

        assert bob.patch(
            f"/memories/{user_memory_id}",
            json={
                "content": "BOB_OVERWRITE_ATTEMPT",
                "scope": "user",
                "confirmed": True,
                "version": 0,
            },
        ).status_code == 404

        assert bob.delete(
            f"/memories/{user_memory_id}?version=0&scope=user"
        ).status_code == 404

        assert bob.delete(
            f"/memories/{workspace_memory_id}"
            f"?version=0&scope=workspace&workspace_id={workspace}"
        ).status_code == 404

        # 6. FILE AND RAG ISOLATION
        # B cannot read, download, delete, or upload into Alice's thread.

        assert bob.get(
            f"/sources/{thread}/{attachment}"
        ).status_code == 404

        assert bob.get(
            f"/sources/{thread}/{attachment}/content"
        ).status_code == 404

        assert bob.delete(
            f"/attachments/{thread}/{attachment}"
        ).status_code == 404

        assert bob.post(
            "/attachments/upload",
            data={"thread_id": thread},
            files={
                "file": ("bob.txt", b"BOB_FILE", "text/plain")
            },
        ).status_code == 404

        # 7. FINAL INTEGRITY CHECK
        # B's attacks must not modify Alice's original resources.

        assert "ALICE_PRIVATE_CHAT_MARKER" in str(
            alice.get(f"/history/{thread}").json()
        )

        assert "ALICE_PRIVATE_WORKSPACE_MEMORY_MARKER" in str(
            alice.get(
                "/memories",
                params={
                    "scope": "workspace",
                    "workspace_id": workspace,
                },
            ).json()
        )

        assert "ALICE_PRIVATE_USER_MEMORY_MARKER" in str(
            alice.get("/memories", params={"scope": "user"}).json()
        )

        assert alice.get(
            f"/sources/{thread}/{attachment}/content"
        ).content == b"ALICE_PRIVATE_FILE_MARKER"
