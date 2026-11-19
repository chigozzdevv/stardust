# Stardust

**End-to-end tests for Stellar dapps, with a wallet the test controls.**

Stardust runs your dapp in Chromium through Playwright and plays the wallet. It puts an emulated Varial (formerly Freighter) or SEP-60/SEP-43 wallet in the page, creates funded throwaway accounts on testnet for every test, answers wallet prompts the way the test says, and checks what landed on the network.

You install it in your own project and run it on your machine or in CI. There are no servers, accounts or dashboards.

[Specification](stardust.md) · [Agent guide](AGENTS.md)

## Install

```sh
pnpm add -D stardust-stellar
```

```json
{
  "scripts": {
    "test:e2e": "stardust test"
  }
}
```

Stardust needs Node.js 22.18 or later, or 23.6 or later on Node 23. Playwright comes with it, and Chromium downloads the first time `stardust test` runs. A project that has its own `@playwright/test` keeps it; Stardust runs its own copy.

## Config

```ts
// stardust.config.ts (project root)
import { defineConfig } from 'stardust-stellar';

export default defineConfig({
  network: 'testnet',
  app: { url: 'http://localhost:3000', start: 'pnpm dev' },
  tests: './e2e',
});
```

| Field       | Required | Meaning                                                                                             |
| ----------- | -------- | --------------------------------------------------------------------------------------------------- |
| `network`   | Yes      | `'testnet'`, or `{ rpcUrl }` for another RPC endpoint                                               |
| `app.url`   | Yes      | Where the app runs. `page.goto('/swap')` opens `app.url + '/swap'`                                  |
| `app.start` | No       | The command that starts the app. If something already answers at `app.url`, Stardust starts nothing |
| `tests`     | No       | The folder with test files, relative to the project folder. Default `./e2e`                         |

Stardust reads the passphrase and Friendbot URL from the network itself. The config is loaded with Node's built-in TypeScript support, so it can't use `enum` or `namespace`.

## A test

```ts
// e2e/swap.spec.ts
import { test, expect, xlm } from 'stardust-stellar/test';
import { CONTRACTS } from '../src/lib/contracts';

test.use({
  stardust: {
    users: {
      trader: { wallet: 'varial', connected: true },
    },
  },
});

test('swaps 10 XLM', async ({ users: { trader } }) => {
  await trader.page.goto('/swap');
  await trader.page.getByLabel('You pay').fill('10');
  await trader.page.getByRole('button', { name: 'Swap' }).click();

  const prompt = await trader.wallet.nextPrompt('signTransaction');
  expect(prompt).toInvoke({
    contract: CONTRACTS.testnet.router,
    fn: 'swap_exact_in',
    args: { amount_in: xlm('10') },
  });
  await expect(prompt).toLand();
  await expect(prompt).toChangeBalance(
    trader.account.address,
    'native',
    -xlm('10'),
  );
});
```

Everything comes from `stardust-stellar/test`: Playwright's `test` and `expect` with Stardust's options and checks, the amount helpers `xlm` and `units`, and the `User` type. Don't import `@playwright/test` in test files. Page steps are plain Playwright, and labels, routes and contract addresses belong to your app. Stardust never deploys contracts, so tests import the addresses the app already uses.

The wallet answers prompts through the user's `policy`: `'approve'` (the default), `'reject'`, or `'manual'`, where the test calls `prompt.approve()` or `prompt.reject()`. The wallet also acts like a person would, with `switchAccount`, `switchNetwork`, `lock`, `unlock` and `disconnect`. The checks are `toInvoke`, `toHaveOperation`, `toLand`, `toFail`, `toChangeBalance` and `toEmit`.

## Run

```sh
stardust test                      # every test, browser hidden
stardust test e2e/swap.spec.ts     # one file
stardust test --show               # with the browser visible
stardust test -- --grep swap       # anything after -- goes to Playwright
```

```text
stardust  network  testnet (https://soroban-testnet.stellar.org, protocol 30) ready
stardust  browser  chromium ready
stardust  app      pnpm dev -> http://localhost:3000 ready
stardust  wallets  Varial 5.53.0, SEP-43 1.2.1, SEP-60 0.1.0

Running 1 test using 1 worker

  ✓  1 e2e/swap.spec.ts:13:1 › swaps 10 XLM (14.8s)

  1 passed (19.6s)

stardust  app      stopped
```

`--show` is Stardust's only flag. Any other flag before `--` stops the run and names the fix. When Stardust starts the app through `app.start`, it stops it at the end.

When a test fails, the terminal shows the failed check and the test's wallet timeline. `stardust-results/` keeps a screenshot, a trace and `stardust-timeline.json` for each failed test. Add it to `.gitignore`.

## Users and accounts

A user is one person: a browser tab (`page`), a `wallet` in it and the accounts in that wallet. A file declares its users once, and every test gets fresh ones, with new keys, new balances and new tabs. Every person in a test is a user, including someone who never opens the app:

```ts
test.use({
  stardust: {
    users: {
      payer: { wallet: 'varial', connected: true },
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
  await expect(prompt).toChangeBalance(
    friend.account.address,
    'native',
    xlm('5'),
  );
});
```

| Setting     | Default                    | Meaning                                                                                                       |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `wallet`    | `'varial'`                 | `'varial'`, `'sep60'`, or `'none'` for a browser without a wallet                                             |
| `connected` | `false`                    | Start as if the user already connected the site                                                               |
| `policy`    | `'approve'`                | `'approve'`, `'reject'`, `'manual'`, one of those per prompt kind, or a function                              |
| `accounts`  | `{ main: { fund: true } }` | The wallet's accounts by name. `fund` is `true` (100 XLM), an amount up to `'1000'`, or `false` (not created) |
| `allowHttp` | `true`                     | Whether the wallet signs on `http://` pages                                                                   |
| `strict`    | `true`                     | Fail the test when the app breaks wallet rules, such as leaving out the network passphrase                    |

The first account is active when the test starts, as `trader.account`. Every account is also reachable by name, for example `trader.accounts.savings`.

Accounts are funded from a testnet funder key that Stardust keeps in `~/.stardust/funders/`, readable only by you. Stardust creates it with Friendbot the first time a run needs it, and merges each test's accounts back afterwards to return their XLM.

## CI

```yaml
name: e2e
on: [pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: stardust-results
          path: stardust-results/
```

`pnpm/action-setup` takes the pnpm version from `packageManager` in package.json. With `CI=true`, which GitHub Actions sets, Stardust also installs Chromium's system libraries. A CI machine starts without a funder, so each run makes one Friendbot call.

## Safety

- Stardust never runs on mainnet. It refuses any network that reports the mainnet passphrase, and no setting turns this off.
- Secret keys stay in Node and never enter the page.
- Every account is a throwaway key generated for one test. Stardust never asks for a real key.

## Reference

[stardust.md](stardust.md) is the full reference: every option, prompt, check, error code and wallet behaviour. To work on Stardust itself, read [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
