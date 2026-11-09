"""Tests for the minimal SQLite-to-Postgres compatibility adapter."""

from postgres_db import HybridRow, _qmark_to_pyformat, translate_sql


def test_qmark_translation_skips_quoted_question_marks():
    sql = "SELECT '?' AS literal, value FROM t WHERE id=? AND note='why?' AND n=?"
    assert _qmark_to_pyformat(sql) == (
        "SELECT '?' AS literal, value FROM t WHERE id=%s AND note='why?' AND n=%s"
    )


def test_translate_sql_handles_only_supported_compatibility_syntax():
    assert translate_sql("BEGIN IMMEDIATE") == "BEGIN"
    assert translate_sql("SELECT * FROM users WHERE name = ? COLLATE NOCASE") == (
        "SELECT * FROM users WHERE name = %s"
    )
    assert translate_sql("SELECT datetime('now')") == "SELECT CURRENT_TIMESTAMP"


def test_hybrid_row_supports_mapping_and_positional_access():
    row = HybridRow({"id": 7, "role": "admin"})
    assert row["id"] == 7
    assert row[0] == 7
    assert row[1] == "admin"
    assert dict(row) == {"id": 7, "role": "admin"}
