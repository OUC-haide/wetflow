#!/usr/bin/env python3
"""Recompute the retained biological evidence-judgment results without API calls."""
import json
import re
from pathlib import Path
ROOT = Path(__file__).resolve().parent
questions = json.loads((ROOT / 'questions.json').read_text())
report = {}
for arm in ['wetflow', 'opencode']:
    rows = []
    for q in questions:
        record = json.loads((ROOT / q['records'][arm]).read_text())
        lines = str(record.get('answer', '')).strip().splitlines()
        match = re.fullmatch(r'(SUPPORT|REFUTE|NEI)', lines[0].strip(), re.I) if lines else None
        label = match.group(1).upper() if match else None
        completed = record.get('completed') is True
        correct = completed and label == q['expectedLabel']
        rows.append({'id': q['id'], 'expected': q['expectedLabel'], 'returned': label,
                     'completed': completed, 'correct': correct, 'record': q['records'][arm]})
    successes = sum(row['correct'] for row in rows)
    failures = sum(not row['completed'] or row['returned'] is None for row in rows)
    report[arm] = {'correct': successes, 'total': len(rows), 'accuracyPercent': round(successes / len(rows) * 100, 1),
                   'executionFailuresOrMissingLabels': failures, 'classificationErrors': len(rows) - successes - failures, 'items': rows}
(ROOT / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
for arm, values in report.items():
    print(f"{arm}: {values['correct']}/{values['total']}; execution failures or missing labels: {values['executionFailuresOrMissingLabels']}")
