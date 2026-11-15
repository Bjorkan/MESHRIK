"""Frozen Python oracle: normal generators must never refresh these artifacts."""

import json

import pytest

from scripts.migration.capture_baseline import BASELINE, capture, first_difference


async def test_frozen_python_baseline(tmp_path):
    await capture(tmp_path)
    assert {path.name for path in BASELINE.glob("*.json")} == {
        path.name for path in tmp_path.glob("*.json")
    }
    for fixture in sorted(BASELINE.glob("*.json")):
        expected = json.loads(fixture.read_text())
        actual = json.loads((tmp_path / fixture.name).read_text())
        difference = first_difference(expected, actual)
        assert difference is None, f"{fixture.name}: {difference}"


@pytest.mark.parametrize(
    ("expected", "actual", "location"),
    [
        ({"status": 202}, {"status": 200}, "$.status (value)"),
        ({"payload": [1]}, {"payload": []}, "$.payload (length)"),
        ({"secret": "fixture-a"}, {"secret": "fixture-b"}, "$.secret (value)"),
        ([None], [False], "$[0] (type)"),
    ],
)
def test_differential_reports_location_without_values(expected, actual, location):
    assert first_difference(expected, actual) == location
