import { describe, expect, it } from 'vitest';
import { payment, preimage } from '@tests/helpers/envelopes';
import { invalid, sep60, site } from '@tests/helpers/sep60';

describe('requests and replies', () => {
  it.each([
    ['a method SEP-43 lacks', { method: 'addToken', contractId: 'C' }],
    ['a payload that is not an object', 'getAddress'],
    ['a non-string xdr', { method: 'signTransaction', xdr: 42 }],
    [
      'a non-boolean submit',
      { method: 'signTransaction', xdr: 'AAAA', opts: { submit: 'yes' } },
    ],
    ['a non-string message', { method: 'signMessage', message: null }],
  ])('answers %s with -3 and no prompt', async (_, payload) => {
    const { wallet, queue } = sep60();
    await expect(wallet.handle(site, payload)).resolves.toMatchObject({
      error: { code: -3, message: invalid, ext: [expect.any(String)] },
    });
    expect(queue.prompts()).toEqual([]);
  });

  it("never sends a field SEP-43 doesn't define", async () => {
    const { ask, main } = sep60({ connected: true, policy: 'approve' });
    const replies = [
      await ask('getAddress'),
      await ask('getNetwork'),
      await ask('signTransaction', { xdr: payment(main.address) }),
      await ask('signAuthEntry', { authEntry: preimage(main.address) }),
      await ask('signMessage', { message: 'hi' }),
    ];
    expect(replies.map((reply) => Object.keys(reply).sort())).toEqual([
      ['address'],
      ['network', 'networkPassphrase'],
      ['signedTxXdr', 'signerAddress'],
      ['signedAuthEntry', 'signerAddress'],
      ['signedMessage', 'signerAddress'],
    ]);
  });
});
