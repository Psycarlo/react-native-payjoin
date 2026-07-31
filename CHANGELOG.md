# Changelog

All notable changes to this project are documented in this file.

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
