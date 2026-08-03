# Contributing to entros-mobile

Thanks for your interest. This document covers the contribution flow and the non-negotiable rules for this repo.

## Getting set up

1. Node 20 (`.nvmrc`).
2. `cp .env.example .env` and fill in values.
3. `npm install`.
4. `npm run start`.

Android emulator or device is required to exercise the wallet flow (Mobile Wallet Adapter is Android-only).

## Pull requests

- Open a PR against `develop`. `main` is the release branch.
- Keep one logical change per PR. Smaller PRs get reviewed sooner.
- The PR description states what changed and how to test it. Use bullet points for the test plan, not checkboxes.
- Commit style and branch naming are yours to choose.

## Required checks

Before opening a PR:

```bash
npm run lint
npm run typecheck
npm test
```

CI runs the same set. Reviewers will not merge a red PR.

## Privacy invariants, non-negotiable

- Raw audio, motion, and touch samples must never be written to disk, transmitted, or logged.
- The 308-feature baseline lives only in `expo-secure-store` (Keychain / Keystore) and is bound to the device. No iCloud / Google Drive sync.
- Wallet auth tokens are stored in `expo-secure-store` only. They never appear in JS bridges, logs, or analytics events.

PRs that violate these will be closed without merge.

## Security

Report vulnerabilities privately per [SECURITY.md](./SECURITY.md). Do not file public issues for security findings.
