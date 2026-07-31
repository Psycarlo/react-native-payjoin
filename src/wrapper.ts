/**
 * Ergonomic wrappers for react-native-payjoin.
 *
 * This file lives outside `generated/` so the uniffi codegen never overwrites
 * it. Everything here is additive: the full generated API is re-exported from
 * `src/index.tsx`, so anything this layer does not cover is still reachable.
 *
 * Planned contents (see the project plan):
 *
 * 1. `PayjoinSender` / `PayjoinReceiver` — collapse the typestate chains and
 *    their `*Transition.save(persister)` steps into a single `run()` call.
 *    The generated API mirrors Rust's typestates faithfully, which means a
 *    caller must not reuse a state object once it has transitioned: the Rust
 *    side does `.take().expect("Already saved or moved")`, so calling `save()`
 *    twice panics rather than throwing a catchable JS error. The same applies
 *    to `ClientResponse` ("moved out of memory"). JS has no move checking, so
 *    this layer owns each state object and never hands a stale one back.
 *
 * 2. Relay transport over `fetch`. `Request { url, contentType, body }` is a
 *    plain HTTPS POST, so it belongs in JS where callers keep control of
 *    timeouts and proxying. Note the upstream warning on
 *    `createV2PostRequest`: a request must NOT be retried by resending the
 *    same bytes, because retransmitting identical ciphertext lets the relay
 *    correlate the retry and weakens OHTTP's privacy properties. Retries must
 *    re-create the request instead.
 *
 * 3. Long-poll loop handling `PollingForProposalTransitionOutcome`: on
 *    `Stasis` the receiver has not answered yet and the enum carries the
 *    session object back out, which must be reassigned before polling again;
 *    on `Progress` the proposal PSBT is ready.
 *
 * 4. `bigint` -> `number` conveniences for satoshi amounts and fee rates.
 *    The generated bindings use `bigint` for all u64/i64 values. JS `number`
 *    is exact to 2^53, which covers the whole 2.1e15 sat supply.
 *
 * OHTTP key fetching is deliberately NOT here: it needs an HTTP CONNECT proxy
 * so the payjoin directory never sees the client IP, which RN's fetch cannot
 * do. It is exported from Rust as `fetchOhttpKeys` instead.
 */

export {};
