"""Run isolated deterministic application evaluations using the existing pytest suite."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "evals" / "scenarios.json"


class EvaluationResults:
    """Capture assertion outcomes and numeric measurements, never exception bodies."""

    def __init__(self, scenarios: list[dict]) -> None:
        self.scenarios = scenarios
        self.results: dict[str, dict] = {}

    def pytest_runtest_logreport(self, report) -> None:
        if report.when != "call" and report.passed:
            return
        node = report.nodeid.split("[", 1)[0]
        scenario = next(item for item in self.scenarios if item["test"] == node)
        row = self.results.setdefault(report.nodeid, {
            **scenario, "test": report.nodeid, "status": "passed", "duration_seconds": 0.0,
            "actual": "All observable state/action assertions passed.", "measurements": {},
        })
        row["duration_seconds"] += report.duration
        if not report.passed:
            row["status"] = "failed"
            row["actual"] = f"Required check did not pass during {report.when}."
        for key, value in report.user_properties:
            if key == "evaluation_metrics":
                row["measurements"] = json.loads(value)


def main(argv: list[str] | None = None) -> int:
    scenarios = json.loads(MANIFEST.read_text(encoding="utf-8"))
    categories = sorted({item["category"] for item in scenarios})
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--category", choices=["all", *categories], default="all")
    parser.add_argument("--output", type=Path, default=ROOT / ".pytest_cache" / "evaluations")
    args = parser.parse_args(argv)
    selected = [item for item in scenarios if args.category in {"all", item["category"]}]
    results = EvaluationResults(selected)
    # conftest establishes temporary stores and dummy keys before app imports.
    # No application module is imported by this entry point itself.
    code = pytest.main([
        *[str(ROOT / item["test"]) for item in selected],
        "-q", "--tb=short", "-W", "error::RuntimeWarning",
        "-o", "faulthandler_timeout=90", "-o", "junit_family=legacy",
    ], plugins=[results])
    rows = list(results.results.values())
    missing = [item["id"] for item in selected if not any(
        row["id"] == item["id"] for row in rows
    )]
    passed = sum(row["status"] == "passed" for row in rows)
    report = {
        "schema_version": 1, "timestamp": datetime.now(timezone.utc).isoformat(),
        "category": args.category, "attempted": len(rows), "passed": passed,
        "failed": len(rows) - passed, "missing_scenarios": missing,
        "pytest_exit_code": int(code), "results": rows,
        "scope": "Offline orchestration, authorization and fixture retrieval; not model reasoning quality.",
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    lines = ["# Offline evaluation results", "", report["scope"], "",
             f"Attempted: {len(rows)}; passed: {passed}; failed: {len(rows) - passed}.",
             f"Missing scenarios: {len(missing)}; pytest exit: {int(code)}.", "",
             "| Scenario | Case | Status | Failure category |", "| --- | --- | --- | --- |"]
    for row in rows:
        lines.append(f"| {row['id']} | `{row['test']}` | {row['status']} | {row['failure_category']} |")
    for row in rows:
        if row["measurements"]:
            lines.extend([
                "", f"## Measurements: {row['id']}", "", f"Case: `{row['test']}`", "",
                "```json", json.dumps(row["measurements"], indent=2), "```", "",
            ])
    (args.output / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Evaluation reports: {args.output}")
    return 0 if code == 0 and rows and not missing and passed == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
