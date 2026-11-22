# Stardust

Browser automation for testing Stellar dapps, with a wallet your test controls.

Set up the wallet and its state: installed or not, connected or not, and the accounts it holds. Your test then drives the app the way a user would, against a wallet that answers like the real one. Every test gets fresh, funded testnet accounts. Varial and SEP-60 wallets are supported, and Stardust is checked nightly against the real Varial extension.

So you can test what users actually do:

- open the app with no wallet installed
- connect, or reject the connection
- switch account or network, or lock the wallet
- sign transactions, messages and auth entries
- call contracts and check the result on chain
- add tokens and trustlines

## Quick start

**1. Install**

```sh
pnpm add -D stardust-stellar
```

**2. Add `stardust.config.ts` to your project root**

```ts
import { defineConfig } from 'stardust-stellar';

export default defineConfig({
  network: 'testnet',
  app: { url: 'http://localhost:3000', start: 'pnpm dev' },
});
```

**3. Write a test in `e2e/pay.spec.ts`**

```ts
import { expect, test, xlm } from 'stardust-stellar/test';

test.use({
  stardust: {
    users: {
      payer: { connected: true },
      friend: {},
    },
  },
});

test('sends 5 XLM to a friend', async ({ users: { payer, friend } }) => {
  await payer.page.goto('/send');
  await payer.page.getByLabel('To').fill(friend.account.address);
  await payer.page.getByLabel('Amount').fill('5');
  await payer.page.getByRole('button', { name: 'Send' }).click();

  const prompt = await payer.wallet.nextPrompt('signTransaction');
  await expect(prompt).toLand();
  await expect(prompt).toChangeBalance(
    friend.account.address,
    'native',
    xlm('5'),
  );
});
```

**4. Run it**

```sh
npx stardust test                  # every test
npx stardust test e2e/pay.spec.ts  # one file
npx stardust test --show           # with the browser visible
npx stardust test -- --grep pay    # only tests whose name matches "pay"
```

```text
stardust  network  testnet (https://soroban-testnet.stellar.org, protocol 30) ready
stardust  browser  chromium ready
stardust  app      pnpm dev -> http://localhost:3000 ready
stardust  wallets  Varial 5.53.0, SEP-43 1.2.1, SEP-60 0.1.0

  ✓  1 e2e/pay.spec.ts:12:1 › sends 5 XLM to a friend (16.2s)

  1 passed (21.4s)

stardust  app      stopped
```

## Concepts

### Users

A user is one person: a browser tab (`page`), the wallet in it, and that wallet's accounts. Declare users once per file with `test.use`, and every test gets fresh ones.

| Option      | Default                    | Meaning                                                                       |
| ----------- | -------------------------- | ----------------------------------------------------------------------------- |
| `wallet`    | `'varial'`                 | `'varial'`, `'sep60'`, or `'none'` for no wallet                              |
| `connected` | `false`                    | Start as if the user had already connected the site                           |
| `policy`    | `'approve'`                | How the wallet answers prompts: `'approve'`, `'reject'` or `'manual'`         |
| `accounts`  | `{ main: { fund: true } }` | The wallet's accounts. `fund` is `true` (100 XLM), up to `'1000'`, or `false` |
| `strict`    | `true`                     | Fail the test when the app breaks wallet rules                                |

### Prompts

A prompt is anything a real wallet shows as a popup: `connect`, `signTransaction`, `signAuthEntry`, `signMessage` and `addToken`. `wallet.nextPrompt(kind)` returns the next one. Under the `'manual'` policy, the test answers it with `approve()`, `reject()`, `fail()` or `hang()`.

### Checks

| Check                                     | Passes when                                       |
| ----------------------------------------- | ------------------------------------------------- |
| `toInvoke({ contract, fn, args })`        | The transaction calls this contract function      |
| `toHaveOperation({ type, ...fields })`    | The transaction contains this classic operation   |
| `toLand()`                                | The transaction succeeds on chain                 |
| `toFail({ resultCode, contractError })`   | The transaction fails, optionally with this error |
| `toChangeBalance(address, asset, change)` | A balance moved by this amount, fees excluded     |
| `toEmit({ contract, topic })`             | The contract emitted this event                   |

### Wallet actions

`wallet.switchAccount()`, `switchNetwork()`, `lock()`, `unlock()` and `disconnect()` act as the user would in the real wallet.

## When a test fails

The output shows the failed check and the wallet's timeline: each prompt and its answer, the app's RPC calls, and what landed on chain. `stardust-results/` keeps a screenshot, a trace and the timeline for each failed test.

## CI

```yaml
- uses: actions/checkout@v7
- uses: pnpm/action-setup@v6
- uses: actions/setup-node@v7
  with:
    node-version: 22
    cache: pnpm
- run: pnpm install --frozen-lockfile
- run: pnpm exec stardust test
- uses: actions/upload-artifact@v7
  if: failure()
  with:
    name: stardust-results
    path: stardust-results/
```

## Compatibility

|                          | Version                       |
| ------------------------ | ----------------------------- |
| Node.js                  | 22.18 or later, 23.6 or later |
| Varial                   | 5.53.0                        |
| `@stellar/freighter-api` | 6.x                           |
| `@stellar/varial-sdk`    | 7.x                           |
| Stellar Wallets Kit      | 2.7, 2.8                      |
| SEP-43, SEP-60           | 1.2.1, 0.1.0                  |

## Safety

- Stardust never runs on mainnet. It refuses any network that reports the mainnet passphrase.
- Secret keys stay in Node and never enter the page.
- Every account is a throwaway testnet key created for one test.

## Learn more

[Examples on real dapps](tests/dapps) · [Changelog](CHANGELOG.md) · [Contributing](AGENTS.md)

## License

[MIT](LICENSE)
