# entros-mobile

Native mobile verification client for the [Entros Protocol](https://entros.io). The application targets Android and the Solana Mobile ecosystem.

Entros is designed to prove live human control of a returning protocol identity. This client is a devnet implementation, not a mainnet release.

## Current status

The package version is `0.1.0`. The source implements native sensor capture,
private validation, native proving, Mobile Wallet Adapter, and on-chain identity reads.

The feature extractor produces 308 values:

- 170 audio features
- 81 motion features
- 57 touch features

The project still requires physical Seeker testing, release hardening, and Solana Mobile distribution work.

## Verification flow

1. Capture phrase audio, accelerometer, gyroscope, and touch input.
2. Derive the 308-element feature summary on the device.
3. Send the summary and phrase audio to the Entros services for validation.
4. Create a 256-bit SimHash fingerprint and Poseidon commitment.
5. Store the encrypted baseline in device-protected storage.
6. Submit the devnet protocol transaction through Mobile Wallet Adapter.

The first verification submits the new commitment and validator receipt. It does not need a continuity proof.

A re-verification generates a native Groth16 proof. The proof establishes Poseidon openings and `min_distance <= HammingDistance < threshold`.

The circuit does not prove capture provenance or human presence by itself. The private validator applies the current liveness and risk policy.

## Privacy boundary

Raw motion samples and full-resolution touch samples stay in application memory. The client clears them after processing.

Phrase audio leaves the device for transient transcription and acoustic validation. The client also sends derived features and bounded request metadata.

The local baseline contains the fingerprint, salt, commitment, and timestamp. The client encrypts it through device-protected storage.

Protocol transactions persist commitments, proofs on re-verification, and account state. They do not contain raw sensor streams.

The network request implementation lives in `src/services/executor.ts`. Sensor record types live in `src/sensor/types.ts`.

## Stack

- Expo SDK 57 and React Native 0.86.3
- Expo Router and TypeScript strict mode
- `@solana-mobile/mobile-wallet-adapter-protocol-web3js` `^2.2.9`
- `expo-sensors` for accelerometer and gyroscope input
- `react-native-live-audio-stream` for microphone PCM
- `react-native-gesture-handler` for touch capture
- mopro and UniFFI for native Groth16 proving

## Development

Expo Go does not include the required native modules. Use a development client.

```bash
cp .env.example .env
npm install
npm run android
```

Use an Android device or emulator with a devnet-compatible wallet. Physical-device testing is required before release.

iOS can run the interface for compatibility testing. Mobile Wallet Adapter support remains Android-specific in this application.

## Commands

```bash
npm run lint
npm run typecheck
npm test
npm run android
npm run ios
```

## Repository map

```text
app/                  Expo Router screens and verification flow
src/extraction/       Audio, motion, touch, and feature fusion
src/hashing/          SimHash and Poseidon commitment
src/identity/         Encrypted baseline handling
src/proof/            Native proof input and serialization
src/protocol/         Solana accounts, instructions, and submission
src/sensor/           Microphone, motion, and touch capture
src/services/         Executor and validator requests
src/storage/          Device-protected local storage
src/wallet/           Mobile Wallet Adapter integration
```

## Native proof artifacts

The mobile proving artifacts must match `entros-mopro`, the web artifacts, and the deployed verifier.

The `circuits` repository currently contains an unpublished successor generation. Do not update one consumer independently.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Run lint, typecheck, and tests before submitting a change.

## Security

Report vulnerabilities through [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
