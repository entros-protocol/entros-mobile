# Contributing to entros-mobile

Thanks for your interest. This document covers the contribution flow and the non-negotiable rules for this repo.

## Getting set up

1. Install Node 24.19.0 from `.nvmrc`.
2. `cp .env.example .env` and fill in values.
3. `npm ci`.
4. `npm run start`.

Android emulator or device is required to exercise the wallet flow (Mobile Wallet Adapter is Android-only).

## Pull requests

- Open a PR against `develop`. `main` is the release branch.
- Keep one logical change per PR. Smaller PRs get reviewed sooner.
- The PR description states what changed and how to test it. Use bullet points for the test plan, not checkboxes.
- Follow the repository commit and branch conventions.

## Required checks

Before opening a PR:

```bash
npm run lint
npm run typecheck
npm test
```

CI runs the same set. Reviewers will not merge a red PR.

## Privacy invariants, non-negotiable

- Raw motion and full-resolution touch samples must never be written, transmitted, or logged.
- Phrase audio may leave the device only for transient transcription and acoustic validation. Never persist or log it.
- The 308-feature summary may reach validation. Keep it transient and never write it to local storage.
- The continuity baseline contains the fingerprint, salt, commitment, timestamp, and projection version.
- Encrypt the continuity baseline before storing it in `expo-secure-store`. Keep this native client device-bound.
- Wallet auth tokens use `expo-secure-store` at rest. Never log them or send them to analytics.

PRs that violate these will be closed without merge.

## Security

Report vulnerabilities privately per [SECURITY.md](./SECURITY.md). Do not file public issues for security findings.
