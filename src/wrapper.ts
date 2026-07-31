/**
 * Ergonomic helpers for react-native-payjoin.
 *
 * This file lives outside `generated/` so the uniffi codegen never overwrites
 * it, and everything here is **additive**. The full generated API is
 * re-exported from `src/index.tsx`, so any state, method, or escape hatch not
 * covered here is still directly reachable — nothing is hidden or wrapped away.
 *
 * The design goal is to remove the sharp edges of driving a Rust typestate
 * machine from JavaScript, without taking over your wallet, your storage, or
 * your HTTP stack:
 *
 * - **Relay transport is a callback you can replace.** The default uses
 *   `fetch`, but you can pass your own `transport` to route over Tor, add
 *   headers, or use a different client entirely.
 * - **Every step is separately callable.** `payjoinSend` / `payjoinReceive`
 *   drive the whole flow, but `postRequest`, `pollOnce`, and
 *   `runReceiverChecks` are exported too, so you can build your own loop.
 * - **No storage opinion.** You implement the persister interfaces; we never
 *   pick a database for you.
 *
 * See the bottom of this file for the two lower-level building blocks if the
 * one-call helpers don't fit your app.
 */

import {
  InitializedTransitionOutcome_Tags,
  PollingForProposalTransitionOutcome_Tags,
  SenderBuilder,
  Uri,
  type CanBroadcast,
  type InitializedLike,
  type IsInputOwned,
  type IsOutputKnown,
  type IsScriptOwned,
  type JsonReceiverSessionPersister,
  type JsonSenderSessionPersister,
  type OhttpKeysLike,
  type OutPoint,
  type PayjoinProposalLike,
  type PjUriLike,
  type PollingForProposalLike,
  type ProcessPsbt,
  type ProvisionalProposalLike,
  type Request,
  type UncheckedOriginalPayloadLike,
  type WantsFeeRangeLike,
  type WantsInputsLike,
  type WantsOutputsLike,
} from './generated/payjoin';

import { ReceiverBuilder } from './generated/payjoin';

// ═══════════════════════════════════════════════════════════════════════════════
//  Amounts
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The generated bindings use `bigint` for every u64/i64 value. JS `number` is
 * exact up to 2^53, which comfortably covers the entire 2.1e15 satoshi supply,
 * so these two helpers let you stay in `number` at the edges of your app.
 */
export const sats = (n: number): bigint => BigInt(Math.trunc(n));

/** Convert a `bigint` satoshi value back to a `number`. */
export const toSats = (n: bigint): number => Number(n);

// ═══════════════════════════════════════════════════════════════════════════════
//  Relay transport
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sends one payjoin request and returns the raw response body.
 *
 * Payjoin's core library does no IO: it hands you a {@link Request} and expects
 * the bytes back. That makes the transport swappable — supply your own to add
 * Tor, custom TLS, headers, or logging.
 */
export type Transport = (request: Request) => Promise<ArrayBuffer>;

/**
 * Default {@link Transport}, a plain `fetch` POST.
 *
 * ## Why there is no retry here
 *
 * A payjoin v2 request must **not** be retried by re-sending the same bytes.
 * The body is an OHTTP-encapsulated payload, and retransmitting identical
 * ciphertext lets the relay correlate the retry, weakening the privacy
 * properties OHTTP exists to provide. Upstream documents this on
 * `createV2PostRequest`.
 *
 * If a request fails, the correct recovery is to ask the session for a *fresh*
 * request and send that — which is exactly what the polling loop does, since
 * each iteration calls `createPollRequest` again. So this transport
 * deliberately performs exactly one HTTP request and lets errors propagate.
 */
export const fetchTransport =
  (init?: Omit<RequestInit, 'method' | 'body' | 'headers'>): Transport =>
  async (request) => {
    const response = await fetch(request.url, {
      ...init,
      method: 'POST',
      headers: { 'Content-Type': request.contentType },
      body: request.body,
    });

    if (!response.ok) {
      throw new PayjoinTransportError(
        `Payjoin relay responded ${response.status} ${response.statusText}`,
        response.status
      );
    }

    return await response.arrayBuffer();
  };

/** Thrown when the relay returns a non-2xx response. */
export class PayjoinTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'PayjoinTransportError';
  }
}

/** Thrown when a session is still polling after the configured deadline. */
export class PayjoinTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayjoinTimeoutError';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Polling
// ═══════════════════════════════════════════════════════════════════════════════

/** Controls how long, and how often, a session waits for the other party. */
export interface PollOptions {
  /**
   * Wait between poll attempts, in milliseconds. Default 2000.
   *
   * Payjoin v2 long-polls through the directory: the request itself blocks
   * server-side, so a short client-side delay is fine.
   */
  intervalMs?: number;
  /** Give up after this long, in milliseconds. Default 120000 (2 minutes). */
  timeoutMs?: number;
  /** Abort the whole flow early. */
  signal?: AbortSignal;
  /** Called before each poll attempt, 1-based. Useful for UI feedback. */
  onPoll?: (attempt: number) => void;
}

const DEFAULTS = { intervalMs: 2_000, timeoutMs: 120_000 };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PayjoinTimeoutError('Payjoin session aborted');
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PayjoinTimeoutError('Payjoin session aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Sending
// ═══════════════════════════════════════════════════════════════════════════════

/** How much fee the sender is willing to contribute for the receiver's inputs. */
export type FeeContribution =
  /**
   * BIP 78's recommendation: contribute `originalPsbtFeeRate * vsize` of one
   * input. This is the sensible default.
   */
  | { kind: 'recommended'; minFeeRateSatPerKwu?: number }
  /** Cap the contribution explicitly. */
  | {
      kind: 'additionalFee';
      maxFeeContributionSats: number;
      /** Which output pays the fee. Auto-detected when omitted. */
      changeIndex?: number;
      minFeeRateSatPerKwu?: number;
      /** Lower the contribution instead of erroring when change is too small. */
      clampFeeContribution?: boolean;
    }
  /**
   * Contribute nothing. The receiver gets no incentive to add inputs, and
   * upstream notes this may prevent operations like opening LN channels.
   */
  | { kind: 'nonIncentivizing'; minFeeRateSatPerKwu?: number };

export interface SendOptions extends PollOptions {
  /** Base64 PSBT of the original, fully-funded payment. */
  psbt: string;
  /** A payjoin-capable BIP21 URI, or the string to parse into one. */
  uri: string | PjUriLike;
  /** OHTTP relay used to reach the payjoin directory. */
  ohttpRelay: string;
  /** Your session storage. Sessions are resumable, so persist durably. */
  persister: JsonSenderSessionPersister;
  /** Defaults to `{ kind: 'recommended' }`. */
  feeContribution?: FeeContribution;
  /**
   * Forbid the receiver from substituting outputs, even if the URI allows it.
   * Upstream advises against setting this: it can block receiver features and
   * forfeits any fee discount.
   */
  alwaysDisableOutputSubstitution?: boolean;
  /** Replace the HTTP transport. Defaults to {@link fetchTransport}. */
  transport?: Transport;
}

/**
 * Parse a string into a payjoin URI, or pass through an existing one.
 *
 * Throws if the URI is not payjoin-capable, which is the check you want before
 * offering payjoin in your UI.
 */
export function parsePjUri(uri: string | PjUriLike): PjUriLike {
  return typeof uri === 'string' ? Uri.parse(uri).checkPjSupported() : uri;
}

/**
 * Run a full BIP 77 payjoin send and resolve with the receiver's proposal PSBT.
 *
 * You still sign and broadcast the returned PSBT yourself — this drives the
 * protocol, not your wallet.
 *
 * If the receiver never responds, this rejects with {@link PayjoinTimeoutError}
 * and the session remains in your persister, so you can resume it later or
 * fall back to broadcasting the original transaction.
 */
export async function payjoinSend(options: SendOptions): Promise<string> {
  const {
    psbt,
    uri,
    ohttpRelay,
    persister,
    feeContribution = { kind: 'recommended' },
    alwaysDisableOutputSubstitution = false,
    transport = fetchTransport(),
    intervalMs = DEFAULTS.intervalMs,
    timeoutMs = DEFAULTS.timeoutMs,
    signal,
    onPoll,
  } = options;

  throwIfAborted(signal);

  let builder = new SenderBuilder(psbt, parsePjUri(uri));
  if (alwaysDisableOutputSubstitution) {
    builder = builder.alwaysDisableOutputSubstitution() as SenderBuilder;
  }

  const minFeeRate = sats(feeContribution.minFeeRateSatPerKwu ?? 0);
  const initial =
    feeContribution.kind === 'recommended'
      ? builder.buildRecommended(minFeeRate)
      : feeContribution.kind === 'additionalFee'
        ? builder.buildWithAdditionalFee(
            sats(feeContribution.maxFeeContributionSats),
            feeContribution.changeIndex,
            minFeeRate,
            feeContribution.clampFeeContribution ?? false
          )
        : builder.buildNonIncentivizing(minFeeRate);

  // Each transition must be persisted to advance. The returned state object is
  // the only valid handle afterwards — see `postRequest` for why.
  const sender = initial.save(persister);

  // Send the original PSBT to the receiver via the directory.
  const posted = await postRequest(sender.createV2PostRequest(ohttpRelay), transport);
  let poller = sender.processResponse(posted.body, posted.ohttpCtx).save(persister);

  // Long-poll for the receiver's proposal.
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    onPoll?.(attempt);

    const result = await pollOnce(poller, ohttpRelay, persister, transport);
    if (result.done) return result.psbtBase64;

    // Stasis: the receiver has not answered yet. `result.session` is the only
    // usable handle from here on; the previous one has been consumed.
    poller = result.session;

    if (Date.now() >= deadline) {
      throw new PayjoinTimeoutError(
        `No payjoin proposal after ${timeoutMs}ms. The session is persisted and can be resumed, ` +
          `or you can broadcast the original transaction as a fallback.`
      );
    }
    await sleep(intervalMs, signal);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Receiving
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The wallet-side questions the payjoin protocol must ask before it will
 * contribute inputs. These are security checks, not formalities — each one
 * prevents a specific attack, so answer them from authoritative wallet state.
 */
export interface ReceiverCallbacks {
  /**
   * Will the network accept the sender's original transaction? Use a mempool
   * accept test. Guarantees you can fall back if payjoin doesn't complete.
   */
  canBroadcast(tx: ArrayBuffer): boolean;
  /**
   * Do you own this input? Checked by outpoint, because a wallet recognizes
   * and signs its own inputs by outpoint rather than by the PSBT's script.
   * Prevents an attacker from getting you to spend your own inputs.
   */
  isInputOwned(outpoint: OutPoint): boolean;
  /**
   * Have you seen this outpoint in a previous payjoin session? Track them to
   * block probing attacks that replay inputs to discover your UTXOs.
   */
  isOutputKnown(outpoint: OutPoint): boolean;
  /** Is this scriptPubKey one of yours? Identifies your own outputs. */
  isScriptOwned(script: ArrayBuffer): boolean;
}

export interface ReceiveOptions extends PollOptions {
  /** Address to receive at. */
  address: string;
  /** Payjoin directory that stores and forwards payloads. */
  directory: string;
  /** Directory's OHTTP keys — see `fetchOhttpKeys`. */
  ohttpKeys: OhttpKeysLike;
  /** OHTTP relay used to reach the directory. */
  ohttpRelay: string;
  /** Your session storage. */
  persister: JsonReceiverSessionPersister;
  /** Wallet-side security checks. */
  callbacks: ReceiverCallbacks;
  /** Sign the proposal PSBT. Return the signed base64 PSBT. */
  processPsbt: ProcessPsbt['callback'];
  /** Expected amount in satoshis. */
  amountSats?: number;
  /** Session expiry in seconds. */
  expirationSecs?: number;
  /** Reject proposals above this effective fee rate (sat/vB). */
  maxFeeRateSatPerVb?: number;
  /** Fee range applied before finalizing. */
  feeRange?: { minSatPerVb?: number; maxEffectiveSatPerVb?: number };
  /**
   * Contribute inputs and/or rewrite outputs. Omit to accept the proposal
   * as-is, which is the common case for a simple receive.
   */
  contribute?: (
    wantsOutputs: WantsOutputsLike
  ) => WantsOutputsLike | WantsInputsLike | Promise<WantsOutputsLike | WantsInputsLike>;
  /** Replace the HTTP transport. Defaults to {@link fetchTransport}. */
  transport?: Transport;
}

/** A completed receive: the proposal you sent back, plus its PSBT. */
export interface ReceiveResult {
  proposal: PayjoinProposalLike;
  psbt: string;
}

/**
 * Create a receive session and return it together with the BIP21 URI to show
 * the sender.
 *
 * Split out from {@link payjoinReceive} because you need the URI *before* the
 * sender does anything — render it as a QR code, then await the returned
 * `session` when you're ready to wait for a payment.
 */
export function createReceiveSession(options: {
  address: string;
  directory: string;
  ohttpKeys: OhttpKeysLike;
  persister: JsonReceiverSessionPersister;
  amountSats?: number;
  expirationSecs?: number;
  maxFeeRateSatPerVb?: number;
}): { session: InitializedLike; uri: string } {
  let builder = new ReceiverBuilder(
    options.address,
    options.directory,
    options.ohttpKeys
  ) as ReceiverBuilder;

  if (options.amountSats !== undefined) {
    builder = builder.withAmount(sats(options.amountSats)) as ReceiverBuilder;
  }
  if (options.expirationSecs !== undefined) {
    builder = builder.withExpiration(sats(options.expirationSecs)) as ReceiverBuilder;
  }
  if (options.maxFeeRateSatPerVb !== undefined) {
    builder = builder.withMaxFeeRate(sats(options.maxFeeRateSatPerVb)) as ReceiverBuilder;
  }

  const session = builder.build().save(options.persister);
  return { session, uri: session.pjUri().asString() };
}

/**
 * Run a full BIP 77 payjoin receive.
 *
 * Waits for a sender, runs every protocol check against your callbacks,
 * optionally contributes inputs, has you sign, and posts the proposal back.
 *
 * For QR-code flows, call {@link createReceiveSession} first so you can render
 * the URI, then pass the resulting session in as `session`.
 */
export async function payjoinReceive(
  options: ReceiveOptions & { session?: InitializedLike }
): Promise<ReceiveResult> {
  const {
    ohttpRelay,
    persister,
    callbacks,
    processPsbt,
    contribute,
    feeRange,
    transport = fetchTransport(),
    intervalMs = DEFAULTS.intervalMs,
    timeoutMs = DEFAULTS.timeoutMs,
    signal,
    onPoll,
  } = options;

  throwIfAborted(signal);

  let session = options.session ?? createReceiveSession(options).session;

  // Wait for a sender to post an original PSBT.
  const deadline = Date.now() + timeoutMs;
  let unchecked;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    onPoll?.(attempt);

    const { request, clientResponse } = session.createPollRequest(ohttpRelay);
    const body = await transport(request);
    const outcome = session.processResponse(body, clientResponse).save(persister);

    if (outcome.tag === InitializedTransitionOutcome_Tags.Progress) {
      unchecked = outcome.inner.inner;
      break;
    }

    // Stasis: no sender yet. Only the returned handle is usable.
    session = outcome.inner.inner;

    if (Date.now() >= deadline) {
      throw new PayjoinTimeoutError(
        `No payjoin sender after ${timeoutMs}ms. The session is persisted and can be resumed.`
      );
    }
    await sleep(intervalMs, signal);
  }

  // Run the mandatory protocol checks in order. `checkBroadcastSuitability`
  // takes sat/kwu while our options use sat/vB (1 vB = 4 WU, 1 kwu = 1000 WU,
  // so sat/kwu = sat/vB ÷ 4 × 1000 = sat/vB × 250).
  const wantsOutputs = runReceiverChecks(unchecked, persister, callbacks, {
    minFeeRateSatPerKwu:
      options.feeRange?.minSatPerVb === undefined
        ? undefined
        : options.feeRange.minSatPerVb * 250,
  });

  // Optionally contribute inputs / rewrite outputs, then commit both stages.
  const contributed = contribute ? await contribute(wantsOutputs) : wantsOutputs;
  const wantsInputs: WantsInputsLike = isWantsOutputs(contributed)
    ? contributed.commitOutputs().save(persister)
    : contributed;
  const wantsFeeRange: WantsFeeRangeLike = wantsInputs.commitInputs().save(persister);

  const provisional: ProvisionalProposalLike = wantsFeeRange
    .applyFeeRange(
      feeRange?.minSatPerVb === undefined ? undefined : sats(feeRange.minSatPerVb),
      feeRange?.maxEffectiveSatPerVb === undefined
        ? undefined
        : sats(feeRange.maxEffectiveSatPerVb)
    )
    .save(persister);

  // Sign, then post the proposal back to the sender.
  const proposal = provisional.finalizeProposal({ callback: processPsbt }).save(persister);

  const { request, clientResponse } = proposal.createPostRequest(ohttpRelay);
  const body = await transport(request);
  proposal.processResponse(body, clientResponse).save(persister);

  return { proposal, psbt: proposal.psbt() };
}

/**
 * Run the four mandatory receiver checks and return the `WantsOutputs` state.
 *
 * Exported so you can drive the chain yourself while still getting the checks
 * in the right order — the order is protocol-significant, not stylistic.
 */
export function runReceiverChecks(
  unchecked: UncheckedOriginalPayloadLike,
  persister: JsonReceiverSessionPersister,
  callbacks: ReceiverCallbacks,
  opts?: { minFeeRateSatPerKwu?: number }
): WantsOutputsLike {
  const canBroadcast: CanBroadcast = { callback: callbacks.canBroadcast };
  const isInputOwned: IsInputOwned = { callback: callbacks.isInputOwned };
  const isOutputKnown: IsOutputKnown = { callback: callbacks.isOutputKnown };
  const isScriptOwned: IsScriptOwned = { callback: callbacks.isScriptOwned };

  // 1. The original transaction must be broadcastable, so a fallback exists.
  const maybeInputsOwned = unchecked
    .checkBroadcastSuitability(
      opts?.minFeeRateSatPerKwu === undefined ? undefined : sats(opts.minFeeRateSatPerKwu),
      canBroadcast
    )
    .save(persister);

  // 2. None of the sender's inputs may be ours.
  const maybeInputsSeen = maybeInputsOwned.checkInputsNotOwned(isInputOwned).save(persister);

  // 3. No input may have been seen in a previous session (anti-probing).
  const outputsUnknown = maybeInputsSeen.checkNoInputsSeenBefore(isOutputKnown).save(persister);

  // 4. Identify which outputs are ours.
  return outputsUnknown.identifyReceiverOutputs(isScriptOwned).save(persister);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Lower-level building blocks
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send one request and return the body alongside its OHTTP context.
 *
 * The context is single-use: the Rust side takes it out of a `Mutex<Option<_>>`
 * on first use, so passing the same one to `processResponse` twice panics. Feed
 * each context to exactly one `processResponse` call.
 */
export async function postRequest<Ctx>(
  { request, ohttpCtx }: { request: Request; ohttpCtx: Ctx },
  transport: Transport
): Promise<{ body: ArrayBuffer; ohttpCtx: Ctx }> {
  return { body: await transport(request), ohttpCtx };
}

/**
 * Poll once for the receiver's proposal.
 *
 * Returns either the proposal PSBT, or the session to poll again with. Note the
 * returned session — a typestate transition consumes the previous handle, and
 * reusing a consumed one panics in Rust (`Already saved or moved`) rather than
 * throwing a catchable JS error. Always continue with what you get back.
 */
export async function pollOnce(
  session: PollingForProposalLike,
  ohttpRelay: string,
  persister: JsonSenderSessionPersister,
  transport: Transport = fetchTransport()
): Promise<
  { done: true; psbtBase64: string } | { done: false; session: PollingForProposalLike }
> {
  const posted = await postRequest(session.createPollRequest(ohttpRelay), transport);
  const outcome = session.processResponse(posted.body, posted.ohttpCtx).save(persister);

  return outcome.tag === PollingForProposalTransitionOutcome_Tags.Progress
    ? { done: true, psbtBase64: outcome.inner.psbtBase64 }
    : { done: false, session: outcome.inner.inner };
}

// -- internal helpers ---------------------------------------------------------

function isWantsOutputs(
  state: WantsOutputsLike | WantsInputsLike
): state is WantsOutputsLike {
  return typeof (state as WantsOutputsLike).commitOutputs === 'function';
}
