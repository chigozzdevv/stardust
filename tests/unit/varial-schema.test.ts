import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { varialReplies, varialRequest } from '@/protocols/varial/schema';
import { declined, internalError } from '@/wallet/prompts';
import { failure, site, varial } from '@tests/helpers/varial';

describe('messages Varial drops', () => {
  it('never answers an unknown type and records unknownMessage', async () => {
    const { wallet, violations } = varial();
    await expect(
      wallet.handle(site, { type: 'REQUEST_EVERYTHING' }),
    ).resolves.toBeNull();
    await expect(wallet.handle(site, 'REQUEST_ACCESS')).resolves.toBeNull();
    expect(violations.list()).toEqual([
      {
        promptId: null,
        kind: 'unknownMessage',
        detail: [
          "The app sent a message of type 'REQUEST_EVERYTHING', which Varial doesn't recognize.",
          'Use a message type that @stellar/freighter-api or @stellar/varial-sdk sends.',
        ].join('\n'),
      },
      expect.objectContaining({
        detail: expect.stringContaining('of type undefined,'),
      }),
    ]);
  });

  it('answers a request with malformed fields with the internal error', async () => {
    const { ask, queue } = varial({ connected: true });
    await expect(
      ask('SUBMIT_TRANSACTION', { transactionXdr: 42 }),
    ).resolves.toEqual(failure(internalError));
    await expect(ask('SUBMIT_TOKEN', {})).resolves.toEqual({
      apiError: internalError,
    });
    expect(queue.prompts()).toEqual([]);
  });
});

describe('schemas', () => {
  it('reads empty optional fields as missing, like Varial', () => {
    expect(
      varialRequest.parse({
        type: 'SUBMIT_BLOB',
        blob: 'hello',
        apiVersion: '',
        networkPassphrase: '',
        accountToSign: null,
        source: 'FREIGHTER_EXTERNAL_MSG_REQUEST',
      }),
    ).toMatchObject({
      type: 'SUBMIT_BLOB',
      blob: 'hello',
      apiVersion: undefined,
      networkPassphrase: undefined,
      accountToSign: undefined,
    });
  });

  it("lets no field out that Varial doesn't reply with", () => {
    const address = Keypair.random().publicKey();
    const signed = { signedTransaction: 'AAAA', signerAddress: address };
    expect(varialReplies.SUBMIT_TRANSACTION.safeParse(signed).success).toBe(
      true,
    );
    expect(
      varialReplies.SUBMIT_TRANSACTION.safeParse({
        ...signed,
        secret: Keypair.random().secret(),
      }).success,
    ).toBe(false);
    expect(
      varialReplies.REQUEST_ACCESS.safeParse({
        apiError: declined,
        error: 'another text',
      }).success,
    ).toBe(false);
  });
});
