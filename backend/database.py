from datetime import datetime
from pathlib import Path
import os
from upload_security import validate_thread_id
import ownership
from ownership import bind_resources, require_thread, require_workspace

from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    String,
    Text,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.orm import (
    declarative_base,
    sessionmaker,
)


BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("CLAWBIT_RUNTIME_DIR", BACKEND_DIR)) / "data"
DATA_DIR.mkdir(
    parents=True,
    exist_ok=True,
)

DATABASE_PATH = DATA_DIR / "chatbot_memory.db"

DATABASE_URL = (
    f"sqlite:///{DATABASE_PATH.as_posix()}"
)

engine = create_engine(
    DATABASE_URL,
    connect_args={
        "check_same_thread": False,
    },
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)

Base = declarative_base()


class Workspace(Base):
    __tablename__ = "workspaces"

    id = Column(
        String,
        primary_key=True,
    )

    name = Column(
        String,
        default="Default Workspace",
    )

    created_at = Column(
        DateTime,
        default=datetime.utcnow,
    )

    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
    )


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
    )

    thread_id = Column(
        String,
        unique=True,
        index=True,
    )

    workspace_id = Column(
        String,
        index=True,
        nullable=True,
    )

    title = Column(
        String,
        default="New Chat",
    )

    created_at = Column(
        DateTime,
        default=datetime.utcnow,
    )

    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
    )

    thread_id = Column(
        String,
        index=True,
    )

    workspace_id = Column(
        String,
        index=True,
        nullable=True,
    )

    role = Column(String)
    content = Column(Text)

    created_at = Column(
        DateTime,
        default=datetime.utcnow,
    )


class LongTermMemory(Base):
    __tablename__ = "long_term_memory"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
    )

    thread_id = Column(
        String,
        index=True,
    )

    workspace_id = Column(
        String,
        index=True,
        nullable=True,
    )

    memory = Column(Text)

    created_at = Column(
        DateTime,
        default=datetime.utcnow,
    )


def _add_column_if_missing(
    table_name: str,
    column_name: str,
    column_sql: str,
):
    db_inspector = inspect(engine)

    if table_name not in db_inspector.get_table_names():
        return

    existing_columns = {
        column["name"]
        for column in db_inspector.get_columns(
            table_name
        )
    }

    if column_name in existing_columns:
        return

    with engine.begin() as connection:
        connection.execute(
            text(
                f"ALTER TABLE {table_name} "
                f"ADD COLUMN {column_name} "
                f"{column_sql}"
            )
        )


def _migrate_workspace_columns():
    _add_column_if_missing(
        "conversations",
        "workspace_id",
        "VARCHAR",
    )

    _add_column_if_missing(
        "chat_messages",
        "workspace_id",
        "VARCHAR",
    )

    _add_column_if_missing(
        "long_term_memory",
        "workspace_id",
        "VARCHAR",
    )

    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE conversations
                SET workspace_id = thread_id
                WHERE workspace_id IS NULL
                   OR workspace_id = ''
                """
            )
        )

        connection.execute(
            text(
                """
                UPDATE chat_messages
                SET workspace_id = thread_id
                WHERE workspace_id IS NULL
                   OR workspace_id = ''
                """
            )
        )

        connection.execute(
            text(
                """
                UPDATE long_term_memory
                SET workspace_id = thread_id
                WHERE workspace_id IS NULL
                   OR workspace_id = ''
                """
            )
        )


def init_db():
    Base.metadata.create_all(
        bind=engine
    )

    _migrate_workspace_columns()


def ensure_workspace(
    workspace_id: str,
    name: str | None = None,
):
    require_workspace(workspace_id, create=True)
    db = SessionLocal()

    try:
        workspace = (
            db.query(Workspace)
            .filter(
                Workspace.id
                == workspace_id
            )
            .first()
        )

        if not workspace:
            workspace = Workspace(
                id=workspace_id,
                name=(
                    name
                    or "Default Workspace"
                ),
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )

            db.add(workspace)

        else:
            workspace.updated_at = (
                datetime.utcnow()
            )

            if name:
                workspace.name = name

        db.commit()

        return workspace_id

    finally:
        db.close()


def create_or_update_conversation(
    thread_id: str,
    first_message: str | None = None,
    workspace_id: str | None = None,
):
    validate_thread_id(thread_id)
    workspace_id = (
        workspace_id
        or thread_id
    )

    bind_resources(thread_id, workspace_id)

    ensure_workspace(
        workspace_id
    )

    db = SessionLocal()

    try:
        conversation = (
            db.query(Conversation)
            .filter(
                Conversation.thread_id
                == thread_id
            )
            .first()
        )

        if not conversation:
            title = "New Chat"

            if first_message:
                cleaned = (
                    first_message.strip()
                )

                title = cleaned[:40]

                if len(cleaned) > 40:
                    title += "..."

            conversation = Conversation(
                thread_id=thread_id,
                workspace_id=workspace_id,
                title=title,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )

            db.add(conversation)

        else:
            conversation.workspace_id = (
                workspace_id
            )

            conversation.updated_at = (
                datetime.utcnow()
            )

        db.commit()

    finally:
        db.close()


def list_conversations(
    workspace_id: str | None = None,
):
    owned_threads = ownership.store.owned_ids("thread")
    if workspace_id:
        require_workspace(workspace_id)
    db = SessionLocal()

    try:
        query = db.query(Conversation).filter(Conversation.thread_id.in_(owned_threads))

        if workspace_id:
            query = query.filter(
                Conversation.workspace_id
                == workspace_id
            )

        return (
            query
            .order_by(
                Conversation.updated_at.desc()
            )
            .all()
        )

    finally:
        db.close()


def save_chat_message(
    thread_id: str,
    role: str,
    content: str,
    workspace_id: str | None = None,
):
    validate_thread_id(thread_id)
    workspace_id = (
        workspace_id
        or thread_id
    )

    bind_resources(thread_id, workspace_id)

    db = SessionLocal()

    try:
        msg = ChatMessage(
            thread_id=thread_id,
            workspace_id=workspace_id,
            role=role,
            content=content,
            created_at=datetime.utcnow(),
        )

        db.add(msg)

        conversation = (
            db.query(Conversation)
            .filter(
                Conversation.thread_id
                == thread_id
            )
            .first()
        )

        if conversation:
            conversation.updated_at = (
                datetime.utcnow()
            )

        db.commit()

    finally:
        db.close()


def get_chat_history(
    thread_id: str,
):
    validate_thread_id(thread_id)
    require_thread(thread_id, missing_ok=True)
    db = SessionLocal()

    try:
        return (
            db.query(ChatMessage)
            .filter(
                ChatMessage.thread_id
                == thread_id
            )
            .order_by(
                ChatMessage.created_at.asc()
            )
            .all()
        )

    finally:
        db.close()


def save_memory(thread_id: str, memory: str, workspace_id: str | None = None):
    """Compatibility entry point for trusted server-side workspace memory writes."""
    import memory_store

    workspace_id = workspace_id or thread_id
    bind_resources(thread_id, workspace_id)
    _, duplicate = memory_store.store.save(memory, "workspace", workspace_id, thread_id)
    return "This memory is already saved." if duplicate else "Memory saved successfully."


def search_memory(thread_id: str, query: str, workspace_id: str | None = None):
    """Read bounded, relevant memory within the verified workspace/user scopes."""
    import memory_store

    workspace_id = workspace_id or thread_id
    bind_resources(thread_id, workspace_id)
    return memory_store.store.context(query, workspace_id) or "No saved memory found."


init_db()
