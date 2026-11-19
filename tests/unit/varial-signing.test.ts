import { Keypair, Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { declined, internalError } from '@/wallet/prompts';
import { payment, preimage, sha256 } from '@tests/helpers/envelopes';
import { failure, varial } from '@tests/helpers/varial';
import type { Signed } from '@tests/helpers/varial';

type Signature = string | { type: 'Buffer'; data: number[] };

const standalone = 'Standalone Network ; February 2017';

function signatureBytes(signature: Signature): Buffer {
  return typeof signature === 'string'
    ? Buffer.from(signature, 'base64')
    : Buffer.from(signature.data);
}

describe('SUBMIT_AUTH_ENTRY', () => {
  it.each([
    ['7.0.0', 'string'],
    ['4.2.0', 'string'],
    ['4.2.0-beta.0', 'Buffer'],
    ['4.1.0', 'Buffer'],
    [undefined, 'Buffer'],
  ])(
    'signs sha256 of the entry and encodes it for apiVersion %s as a %s',
    async (apiVersion, encoding) => {
      const { ask, state } = varial({ connected: true, policy: 'approve' });
      const entryXdr = preimage(state.address);
      const reply = await ask('SUBMIT_AUTH_ENTRY', {
        entryXdr,
        apiVersion,
        networkPassphrase: Networks.TESTNET,
        accountToSign: state.address,
      });
      const { signedAuthEntry, signerAddress } = reply as Signed;
      const signature = signedAuthEntry as Signature;

      expect(JSON.parse(JSON.stringify(reply))).toEqual(reply);
      expect(typeof signature === 'string' ? 'string' : signature.type).toBe(
        encoding,
      );
      expect(signerAddress).toBe(state.address);
      expect(
        state.account.keypair.verify(
          sha256(Buffer.from(entryXdr, 'base64')),
          signatureBytes(signature),
        ),
      ).toBe(true);
    },
  );

  it('compares the network inside the entry, not the one the app sent', async () => {
    const { ask, state, queue, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    const asTestnet = {
      apiVersion: '7.0.0',
      networkPassphrase: Networks.TESTNET,
    };
    await expect(
      ask('SUBMIT_AUTH_ENTRY', {
        entryXdr: preimage(state.address, Networks.FUTURENET),
        ...asTestnet,
      }),
    ).resolves.toEqual(failure(declined));
    await ask('SUBMIT_AUTH_ENTRY', {
      entryXdr: preimage(state.address, standalone),
      ...asTestnet,
    });

    expect(queue.prompts()).toMatchObject([
      { networkPassphrase: Networks.TESTNET, blocked: 'networkMismatch' },
      { blocked: 'networkMismatch' },
    ]);
    expect(
      violations.list().map(({ detail }) => detail.split('\n')[0]),
    ).toEqual([
      `The app asked to sign for "${Networks.FUTURENET}",`,
      'The app asked to sign for an unknown network,',
    ]);
  });

  it('records signerMismatch for an entry bound to another address', async () => {
    const { ask, main, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    const stranger = Keypair.random().publicKey();
    await ask('SUBMIT_AUTH_ENTRY', {
      entryXdr: preimage(stranger, Networks.TESTNET, 'v2'),
      apiVersion: '7.0.0',
      networkPassphrase: Networks.TESTNET,
    });
    await ask('SUBMIT_AUTH_ENTRY', {
      entryXdr: preimage(stranger, Networks.TESTNET, 'v1'),
      apiVersion: '7.0.0',
      networkPassphrase: Networks.TESTNET,
    });
    expect(violations.list()).toEqual([
      expect.objectContaining({
        promptId: 'p1',
        kind: 'signerMismatch',
        detail: expect.stringContaining(
          `${stranger},\nbut the wallet signs with ${main.address}.`,
        ),
      }),
    ]);
  });

  it("blocks an entry from a site that isn't connected", async () => {
    const { ask, state, queue } = varial({ policy: 'approve' });
    await expect(
      ask('SUBMIT_AUTH_ENTRY', {
        entryXdr: preimage(state.address),
        apiVersion: '7.0.0',
        networkPassphrase: Networks.TESTNET,
      }),
    ).resolves.toEqual(failure(declined));
    expect(queue.prompts()).toMatchObject([{ blocked: 'notConnected' }]);
  });

  it("answers an entry that doesn't parse with Declined and no prompt", async () => {
    const { ask, state, queue, violations } = varial({ connected: true });
    await expect(
      ask('SUBMIT_AUTH_ENTRY', {
        entryXdr: payment(state.address),
        apiVersion: '7.0.0',
        networkPassphrase: Networks.TESTNET,
      }),
    ).resolves.toEqual(failure(declined));
    expect(queue.prompts()).toEqual([]);
    expect(violations.list()).toMatchObject([
      { promptId: null, kind: 'invalidXdr' },
    ]);
  });
});

describe('SUBMIT_BLOB', () => {
  const message = 'Sign in to the test app';
  const payload = sha256(
    Buffer.concat([
      Buffer.from('Stellar Signed Message:\n'),
      Buffer.from(message),
    ]),
  );

  it.each([
    ['7.0.0', 'string'],
    ['4.0.0', 'string'],
    ['3.1.0', 'Buffer'],
  ])(
    'signs the message per SEP-53 and encodes it for apiVersion %s as a %s',
    async (apiVersion, encoding) => {
      const { ask, state, queue } = varial({ connected: true });
      const reply = ask('SUBMIT_BLOB', {
        blob: message,
        apiVersion,
        networkPassphrase: Networks.TESTNET,
      });
      const prompt = await queue.nextPrompt('signMessage');
      expect(prompt).toMatchObject({ message, blocked: null });
      await prompt.approve();

      const { signedBlob, signerAddress } = (await reply) as Signed;
      const signature = signedBlob as Signature;
      expect(typeof signature === 'string' ? 'string' : signature.type).toBe(
        encoding,
      );
      expect(signerAddress).toBe(state.address);
      expect(
        state.account.keypair.verify(payload, signatureBytes(signature)),
      ).toBe(true);
    },
  );

  it('compares the network only when the app sends one', async () => {
    const { ask, queue, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    await ask('SUBMIT_BLOB', { blob: message, apiVersion: '7.0.0' });
    await expect(
      ask('SUBMIT_BLOB', {
        blob: message,
        apiVersion: '7.0.0',
        networkPassphrase: Networks.FUTURENET,
      }),
    ).resolves.toEqual(failure(declined));

    expect(queue.prompts()).toMatchObject([
      { networkPassphrase: null, blocked: null, status: 'approved' },
      { blocked: 'networkMismatch', status: 'rejected' },
    ]);
    expect(violations.list()).toMatchObject([
      { promptId: 'p2', kind: 'networkMismatch' },
    ]);
  });

  it("blocks a message from a site that isn't connected", async () => {
    const { ask, queue } = varial({ policy: 'approve' });
    await expect(
      ask('SUBMIT_BLOB', { blob: message, apiVersion: '7.0.0' }),
    ).resolves.toEqual(failure(declined));
    expect(queue.prompts()).toMatchObject([{ blocked: 'notConnected' }]);
  });

  it("answers an apiVersion that isn't a version with the internal error", async () => {
    const { ask, queue } = varial({ connected: true });
    await expect(
      ask('SUBMIT_BLOB', { blob: message, apiVersion: 'latest' }),
    ).resolves.toEqual(failure(internalError));
    expect(queue.prompts()).toEqual([]);
  });
});
