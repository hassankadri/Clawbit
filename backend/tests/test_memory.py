import uuid

from database import (
    LongTermMemory,
    SessionLocal,
    Workspace,
    save_memory,
    search_memory,
)


def test_workspace_memory_is_shared_and_isolated():
    suffix = uuid.uuid4().hex[:8]

    workspace_a = f"pytest-a-{suffix}"
    workspace_b = f"pytest-b-{suffix}"

    thread_a1 = f"pytest-a1-{suffix}"
    thread_a2 = f"pytest-a2-{suffix}"
    thread_b1 = f"pytest-b1-{suffix}"

    memory_text = f"Project codename is Falcon-{suffix}."

    try:
        save_result = save_memory(
            thread_id=thread_a1,
            workspace_id=workspace_a,
            memory=memory_text,
        )

        same_workspace = search_memory(
            thread_id=thread_a2,
            workspace_id=workspace_a,
            query="project codename",
        )

        different_workspace = search_memory(
            thread_id=thread_b1,
            workspace_id=workspace_b,
            query="project codename",
        )

        assert save_result == "Memory saved successfully."
        assert memory_text in same_workspace
        assert memory_text not in different_workspace

    finally:
        db = SessionLocal()

        try:
            db.query(LongTermMemory).filter(
                LongTermMemory.workspace_id.in_(
                    [workspace_a, workspace_b]
                )
            ).delete(
                synchronize_session=False
            )

            db.query(Workspace).filter(
                Workspace.id.in_(
                    [workspace_a, workspace_b]
                )
            ).delete(
                synchronize_session=False
            )

            db.commit()

        finally:
            db.close()


def test_duplicate_memory_is_not_saved_twice():
    suffix = uuid.uuid4().hex[:8]

    workspace_id = f"pytest-dup-{suffix}"
    thread_id = f"pytest-thread-{suffix}"
    memory_text = f"Preferred framework is FastAPI-{suffix}."

    try:
        first = save_memory(
            thread_id=thread_id,
            workspace_id=workspace_id,
            memory=memory_text,
        )

        second = save_memory(
            thread_id=thread_id,
            workspace_id=workspace_id,
            memory=memory_text,
        )

        assert first == "Memory saved successfully."
        assert second == "This memory is already saved."

    finally:
        db = SessionLocal()

        try:
            db.query(LongTermMemory).filter(
                LongTermMemory.workspace_id == workspace_id
            ).delete(
                synchronize_session=False
            )

            db.query(Workspace).filter(
                Workspace.id == workspace_id
            ).delete(
                synchronize_session=False
            )

            db.commit()

        finally:
            db.close()
