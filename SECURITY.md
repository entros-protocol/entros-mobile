# Security policy

## Reporting

Report security issues privately to **security@entros.io**. Do not file public GitHub issues for vulnerabilities.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept.
- Affected versions / commit SHAs.
- Your preferred contact method for follow-up.

We will acknowledge within 72 hours and provide a timeline for a fix.

## Scope

In scope:

- This repository's source code.
- Native build configuration (Android / iOS) shipped from this repo.
- The runtime behaviour of the Entros mobile app on Solana Mobile devices.

Out of scope:

- The on-chain programs (`protocol-core`) — report to that repo's security policy.
- The `pulse-sdk` package — report to that repo's security policy.
- Third-party wallets connected via Mobile Wallet Adapter.

## Sensitive areas

Particular attention is welcome on:

- Anything that could leak raw biometric capture (audio, motion, touch) off the device.
- Anything that could persist a derived baseline outside `expo-secure-store`.
- Wallet auth token handling.
- Transaction construction — any path that could induce a user to sign an instruction other than the one shown in the UI.

## Disclosure

We follow coordinated disclosure. We will credit reporters in release notes unless asked otherwise.
