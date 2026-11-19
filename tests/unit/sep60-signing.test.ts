import { Keypair, Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { declined } from '@/wallet/prompts';
import { payment, preimage, sha256 } from '@tests/helpers/envelopes';
import { failure, invalid, onTestnet, sep60 } from '@tests/helpers/sep60';
import type { Signed } from '@tests/helpers/sep60';

const standalone = 'Standalone Network ; February 2017';

describe('signAuthEntry', () => {
  it('signs sha256 of the preimage and replies the signature in base64', async () => {
    const { ask, state } = sep60({ connected: true, policy: 'approve' });
    const authEntry = preimage(state.address);
    const { signedAuthEntry, signerAddress } = (await ask('signAuthEntry', {
      authEntry,
      opts: { address: state.address },
    })) as Signed;
    const signature = Buffer.from(String(signedAuthEntry), 'base64');
    expect(signature).toHaveLength(64);
    expect(signerAddress).toBe(state.address);
    expect(
      state.account.keypair.verify(
        sha256(Buffer.from(authEntry, 'base64')),
        signature,
      ),
    ).toBe(true);
  });

  it('checks the network inside the entry when the app sends none, as the SDK does', async () => {
    const { ask, state, queue, violations } = sep60({
      connected: true,
      policy: 'approve',
    });
    await expect(
      ask('signAuthEntry', {
        authEntry: preimage(state.address, Networks.FUTURENET),
      }),
    ).resolves.toEqual({ error: declined });
    await ask('signAuthEntry', {
      authEntry: preimage(state.address, standalone),
    });
    await ask('signAuthEntry', {
      authEntry: preimage(state.address),
      opts: { networkPassphrase: Networks.FUTURENET },
    });
    expect(queue.prompts()).toMatchObject([
      { networkPassphrase: null, blocked: 'networkMismatch' },
      { blocked: 'networkMismatch' },
      { networkPassphrase: Networks.FUTURENET, blocked: 'networkMismatch' },
    ]);
    expect(
      violations.list().map(({ detail }) => detail.split('\n')[0]),
    ).toEqual([
      `The app asked to sign for "${Networks.FUTURENET}",`,
      'The app asked to sign for an unknown network,',
      `The app asked to sign for "${Networks.FUTURENET}",`,
    ]);
  });

  it('records signerMismatch for an entry bound to another address', async () => {
    const { ask, main, violations } = sep60({
      connected: true,
      policy: 'approve',
    });
    const stranger = Keypair.random().publicKey();
    await ask('signAuthEntry', {
      authEntry: preimage(stranger, Networks.TESTNET, 'v2'),
      opts: { address: stranger },
    });
    expect(violations.list()).toMatchObject([
      {
        kind: 'signerMismatch',
        detail: expect.stringContaining(
          `but the wallet signs with ${main.address}.`,
        ),
      },
    ]);
  });

  it("answers XDR that isn't an auth preimage with -3 and no prompt", async () => {
    const { ask, queue, violations, main } = sep60({ connected: true });
    await expect(
      ask('signAuthEntry', { authEntry: payment(main.address) }),
    ).resolves.toEqual(failure(-3, invalid, ['Invalid auth entry XDR']));
    expect(queue.prompts()).toEqual([]);
    expect(violations.list()).toMatchObject([
      { kind: 'invalidXdr', detail: expect.stringMatching(/a preimage that/) },
    ]);
  });
});

describe('signMessage', () => {
  it('signs per SEP-53 and replies the signature in base64', async () => {
    const { ask, state, queue } = sep60();
    const reply = ask('signMessage', { message: 'Sign in to the test app' });
    await (await queue.nextPrompt('connect')).approve();
    const prompt = await queue.nextPrompt('signMessage');
    expect(prompt).toMatchObject({
      message: 'Sign in to the test app',
      networkPassphrase: null,
      blocked: null,
    });
    await prompt.approve();
    const { signedMessage, signerAddress } = (await reply) as Signed;
    const signature = Buffer.from(String(signedMessage), 'base64');
    expect(signature).toHaveLength(64);
    expect(signerAddress).toBe(state.address);
    expect(
      state.account.keypair.verify(
        sha256(Buffer.from('Stellar Signed Message:\nSign in to the test app')),
        signature,
      ),
    ).toBe(true);
  });

  it('compares networkPassphrase only when the app sends one', async () => {
    const { ask, queue } = sep60({ connected: true, policy: 'approve' });
    await ask('signMessage', { message: 'hi', opts: onTestnet });
    await ask('signMessage', {
      message: 'hi',
      opts: { networkPassphrase: Networks.FUTURENET },
    });
    expect(queue.prompts()).toMatchObject([
      { blocked: null, status: 'approved' },
      { blocked: 'networkMismatch', status: 'rejected' },
    ]);
  });
});
