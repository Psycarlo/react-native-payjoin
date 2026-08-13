# Changelog

All notable changes to this project are documented in this file.

## [0.5.0] - 2026-08-13

Upstream upgrade to the first stable payjoin release. No API changes: the
generated bindings are byte-identical in C++ and carry all 176 uniffi API
checksums unchanged.

### Changed

- Updated `payjoin` to `1.0.0` (`payjoin-ffi 0.24.0` at rev `aa48553`). Between
  `1.0.0-rc.8` and `1.0.0` upstream changed only version numbers and tests.
- `payjoin` now comes from crates.io instead of a git rev, and the
  `[patch.crates-io]` redirect is gone. It existed because `payjoin-ffi` was
  developed against an in-tree `payjoin` with no published counterpart; `1.0.0`
  is published and is exactly what `payjoin-ffi` requests, so wrapper and core
  resolve to one crate instance without a patch.

## [0.4.1] - 2026-08-08

Patch release: fixes an unresolvable import that made 0.4.0 fail to bundle. No
API or upstream changes.

### Fixed

- Metro failed with `Unable to resolve "@ubjs/core"`. Release `0.31.0-3` of
  `uniffi-bindgen-react-native` split its runtime into a separate `@ubjs/core`
  package, which the generated bindings import but `package.json` did not
  declare, so it was never installed. Added as a pinned dependency.

## [0.4.0] - 2026-08-08

Android build fix for consumers on `uniffi-bindgen-react-native 0.31.0-3`. No
API or upstream changes (still `payjoin 1.0.0-rc.8` / `payjoin-ffi 0.24.0` at
rev `e4f5a0b`).

### Fixed

- Android builds failed with `fatal error: 'UniffiCallInvoker.h' file not
  found`. `uniffi-bindgen-react-native 0.31.0-3` added an `exports` map that
  does not expose `./package.json`, so the include-path lookup in the generated
  `android/CMakeLists.txt` threw and silently resolved to `/cpp/includes`. It
  now resolves the `.` export and walks up to the directory containing
  `cpp/includes`, working whether the package is hoisted or nested. Consumers
  pinning `0.31.0-2` were unaffected.

### Changed

- `android/CMakeLists.txt` now fails at CMake configure time, naming the
  resolved path, instead of emitting a broken `-I` flag that surfaces mid-compile.
- `patch-bindings.sh` re-applies both changes after regeneration, via the new
  `scripts/patch-cmake-uniffi-path.js`.

## [0.3.0] - 2026-08-07

### Changed

- Updated `payjoin` to `1.0.0-rc.8` (`payjoin-ffi 0.24.0` at rev `e4f5a0b`).
  No API changes.

## [0.2.0] - 2026-08-01

Minor release: adds fully offline (out-of-band) BIP78 receiver support. Built
against the same upstream as 0.1.x (`payjoin 1.0.0-rc.6` / `payjoin-ffi 0.24.0`
at rev `c23380a`). No breaking changes.

### Added

- `receiverManualContribute` / `receiverManualFinalize` — run a BIP78 receive
  entirely out of band, with no directory, relay, or OHTTP involvement. The
  sender's Original PSBT is imported directly (QR, file, airgap), the receiver
  checks run against caller-supplied ownership data, one input is contributed,
  and the proposal PSBT is handed back the same way. Split into two calls so the
  signing wallet sits between them; the intermediate state is serializable, so
  the flow survives the signing step.

  Previously unreachable: `UncheckedOriginalPayload` is only exposed inside a v2
  session, so an airgapped receiver had no entry point.

- `mergeFinalizedProposalInputs` — copies the receiver's finalized inputs onto a
  cleared proposal PSBT. Needed by any receiver finalize callback, including the
  BIP77 (v2) path, where the callback runs in the host language. Returning the
  wallet-signed PSBT wholesale there reintroduces the sender's finals and yields
  an invalid proposal.

## [0.1.1] - 2026-07-31

Patch release: one protocol-check fix, packaging fixes, smaller binaries,
and a test suite. No API changes. Built against the same upstream as 0.1.0
(`payjoin 1.0.0-rc.6` / `payjoin-ffi 0.24.0` at rev `c23380a`).

### Fixed

- `payjoinReceive` passed `feeRange.minSatPerVb` to the broadcast-suitability
  check unconverted, but that check takes sat/kwu — the minimum fee-rate floor
  on the sender's fallback transaction was 250× more lenient than configured.
  The value is now converted (sat/vB × 250). `runReceiverChecks` itself is
  unchanged: it always took sat/kwu, as documented.
- Android: added `android/gradle.properties` with `Payjoin_*` defaults
  (kotlin, min/target/compileSdk, NDK) so builds no longer NPE when the host
  app doesn't define these in `rootProject.ext`, and fixed a leftover
  `DummyLibForAndroid_kotlinVersion` template reference in `build.gradle`.
- Podspec `:tag` now matches the v-prefixed release tags (`v0.1.1`), enforced
  by `patch-bindings.sh` across regenerations.

### Changed

- Native release builds now use fat LTO, `opt-level = "z"`, a single codegen
  unit, and stripped debuginfo — several MB smaller per ABI. Panics still
  unwind, so uniffi keeps catching them at the FFI boundary.

### Added

- Jest test suite for the wrapper (15 tests): typestate chaining and persist
  points, polling through Stasis, timeout/abort behavior, fee-contribution
  mapping, the receiver check order, and the sat/vB↔sat/kwu conversion.
- Rust tests for the OHTTP key-fetch shim (invalid-URL error path, error
  Display format).
- CI: runs on pushes to main as well as PRs; adds `cargo fmt --check`,
  `cargo clippy -D warnings`, `cargo audit`, and the JS test suite. All
  GitHub Actions are pinned to commit SHAs.

## [0.1.0] - 2026-07-31

Initial alpha release. React Native bindings for the Payjoin Dev Kit
(BIP 77 async payjoin, BIP 78 simple payjoin).

### Added

- React Native / Expo bindings over `payjoin-ffi` via
  `uniffi-bindgen-react-native`, exposing the full upstream API: the v2 sender
  and receiver typestates, `Uri` / `PjUri`, `OhttpKeys`, and the session
  persister callback interfaces.
- `fetchOhttpKeys(ohttpRelay, payjoinDirectory)` — exported from Rust because
  fetching OHTTP keys requires an HTTP `CONNECT` proxy so the payjoin directory
  never sees the client's IP address, which React Native's `fetch` cannot do.
- Ergonomic helpers that drive a whole session — `payjoinSend`,
  `payjoinReceive`, and `createReceiveSession` (split out so a receiver can
  render its BIP21 URI before awaiting a sender). They handle relay transport,
  long-poll `Stasis` handling, and persisting each typestate transition.
- Lower-level building blocks for callers who want their own loop:
  `postRequest`, `pollOnce`, `runReceiverChecks`, and `parsePjUri`. The raw
  generated API is re-exported alongside all of it, so nothing is hidden.
- Swappable HTTP transport. `fetchTransport` is the default; pass any
  `Transport` to route over Tor, add headers, or use another client. Requests
  are never retried by re-sending the same bytes — retransmitting identical
  OHTTP ciphertext lets the relay correlate the retry.
- `sats` / `toSats` helpers, since the generated bindings use `bigint` for every
  u64 value, and `PayjoinTimeoutError` / `PayjoinTransportError`.
- Expo config plugin and prebuilt-binary postinstall.
