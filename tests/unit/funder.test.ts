import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { xlm } from '@/amounts';
import { Funder, topUpAmount } from '@/funding/funder';
import type { FundingContext } from '@/funding/funder';
import { networkId } from '@/network/rpc';
import { FakeLedger } from '@tests/helpers/ledger';

const fee = 100n;
const keyName = `${networkId(Networks.TESTNET).toString('hex')}.json`;

let dir: string;
let ledger: FakeLedger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stardust-funder-'));
  ledger = new FakeLedger();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function funder(context: FundingContext = ledger.context()): Funder {
  return new Funder(context, {
    dir,
    fetch: ledger.fetch,
    lock: { intervalMs: 1 },
  });
}

async function savedKey() {
  const text = await readFile(join(dir, keyName), 'utf8');
  return JSON.parse(text) as {
    network: string;
    address: string;
    secretKey: string;
  };
}

function setBalance(address: string, balance: bigint): void {
  const account = ledger.accounts.get(address);
  if (!account) throw new Error(`${address} isn't on the fake ledger`);
  account.balance = balance;
}

describe('Funder', () => {
  it('creates the funder with Friendbot on first use, readable only by the user', async () => {
    const sub = await funder().createSubFunder();
    const saved = await savedKey();

    expect(saved.network).toBe(Networks.TESTNET);
    expect(Keypair.fromSecret(saved.secretKey).publicKey()).toBe(saved.address);
    expect(ledger.friendbotCalls).toEqual([saved.address]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, keyName))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([keyName]);
    expect(ledger.balance(sub.address)).toBe(xlm('2000'));
    expect(ledger.balance(saved.address)).toBe(
      xlm('10000') - xlm('2000') - fee,
    );
  });

  it('reuses the saved funder in later runs', async () => {
    await funder().createSubFunder();
    const before = await readFile(join(dir, keyName), 'utf8');
    await funder().createSubFunder();

    expect(ledger.friendbotCalls).toHaveLength(1);
    expect(await readFile(join(dir, keyName), 'utf8')).toBe(before);
  });

  it('refills through Friendbot and accountMerge when a sub-funder would leave it below 1,000 XLM', async () => {
    await funder().createSubFunder();
    const { address } = await savedKey();
    setBalance(address, xlm('2999'));
    await funder().createSubFunder();

    const [, extra = ''] = ledger.friendbotCalls;
    expect(ledger.friendbotCalls).toEqual([address, extra]);
    expect(extra).not.toBe(address);
    expect(ledger.accounts.has(extra)).toBe(false);
    const merge = ledger.transactions.at(-2);
    expect(merge?.source).toBe(extra);
    expect(merge?.operations).toEqual([
      { type: 'accountMerge', destination: address },
    ]);
    expect(ledger.balance(address)).toBe(
      xlm('2999') + xlm('10000') - fee - xlm('2000') - fee,
    );
  });

  it('keeps going without a refill while it stays at 1,000 XLM', async () => {
    await funder().createSubFunder();
    const { address } = await savedKey();
    setBalance(address, xlm('3000'));
    await funder().createSubFunder();

    expect(ledger.friendbotCalls).toEqual([address]);
  });

  it('is recreated with Friendbot after a testnet reset', async () => {
    await funder().createSubFunder();
    const before = await readFile(join(dir, keyName), 'utf8');
    const { address } = await savedKey();
    ledger.accounts.clear();
    const sub = await funder().createSubFunder();

    expect(ledger.friendbotCalls).toEqual([address, address]);
    expect(await readFile(join(dir, keyName), 'utf8')).toBe(before);
    expect(ledger.balance(sub.address)).toBe(xlm('2000'));
  });

  it('serializes funders that run at the same time', async () => {
    const subs = await Promise.all([
      funder().createSubFunder(),
      funder().createSubFunder(),
      funder().createSubFunder(),
    ]);

    expect(ledger.friendbotCalls).toHaveLength(1);
    for (const sub of subs) {
      expect(ledger.balance(sub.address)).toBe(xlm('2000'));
    }
  });

  it('refuses a network without Friendbot', async () => {
    const noFriendbot = async () =>
      funder(ledger.context({ friendbotUrl: null }));
    await expect(noFriendbot()).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
      retryable: true,
      message:
        "https://rpc.stardust.test reports no Friendbot, so Stardust has no funder for test accounts on this network. Use 'testnet', or an RPC for a network with a Friendbot.",
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses mainnet before touching the disk or the network', async () => {
    const mainnet = ledger.context({
      name: 'mainnet',
      networkPassphrase: Networks.PUBLIC,
    });
    const onMainnet = async () => funder(mainnet);
    await expect(onMainnet()).rejects.toMatchObject({
      code: 'MAINNET_REFUSED',
    });
    expect(await readdir(dir)).toEqual([]);
    expect(ledger.friendbotCalls).toEqual([]);
    expect(ledger.transactions).toEqual([]);
  });

  it('calls Friendbot once, without retrying, when it refuses', async () => {
    ledger.friendbot = () => new Response('', { status: 429 });
    const failure = await funder()
      .createSubFunder()
      .catch((error: unknown) => error);
    const { address } = await savedKey();

    expect(failure).toMatchObject({
      code: 'FUNDING_FAILED',
      retryable: true,
      message: `Friendbot at https://friendbot.stardust.test/ refused to fund ${address} with HTTP 429. It's rate limited, so wait a few minutes, then run the tests again.`,
    });
    expect(ledger.friendbotCalls).toEqual([address]);
    expect(await readdir(dir)).toEqual([keyName]);
  });

  it('calls Friendbot once, without retrying, when it does not answer', async () => {
    ledger.friendbot = () => {
      throw new TypeError('fetch failed');
    };
    await expect(funder().createSubFunder()).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
      message:
        "Friendbot at https://friendbot.stardust.test/ didn't answer. Check your connection, then run the tests again.",
    });
    expect(ledger.friendbotCalls).toHaveLength(1);
  });

  it('funds the saved key on the next run after Friendbot failed', async () => {
    const friendbot = ledger.friendbot;
    ledger.friendbot = () => new Response('', { status: 503 });
    await expect(funder().createSubFunder()).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
    });
    const { address } = await savedKey();
    ledger.friendbot = friendbot;
    await funder().createSubFunder();

    expect(ledger.friendbotCalls).toEqual([address, address]);
  });

  it('leaves a key file it cannot read alone', async () => {
    await writeFile(join(dir, keyName), 'not a key');
    await expect(funder().createSubFunder()).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
      message: `${join(dir, keyName)} isn't a funder key Stardust can read. Move it out of ${dir}, then run the tests again to create a new funder.`,
    });
    expect(await readFile(join(dir, keyName), 'utf8')).toBe('not a key');
    expect(ledger.friendbotCalls).toEqual([]);
  });

  it('reports OUTCOME_UNKNOWN, sends once and releases the lock when a funding transaction does not land', async () => {
    await funder().createSubFunder();
    ledger.lands = false;
    const sent = ledger.transactions.length;
    const failure = funder().createSubFunder();

    await expect(failure).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      retryable: true,
      message: expect.stringMatching(
        /^Stardust's funding transaction [0-9a-f]{64} didn't appear on the network within 0\.2s, so its outcome is unknown\. Check https:\/\/rpc\.stardust\.test, then run the tests again\.$/,
      ),
    });
    expect(ledger.transactions).toHaveLength(sent + 1);
    expect(await readdir(dir)).toEqual([keyName]);
  });

  it('fails with FUNDING_FAILED when even a refill is not enough', async () => {
    const sub = await funder().createSubFunder();
    const { address } = await savedKey();
    await expect(sub.topUp(xlm('20000'))).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
      message: expect.stringContaining(
        `the funder ${address} holds 17999.9999800 XLM, which isn't enough to send 20000.0000000 XLM.`,
      ),
    });
    expect(ledger.friendbotCalls).toHaveLength(2);
  });
});

describe('SubFunder', () => {
  it.each([
    ['2000', '100', '0'],
    ['2000', '1990', '0'],
    ['2000', '1990.0000001', '2000'],
    ['2000', '1995', '2000'],
    ['2000', '3990', '2000'],
    ['2000', '3990.0000001', '4000'],
    ['0', '0', '2000'],
    ['150', '1000', '2000'],
  ])(
    'with %s XLM and a test needing %s XLM, tops up by %s XLM',
    (balance, total, amount) => {
      expect(topUpAmount(xlm(balance), xlm(total))).toBe(xlm(amount));
    },
  );

  it('tops up from the funder by the difference rounded up to 2,000 XLM', async () => {
    const sub = await funder().createSubFunder();
    const { address } = await savedKey();
    const account = await sub.topUp(xlm('1995'));

    expect(account.balance).toBe(xlm('4000'));
    expect(ledger.balance(sub.address)).toBe(xlm('4000'));
    const payment = ledger.transactions.at(-1);
    expect(payment?.source).toBe(address);
    expect(payment?.operations).toEqual([
      {
        type: 'payment',
        destination: sub.address,
        asset: expect.objectContaining({ code: 'XLM' }),
        amount: '2000.0000000',
      },
    ]);
  });

  it('sends nothing while it holds the test total plus 10 XLM', async () => {
    const sub = await funder().createSubFunder();
    const sent = ledger.transactions.length;
    const account = await sub.topUp(xlm('1990'));

    expect(account).toMatchObject({
      address: sub.address,
      balance: xlm('2000'),
    });
    expect(ledger.transactions).toHaveLength(sent);
  });

  it('fails with FUNDING_FAILED when it no longer exists', async () => {
    const sub = await funder().createSubFunder();
    ledger.accounts.delete(sub.address);
    await expect(sub.topUp(xlm('100'))).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
      message: `the sub-funder ${sub.address} no longer exists on the network, for example after a testnet reset. Run the tests again.`,
    });
  });

  it('merges back into the funder on release', async () => {
    const sub = await funder().createSubFunder();
    const { address } = await savedKey();
    const before = ledger.balance(address) ?? 0n;
    await sub.release();

    expect(ledger.accounts.has(sub.address)).toBe(false);
    expect(ledger.balance(address)).toBe(before + xlm('2000') - fee);
    const merge = ledger.transactions.at(-1);
    expect(merge?.source).toBe(sub.address);
    expect(merge?.operations).toEqual([
      { type: 'accountMerge', destination: address },
    ]);
  });
});
