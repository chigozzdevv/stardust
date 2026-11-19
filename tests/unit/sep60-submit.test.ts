import { describe, expect, it } from 'vitest';
import { payment } from '@tests/helpers/envelopes';
import { failure, invalid, sep60, verifies } from '@tests/helpers/sep60';
import type { Signed } from '@tests/helpers/sep60';

function horizon(status: number, body: object) {
  const posts: { url: string; type: string | null; tx: string | null }[] = [];
  const send: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.endsWith('/transactions')) {
      return new Response('Not Found', { status: 404 });
    }
    posts.push({
      url,
      type: new Headers(init?.headers).get('content-type'),
      tx: new URLSearchParams(String(init?.body)).get('tx'),
    });
    return Response.json(body, { status });
  };
  return { send, posts };
}

describe('signTransaction with submit: true', () => {
  it("sends to the wallet's RPC with sendTransaction, then replies", async () => {
    const { ask, queue, ledger, requests, main, fund } = sep60({
      connected: true,
      policy: 'approve',
    });
    fund(main.address);
    const reply = (await ask('signTransaction', {
      xdr: payment(main.address),
      opts: { submit: true },
    })) as Signed;
    expect(verifies(main, String(reply.signedTxXdr))).toBe(true);
    expect(requests).toEqual([
      { url: 'https://soroban-testnet.stellar.org', method: 'sendTransaction' },
    ]);
    expect(ledger.transactions).toHaveLength(1);
    const [prompt] = queue.prompts('signTransaction');
    await expect(prompt?.landed({ timeoutMs: 1_000 })).resolves.toMatchObject({
      hash: prompt?.transaction.hash,
    });
  });

  it('replies -2 when the RPC refuses the transaction', async () => {
    const { ask, queue, main } = sep60({ connected: true, policy: 'approve' });
    await expect(
      ask('signTransaction', {
        xdr: payment(main.address),
        opts: { submit: true },
      }),
    ).resolves.toEqual(
      failure(-2, 'An error occurred with Stellar RPC. Please try again.', [
        'txNO_ACCOUNT',
      ]),
    );
    expect(queue.prompts()).toMatchObject([{ status: 'approved' }]);
  });

  it('probes submitUrl with getHealth once, and uses sendTransaction when it answers', async () => {
    const { ask, requests, main, fund } = sep60({
      connected: true,
      policy: 'approve',
    });
    const submitUrl = 'https://rpc.other.test';
    fund(main.address);
    const opts = { submit: true, submitUrl };
    await ask('signTransaction', { xdr: payment(main.address), opts });
    await ask('signTransaction', { xdr: payment(main.address), opts });
    expect(requests).toEqual([
      { url: submitUrl, method: 'getHealth' },
      { url: submitUrl, method: 'sendTransaction' },
      { url: submitUrl, method: 'sendTransaction' },
    ]);
  });

  it('treats a submitUrl without getHealth as Horizon and POSTs to /transactions', async () => {
    const { send, posts } = horizon(200, { successful: true });
    const { ask, main } = sep60({ connected: true, policy: 'approve', send });
    const reply = (await ask('signTransaction', {
      xdr: payment(main.address),
      opts: { submit: true, submitUrl: 'https://horizon.test/' },
    })) as Signed;
    expect(posts).toEqual([
      {
        url: 'https://horizon.test/transactions',
        type: 'application/x-www-form-urlencoded',
        tx: reply.signedTxXdr,
      },
    ]);
  });

  it('replies -2 with the result codes when Horizon refuses the transaction', async () => {
    const { send } = horizon(400, {
      title: 'Transaction Failed',
      extras: {
        result_codes: {
          transaction: 'tx_failed',
          operations: ['op_no_destination'],
        },
      },
    });
    const { ask, main } = sep60({ connected: true, policy: 'approve', send });
    await expect(
      ask('signTransaction', {
        xdr: payment(main.address),
        opts: { submit: true, submitUrl: 'https://horizon.test' },
      }),
    ).resolves.toEqual(
      failure(-2, 'An error occurred with Horizon. Please try again.', [
        'https://horizon.test/transactions answered HTTP 400',
        'tx_failed',
        'op_no_destination',
      ]),
    );
  });

  it("refuses a submitUrl that isn't http or https with -3", async () => {
    const { ask, queue, main } = sep60({ connected: true });
    await expect(
      ask('signTransaction', {
        xdr: payment(main.address),
        opts: { submit: true, submitUrl: 'file:///etc/passwd' },
      }),
    ).resolves.toMatchObject({ error: { code: -3, message: invalid } });
    expect(queue.prompts()).toEqual([]);
  });
});
