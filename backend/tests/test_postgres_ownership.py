"""Tests for Neon ownership isolation without a live database."""

from contextlib import contextmanager

import pytest

from ownership import OwnershipError, owner_context
from postgres_db import HybridRow
import postgres_ownership


class FakeCursor:
    def __init__(self, row=None, rows=None):
        self._row = row
        self._rows = rows or []

    def fetchone(self):
        return self._row

    def __iter__(self):
        return iter(self._rows)


class FakeConnection:
    def __init__(self, registry):
        self.registry = registry

    def execute(self, sql, params=()):
        compact = " ".join(sql.split()).upper()

        if compact.startswith("INSERT INTO RESOURCES"):
            kind, resource_id, principal = params
            self.registry.setdefault((kind, resource_id), principal)
            return FakeCursor()

        if compact.startswith("SELECT PRINCIPAL_ID FROM RESOURCES"):
            kind, resource_id = params
            principal = self.registry.get((kind, resource_id))
            return FakeCursor(
                None if principal is None else HybridRow({"principal_id": principal})
            )

        if compact.startswith("SELECT RESOURCE_ID FROM RESOURCES"):
            kind, principal = params
            rows = [
                {"resource_id": resource_id}
                for (resource_kind, resource_id), owner in self.registry.items()
                if resource_kind == kind and owner == principal
            ]
            return FakeCursor(rows=[HybridRow(row) for row in rows])

        if compact.startswith("SELECT TO_REGCLASS"):
            return FakeCursor(row={
                "resources_table": "resources",
                "claims_table": "claims",
                "claim_resources_table": "claim_resources",
                "rollbacks_table": "rollbacks",
            })

        raise AssertionError(f"Unexpected SQL: {sql}")


def install_fake_registry(monkeypatch):
    registry = {}

    @contextmanager
    def connection():
        yield FakeConnection(registry)

    monkeypatch.setattr(postgres_ownership, "postgres_connection", connection)
    store = postgres_ownership.PostgresOwnershipStore()
    return store, registry


def test_postgres_registry_creates_once_and_denies_other_principal(monkeypatch):
    store, registry = install_fake_registry(monkeypatch)

    with owner_context("principal-a"):
        store.authorize("thread", "thread-123", create=True)
        store.authorize("thread", "thread-123")
        assert store.owned_ids("thread") == ["thread-123"]

    with owner_context("principal-b"):
        with pytest.raises(OwnershipError):
            store.authorize("thread", "thread-123", create=True)
        assert store.owned_ids("thread") == []

    assert registry[("thread", "thread-123")] == "principal-a"


def test_postgres_registry_missing_ok_does_not_create(monkeypatch):
    store, registry = install_fake_registry(monkeypatch)

    with owner_context("principal-a"):
        store.authorize("thread", "missing-thread", missing_ok=True)

    assert registry == {}


def test_postgres_registry_cannot_create_unapproved_kind(monkeypatch):
    store, _ = install_fake_registry(monkeypatch)

    with owner_context("principal-a"):
        with pytest.raises(OwnershipError):
            store.authorize("admin", "anything", create=True)


def test_postgres_registry_owned_ids_are_principal_scoped(monkeypatch):
    store, _ = install_fake_registry(monkeypatch)

    with owner_context("principal-a"):
        store.authorize("thread", "a-thread", create=True)
        store.authorize("workspace", "a-workspace", create=True)

    with owner_context("principal-b"):
        store.authorize("thread", "b-thread", create=True)

    with owner_context("principal-a"):
        assert store.owned_ids("thread") == ["a-thread"]
        assert store.owned_ids("workspace") == ["a-workspace"]

    with owner_context("principal-b"):
        assert store.owned_ids("thread") == ["b-thread"]
