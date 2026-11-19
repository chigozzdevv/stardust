import { Asset, Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { xlm } from '@/amounts';
import { declined, internalError } from '@/wallet/prompts';
import { nativeSac } from '@tests/helpers/envelopes';
import { sacInstance, wasmInstance } from '@tests/helpers/ledger';
import { isPending } from '@tests/helpers/prompt-queue';
import { varial } from '@tests/helpers/varial';

const plainToken = StrKey.encodeContract(Buffer.alloc(32, 7));
const usdc = new Asset('USDC', Keypair.random().publicKey());
const usdcSac = usdc.contractId(Networks.TESTNET);

describe('SUBMIT_TOKEN', () => {
  const onTestnet = { networkPassphrase: Networks.TESTNET };

  it('adds a plain token without sending anything', async () => {
    const { ask, ledger, queue } = varial({ connected: true });
    ledger.store(wasmInstance(plainToken));
    const reply = ask('SUBMIT_TOKEN', { contractId: plainToken, ...onTestnet });
    const prompt = await queue.nextPrompt('addToken');
    expect(prompt).toMatchObject({
      contractId: plainToken,
      networkPassphrase: Networks.TESTNET,
      blocked: null,
    });
    await prompt.approve();
    await expect(reply).resolves.toEqual({ contractId: plainToken });
    expect(ledger.transactions).toEqual([]);
  });

  it('adds a trustline for a Stellar Asset Contract before replying', async () => {
    const { ask, ledger, state, queue } = varial({
      connected: true,
      policy: 'approve',
    });
    ledger.accounts.set(state.address, { balance: xlm('100'), sequence: 100n });
    ledger.store(sacInstance(usdcSac, usdc.toString()));
    const request = { contractId: usdcSac, ...onTestnet };

    await expect(ask('SUBMIT_TOKEN', request)).resolves.toEqual({
      contractId: usdcSac,
    });
    expect(ledger.transactions).toHaveLength(1);
    expect(ledger.transactions[0]?.source).toBe(state.address);
    expect(ledger.transactions[0]?.operations).toMatchObject([
      { type: 'changeTrust' },
    ]);

    await expect(ask('SUBMIT_TOKEN', request)).resolves.toEqual({
      apiError: declined,
    });
    expect(queue.prompts().map(({ blocked }) => blocked)).toEqual([
      null,
      'alreadyAdded',
    ]);
  });

  it('shows native XLM as already added', async () => {
    const { ask, ledger, queue } = varial({ connected: true });
    ledger.store(sacInstance(nativeSac, 'native'));
    const reply = ask('SUBMIT_TOKEN', { contractId: nativeSac, ...onTestnet });
    const prompt = await queue.nextPrompt('addToken');
    expect(prompt.blocked).toBe('alreadyAdded');
    await expect(prompt.approve()).rejects.toMatchObject({
      code: 'PROMPT_BLOCKED',
    });
    await prompt.reject();
    await expect(reply).resolves.toEqual({ apiError: declined });
  });

  it('reads a token without networkPassphrase as mainnet, without looking it up', async () => {
    const { ask, queue, violations } = varial({
      connected: true,
      policy: 'approve',
      send: () => Promise.reject(new TypeError('no lookups in this test')),
    });
    await expect(ask('SUBMIT_TOKEN', { contractId: usdcSac })).resolves.toEqual(
      { apiError: declined },
    );
    expect(queue.prompts()).toMatchObject([{ blocked: 'networkMismatch' }]);
    expect(violations.list()).toMatchObject([
      {
        promptId: 'p1',
        kind: 'missingNetworkPassphrase',
        detail: expect.stringMatching(/^The app sent addToken without/),
      },
    ]);
  });

  it('needs a connected site, as the Add button does', async () => {
    const { ask, ledger, queue } = varial({ policy: 'approve' });
    ledger.store(wasmInstance(plainToken));
    await expect(
      ask('SUBMIT_TOKEN', { contractId: plainToken, ...onTestnet }),
    ).resolves.toEqual({ apiError: declined });
    expect(queue.prompts()).toMatchObject([{ blocked: 'notConnected' }]);
  });

  it("answers a contract ID that isn't one with Declined and no prompt", async () => {
    const { ask, queue } = varial({ connected: true });
    await expect(
      ask('SUBMIT_TOKEN', { contractId: 'USDC', ...onTestnet }),
    ).resolves.toEqual({ apiError: declined });
    expect(queue.prompts()).toEqual([]);
  });

  it('answers the internal error when the token lookup fails', async () => {
    const { ask, queue } = varial({
      connected: true,
      send: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(
      ask('SUBMIT_TOKEN', { contractId: usdcSac, ...onTestnet }),
    ).resolves.toEqual({ apiError: internalError });
    expect(queue.prompts()).toEqual([]);
    expect(queue.errors()).toHaveLength(1);
  });

  it('replies Declined and fails approve() when the trustline fails', async () => {
    const { ask, ledger, queue } = varial({ connected: true });
    ledger.store(sacInstance(usdcSac, usdc.toString()));
    const reply = ask('SUBMIT_TOKEN', { contractId: usdcSac, ...onTestnet });
    const prompt = await queue.nextPrompt('addToken');
    await expect(prompt.approve()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(reply).resolves.toEqual({ apiError: declined });
  });

  it("replies nothing while the trustline's outcome is unknown", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { ask, ledger, state, queue } = varial({ connected: true });
      ledger.lands = false;
      ledger.accounts.set(state.address, {
        balance: xlm('100'),
        sequence: 100n,
      });
      ledger.store(sacInstance(usdcSac, usdc.toString()));
      const reply = ask('SUBMIT_TOKEN', { contractId: usdcSac, ...onTestnet });
      const prompt = await queue.nextPrompt('addToken');
      const approved = expect(prompt.approve()).rejects.toMatchObject({
        code: 'OUTCOME_UNKNOWN',
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await approved;
      expect(await isPending(reply)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
