# Biological evidence-judgment example

This historical development benchmark contains four synthetic documents, 30 claims and gold labels, saved outputs for WetFlow and OpenCode, and the three clarified questions rerun for both systems. The final score uses 27 original records plus the clarified A-02, A-03 and A-13 records for each system. All 66 selected original/rerun records are retained. Each record includes the exact submitted prompt; the changed scope is visible by comparing the original and clarified prompts.

Run `python3 score.py` from this directory to recompute labels, accuracy, classification errors and execution failures without any model calls. The script writes `results.json`. Missing labels and failed runs count as incorrect in the denominator of 30. Expected results: WetFlow 28/30, OpenCode 21/30; execution failures 0 and 6.

The records preserve historical execution limits and model identifiers where recorded. The systems used different native tools and execution paths. The retained data do not establish a matched thinking mode, a complete historical source binding or a controlled architectural advantage. This example does not rerun a model or measure the current release. Input documents are synthetic fixtures, not the team's wet-lab measurements.
