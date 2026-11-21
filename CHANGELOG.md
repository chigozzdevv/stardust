# Changelog

## Unreleased

The first release. It matches Varial 5.53.0, SEP-43 1.2.1 and SEP-60 0.1.0.

- `stardust test` runs Playwright tests against your app in Chromium. It installs Chromium if it's missing, starts and stops the app through `app.start`, and passes anything after `--` to Playwright.
- `stardust-stellar/test` gives each test its users, each with a browser tab, a wallet and fresh testnet accounts funded from the machine's funder and merged back afterwards.
- The emulated wallets: `'varial'`, through Varial's message protocol, for `@stellar/freighter-api` 6.x, `@stellar/varial-sdk` 7.x and Stellar Wallets Kit 2.7 and 2.8; `'sep60'`, announced through SEP-60 and implementing SEP-43; and `'none'`.
- Prompts answered through policies (`'approve'`, `'reject'`, `'manual'` or a function), and user actions: `switchAccount`, `switchNetwork`, `lock`, `unlock` and `disconnect`.
- Checks: `toInvoke`, `toHaveOperation`, `toLand`, `toFail`, `toChangeBalance` and `toEmit`, with the wallet timeline, a screenshot and a trace for each failed test.
- Strict mode, which fails a test when the app breaks wallet rules.
- Safety: Stardust refuses mainnet, keeps secret keys in Node, and takes the origin from the browser.
