# Security

## Supported version

Security fixes currently target the latest commit on `main`.

## Reporting a vulnerability

Contact the distributor through a private channel. Do not include API keys, private experimental records, database files, or other sensitive material in public messages.

Include the affected version, reproduction steps, expected impact, and a minimal sanitized example. Allow maintainers time to investigate before public disclosure.

## Local data

WetFlow stores runtime state, model settings, conversation memory, and imported evidence under `.wetflow/` by default. That directory and `.env` are excluded from Git. Before sharing logs or archives, verify that they do not contain experiment data or credentials.
