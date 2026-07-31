/**
 * Unit tests for the ergonomic wrapper.
 *
 * The generated bindings are mocked wholesale: these tests verify the
 * protocol-driving logic in wrapper.ts (state chaining, persistence points,
 * polling, timeouts, unit conversions) — not the Rust FFI itself.
 */

import {
  PayjoinTimeoutError,
  PayjoinTransportError,
  createReceiveSession,
  fetchTransport,
  parsePjUri,
  payjoinReceive,
  payjoinSend,
  pollOnce,
  runReceiverChecks,
  sats,
  toSats,
  type ReceiverCallbacks,
} from '../wrapper';

import { ReceiverBuilder, SenderBuilder, Uri } from '../generated/payjoin';

jest.mock('../generated/payjoin', () => ({
  SenderBuilder: jest.fn(),
  ReceiverBuilder: jest.fn(),
  Uri: { parse: jest.fn() },
  InitializedTransitionOutcome_Tags: { Progress: 'Progress', Stasis: 'Stasis' },
  PollingForProposalTransitionOutcome_Tags: {
    Progress: 'Progress',
    Stasis: 'Stasis',
  },
}));

const SenderBuilderMock = SenderBuilder as unknown as jest.Mock;
const ReceiverBuilderMock = ReceiverBuilder as unknown as jest.Mock;
const UriParseMock = Uri.parse as unknown as jest.Mock;

/** A typestate transition: `.save(persister)` returns the next state. */
const saveable = <T>(next: T) => ({ save: jest.fn(() => next) });

const makePersister = () => ({
  save: jest.fn(),
  load: jest.fn(() => [] as string[]),
  close: jest.fn(),
});

const request = (url = 'https://relay.example') => ({
  url,
  contentType: 'message/ohttp-req',
  body: new ArrayBuffer(4),
});

/** Fake PjUri object so `parsePjUri` passes it through untouched. */
const fakePjUri = { asString: () => 'bitcoin:addr?pj=https://dir' } as any;

const okTransport = jest.fn(async () => new ArrayBuffer(8));

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── amounts ───────────────────────────────────────────────────────────────

describe('sats / toSats', () => {
  it('round-trips and truncates fractions', () => {
    expect(sats(1234)).toBe(1234n);
    expect(sats(12.9)).toBe(12n);
    expect(toSats(21_000_000n)).toBe(21_000_000);
  });
});

// ─── transport ─────────────────────────────────────────────────────────────

describe('fetchTransport', () => {
  it('POSTs the request body with its content type and returns the response', async () => {
    const body = new ArrayBuffer(3);
    const fetchMock = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => body,
    }));
    (global as any).fetch = fetchMock;

    const result = await fetchTransport()(request('https://r.example'));

    expect(result).toBe(body);
    expect(fetchMock).toHaveBeenCalledWith('https://r.example', {
      method: 'POST',
      headers: { 'Content-Type': 'message/ohttp-req' },
      body: expect.any(ArrayBuffer),
    });
  });

  it('throws PayjoinTransportError with the status on non-2xx', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
    }));

    await expect(fetchTransport()(request())).rejects.toThrow(
      PayjoinTransportError
    );
    await expect(fetchTransport()(request())).rejects.toMatchObject({
      status: 502,
    });
  });
});

// ─── uri ───────────────────────────────────────────────────────────────────

describe('parsePjUri', () => {
  it('parses strings and requires payjoin support', () => {
    const pjUri = { pj: true };
    const parsed = { checkPjSupported: jest.fn(() => pjUri) };
    UriParseMock.mockReturnValue(parsed);

    expect(parsePjUri('bitcoin:addr?pj=x')).toBe(pjUri);
    expect(UriParseMock).toHaveBeenCalledWith('bitcoin:addr?pj=x');
    expect(parsed.checkPjSupported).toHaveBeenCalled();
  });

  it('passes an existing PjUri through without re-parsing', () => {
    expect(parsePjUri(fakePjUri)).toBe(fakePjUri);
    expect(UriParseMock).not.toHaveBeenCalled();
  });
});

// ─── sending ───────────────────────────────────────────────────────────────

/**
 * Builds the full fake sender chain. `outcomes` is consumed one per poll:
 * 'stasis' yields a fresh poller, 'progress' resolves with `psbt`.
 */
function mockSenderChain(outcomes: Array<'stasis' | 'progress'>, psbt: string) {
  const makePoller = (remaining: Array<'stasis' | 'progress'>): any => ({
    createPollRequest: jest.fn(() => ({
      request: request(),
      ohttpCtx: `poll-ctx-${remaining.length}`,
    })),
    processResponse: jest.fn(() =>
      saveable(
        remaining[0] === 'progress'
          ? { tag: 'Progress', inner: { psbtBase64: psbt } }
          : { tag: 'Stasis', inner: { inner: makePoller(remaining.slice(1)) } }
      )
    ),
  });

  const sender = {
    createV2PostRequest: jest.fn(() => ({
      request: request(),
      ohttpCtx: 'post-ctx',
    })),
    processResponse: jest.fn(() => saveable(makePoller(outcomes))),
  };

  const builder = {
    alwaysDisableOutputSubstitution: jest.fn(),
    buildRecommended: jest.fn(() => saveable(sender)),
    buildWithAdditionalFee: jest.fn(() => saveable(sender)),
    buildNonIncentivizing: jest.fn(() => saveable(sender)),
  };
  builder.alwaysDisableOutputSubstitution.mockReturnValue(builder);
  SenderBuilderMock.mockImplementation(() => builder);

  return { builder, sender };
}

describe('payjoinSend', () => {
  it('posts the original PSBT, polls through stasis, and resolves the proposal', async () => {
    const { builder, sender } = mockSenderChain(['stasis', 'progress'], 'psbt-final');
    const persister = makePersister();
    const onPoll = jest.fn();

    const result = await payjoinSend({
      psbt: 'orig-psbt',
      uri: fakePjUri,
      ohttpRelay: 'https://relay.example',
      persister: persister as any,
      transport: okTransport,
      intervalMs: 1,
      onPoll,
    });

    expect(result).toBe('psbt-final');
    expect(SenderBuilderMock).toHaveBeenCalledWith('orig-psbt', fakePjUri);
    // Default fee contribution is `recommended` with a zero min fee rate.
    expect(builder.buildRecommended).toHaveBeenCalledWith(0n);
    expect(builder.alwaysDisableOutputSubstitution).not.toHaveBeenCalled();
    expect(sender.createV2PostRequest).toHaveBeenCalledWith('https://relay.example');
    // One POST + two polls.
    expect(okTransport).toHaveBeenCalledTimes(3);
    expect(onPoll).toHaveBeenNthCalledWith(1, 1);
    expect(onPoll).toHaveBeenNthCalledWith(2, 2);
  });

  it('maps the additionalFee contribution options onto the builder', async () => {
    const { builder } = mockSenderChain(['progress'], 'psbt');
    await payjoinSend({
      psbt: 'p',
      uri: fakePjUri,
      ohttpRelay: 'r',
      persister: makePersister() as any,
      transport: okTransport,
      feeContribution: {
        kind: 'additionalFee',
        maxFeeContributionSats: 1000,
        changeIndex: 1,
        minFeeRateSatPerKwu: 250,
        clampFeeContribution: true,
      },
      alwaysDisableOutputSubstitution: true,
    });

    expect(builder.alwaysDisableOutputSubstitution).toHaveBeenCalled();
    expect(builder.buildWithAdditionalFee).toHaveBeenCalledWith(1000n, 1, 250n, true);
  });

  it('throws PayjoinTimeoutError when the receiver never responds, after persisting', async () => {
    mockSenderChain(['stasis', 'stasis', 'stasis'], 'unused');
    await expect(
      payjoinSend({
        psbt: 'p',
        uri: fakePjUri,
        ohttpRelay: 'r',
        persister: makePersister() as any,
        transport: okTransport,
        timeoutMs: 0,
      })
    ).rejects.toThrow(PayjoinTimeoutError);
  });

  it('rejects immediately on an already-aborted signal', async () => {
    mockSenderChain(['progress'], 'unused');
    const controller = new AbortController();
    controller.abort();

    await expect(
      payjoinSend({
        psbt: 'p',
        uri: fakePjUri,
        ohttpRelay: 'r',
        persister: makePersister() as any,
        transport: okTransport,
        signal: controller.signal,
      })
    ).rejects.toThrow('Payjoin session aborted');
    expect(SenderBuilderMock).not.toHaveBeenCalled();
  });
});

describe('pollOnce', () => {
  it('returns the PSBT on progress and the next session on stasis', async () => {
    const persister = makePersister();
    const next = { next: true };
    const stasisSession: any = {
      createPollRequest: jest.fn(() => ({ request: request(), ohttpCtx: 'c' })),
      processResponse: jest.fn(() =>
        saveable({ tag: 'Stasis', inner: { inner: next } })
      ),
    };
    const progressSession: any = {
      createPollRequest: jest.fn(() => ({ request: request(), ohttpCtx: 'c' })),
      processResponse: jest.fn(() =>
        saveable({ tag: 'Progress', inner: { psbtBase64: 'done-psbt' } })
      ),
    };

    await expect(
      pollOnce(stasisSession, 'r', persister as any, okTransport)
    ).resolves.toEqual({ done: false, session: next });
    await expect(
      pollOnce(progressSession, 'r', persister as any, okTransport)
    ).resolves.toEqual({ done: true, psbtBase64: 'done-psbt' });
  });
});

// ─── receiving ─────────────────────────────────────────────────────────────

/** Fake receiver typestate chain from UncheckedOriginalPayload onwards. */
function mockReceiverChain() {
  const calls: string[] = [];

  const proposal = {
    createPostRequest: jest.fn(() => ({ request: request(), clientResponse: 'cr2' })),
    processResponse: jest.fn(() => saveable(undefined)),
    psbt: jest.fn(() => 'final-psbt'),
  };
  const provisional = {
    finalizeProposal: jest.fn(() => {
      calls.push('finalizeProposal');
      return saveable(proposal);
    }),
  };
  const wantsFeeRange = {
    applyFeeRange: jest.fn(() => {
      calls.push('applyFeeRange');
      return saveable(provisional);
    }),
  };
  // Deliberately has no commitOutputs — that's how isWantsOutputs dispatches.
  const wantsInputs = {
    commitInputs: jest.fn(() => {
      calls.push('commitInputs');
      return saveable(wantsFeeRange);
    }),
  };
  const wantsOutputs = {
    commitOutputs: jest.fn(() => {
      calls.push('commitOutputs');
      return saveable(wantsInputs);
    }),
  };
  const outputsUnknown = {
    identifyReceiverOutputs: jest.fn(() => {
      calls.push('identifyReceiverOutputs');
      return saveable(wantsOutputs);
    }),
  };
  const maybeInputsSeen = {
    checkNoInputsSeenBefore: jest.fn(() => {
      calls.push('checkNoInputsSeenBefore');
      return saveable(outputsUnknown);
    }),
  };
  const maybeInputsOwned = {
    checkInputsNotOwned: jest.fn(() => {
      calls.push('checkInputsNotOwned');
      return saveable(maybeInputsSeen);
    }),
  };
  const unchecked = {
    checkBroadcastSuitability: jest.fn(() => {
      calls.push('checkBroadcastSuitability');
      return saveable(maybeInputsOwned);
    }),
  };

  return {
    calls,
    unchecked,
    maybeInputsOwned,
    wantsOutputs,
    wantsInputs,
    wantsFeeRange,
    provisional,
    proposal,
  };
}

const receiverCallbacks: ReceiverCallbacks = {
  canBroadcast: () => true,
  isInputOwned: () => false,
  isOutputKnown: () => false,
  isScriptOwned: () => true,
};

describe('runReceiverChecks', () => {
  it('runs the four protocol checks in order, persisting each transition', () => {
    const chain = mockReceiverChain();
    const persister = makePersister();

    const result = runReceiverChecks(
      chain.unchecked as any,
      persister as any,
      receiverCallbacks
    );

    expect(chain.calls).toEqual([
      'checkBroadcastSuitability',
      'checkInputsNotOwned',
      'checkNoInputsSeenBefore',
      'identifyReceiverOutputs',
    ]);
    expect(result).toBe(chain.wantsOutputs);
    // Callbacks are wrapped into the uniffi `{ callback }` shape.
    const [minRate, canBroadcast] = chain.unchecked.checkBroadcastSuitability
      .mock.calls[0] as unknown as [unknown, unknown];
    expect(minRate).toBeUndefined();
    expect((canBroadcast as any).callback).toBe(receiverCallbacks.canBroadcast);
  });
});

describe('payjoinReceive', () => {
  const makeSession = (outcomeFactory: () => any): any => ({
    createPollRequest: jest.fn(() => ({ request: request(), clientResponse: 'cr' })),
    processResponse: jest.fn(() => saveable(outcomeFactory())),
  });

  it('converts feeRange sat/vB into sat/kwu for the broadcast check but keeps sat/vB for applyFeeRange', async () => {
    const chain = mockReceiverChain();
    const session = makeSession(() => ({
      tag: 'Progress',
      inner: { inner: chain.unchecked },
    }));

    const processPsbt = jest.fn((psbt: string) => psbt);
    const result = await payjoinReceive({
      session,
      address: 'addr',
      directory: 'https://dir',
      ohttpKeys: {} as any,
      ohttpRelay: 'https://relay.example',
      persister: makePersister() as any,
      callbacks: receiverCallbacks,
      processPsbt,
      transport: okTransport,
      feeRange: { minSatPerVb: 10, maxEffectiveSatPerVb: 50 },
    });

    // 10 sat/vB = 2500 sat/kwu (1 vB = 4 WU, 1 kwu = 1000 WU).
    expect(chain.unchecked.checkBroadcastSuitability).toHaveBeenCalledWith(
      2500n,
      expect.anything()
    );
    // applyFeeRange takes sat/vB directly.
    expect(chain.wantsFeeRange.applyFeeRange).toHaveBeenCalledWith(10n, 50n);
    expect(result.psbt).toBe('final-psbt');
    expect(result.proposal).toBe(chain.proposal);
    // No contribute callback: proposal accepted as-is via commitOutputs.
    expect(chain.calls).toContain('commitOutputs');
    expect(chain.calls).toContain('commitInputs');
    // The signing callback is handed to finalizeProposal in the uniffi shape.
    const [processArg] = chain.provisional.finalizeProposal.mock
      .calls[0] as unknown as [{ callback: unknown }];
    expect(processArg.callback).toBe(processPsbt);
  });

  it('skips commitOutputs when contribute already returned a WantsInputs state', async () => {
    const chain = mockReceiverChain();
    const session = makeSession(() => ({
      tag: 'Progress',
      inner: { inner: chain.unchecked },
    }));

    await payjoinReceive({
      session,
      address: 'addr',
      directory: 'd',
      ohttpKeys: {} as any,
      ohttpRelay: 'r',
      persister: makePersister() as any,
      callbacks: receiverCallbacks,
      processPsbt: (psbt: string) => psbt,
      transport: okTransport,
      contribute: () => chain.wantsInputs as any,
    });

    expect(chain.wantsOutputs.commitOutputs).not.toHaveBeenCalled();
    expect(chain.wantsInputs.commitInputs).toHaveBeenCalled();
  });

  it('throws PayjoinTimeoutError when no sender arrives before the deadline', async () => {
    const session = makeSession(() => ({
      tag: 'Stasis',
      inner: {
        inner: makeSession(() => ({ tag: 'Stasis', inner: { inner: null } })),
      },
    }));

    await expect(
      payjoinReceive({
        session,
        address: 'addr',
        directory: 'd',
        ohttpKeys: {} as any,
        ohttpRelay: 'r',
        persister: makePersister() as any,
        callbacks: receiverCallbacks,
        processPsbt: (psbt: string) => psbt,
        transport: okTransport,
        timeoutMs: 0,
      })
    ).rejects.toThrow(PayjoinTimeoutError);
  });
});

describe('createReceiveSession', () => {
  it('applies amount, expiration and max fee rate, then returns session + URI', () => {
    const session = {
      pjUri: jest.fn(() => ({ asString: () => 'bitcoin:addr?pj=https://dir' })),
    };
    const builder: any = {
      withAmount: jest.fn(),
      withExpiration: jest.fn(),
      withMaxFeeRate: jest.fn(),
      build: jest.fn(() => saveable(session)),
    };
    builder.withAmount.mockReturnValue(builder);
    builder.withExpiration.mockReturnValue(builder);
    builder.withMaxFeeRate.mockReturnValue(builder);
    ReceiverBuilderMock.mockImplementation(() => builder);

    const persister = makePersister();
    const result = createReceiveSession({
      address: 'addr',
      directory: 'https://dir',
      ohttpKeys: {} as any,
      persister: persister as any,
      amountSats: 1000,
      expirationSecs: 600,
      maxFeeRateSatPerVb: 2,
    });

    expect(ReceiverBuilderMock).toHaveBeenCalledWith('addr', 'https://dir', {});
    expect(builder.withAmount).toHaveBeenCalledWith(1000n);
    expect(builder.withExpiration).toHaveBeenCalledWith(600n);
    expect(builder.withMaxFeeRate).toHaveBeenCalledWith(2n);
    expect(result.session).toBe(session);
    expect(result.uri).toBe('bitcoin:addr?pj=https://dir');
  });
});
