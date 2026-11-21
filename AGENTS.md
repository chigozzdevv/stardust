# AGENTS.md

Instructions for coding agents working in this repository.

## Project

Stardust (npm package `stardust-stellar`) is an end-to-end testing toolkit for Stellar dapps. A test drives the dapp in Chromium through Playwright, and Stardust plays the wallet: it puts an emulated Varial (formerly Freighter) or SEP-60/SEP-43 wallet in the page, creates funded throwaway accounts on testnet, answers wallet prompts through policies or the test, signs in Node, and checks what landed on the network.

The specification, `stardust.md`, is kept out of git: it's in `.gitignore`, so only some copies of the repository have it. Never commit it. Where it exists, it's the source of truth. Behaviour, API names, types, error codes, CLI output and safety rules come from it. When the code and the spec disagree, fix the code or ask the user; don't change the spec on your own.

This is a single TypeScript ESM package with two entries, `stardust-stellar` and `stardust-stellar/test`, and the `stardust` command.

## Layout

| Path               | Contents                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `src`              | `index.ts` (the `stardust-stellar` entry), `errors.ts`, `amounts.ts`.                     |
| `src/config`       | `defineConfig`, `StardustConfig`, loading and validating `stardust.config.ts`.            |
| `src/cli`          | The `stardust test` command: arguments, Chromium install, app start and stop, Playwright. |
| `src/network`      | RPC, health checks and the mainnet guard, transaction landing, events to balance changes. |
| `src/funding`      | Test accounts, the machine's funder and sub-funders, the funder's lock file.              |
| `src/contracts`    | Contract spec fetch and cache, the built-in Stellar Asset Contract spec.                  |
| `src/wallet`       | The emulated wallet: state, prompts, policies, signer, decoder, strict mode.              |
| `src/protocols`    | In-page script, Wallets Kit session, Varial and SEP-60/SEP-43 message handling.           |
| `src/test`         | The `stardust-stellar/test` entry: `test`, `expect`, user fixtures, matchers, page host.  |
| `conformance`      | Comparison against the real Varial extension (spec section 11).                           |
| `tests/unit`       | Vitest unit tests, `*.test.ts`.                                                           |
| `tests/data`       | Golden Varial replies, SEP-53 vectors, recorded testnet responses.                        |
| `tests/helpers`    | Shared test code: fake ledger, RPC replay, fake page, envelopes, test benches.            |
| `tests/e2e`        | Stardust against a small dapp of our own on testnet: the specs, and the dapp in `app/`.   |
| `tests/dapps`      | Stardust on real dapps: each one's pinned commit (`dapp.json`), config and `e2e/` specs.  |
| `tests/api-report` | API Extractor configs and the public API reports of both entries, checked in CI.          |

## Commands

```sh
pnpm install --frozen-lockfile
pnpm build                # tsup, writes dist/
pnpm typecheck            # src and unit tests, then tests/e2e and tests/dapps against dist's types
pnpm lint                 # ESLint, zero warnings allowed
pnpm format               # Prettier, rewrites files
pnpm format:check         # Prettier
pnpm test                 # unit tests (Vitest)
pnpm test:e2e             # build, then stardust test on the dapp in tests/e2e/app on testnet
pnpm test:dapps           # build, then stardust test on each real dapp in tests/dapps/ on testnet
pnpm test:conformance     # the scenarios against real Varial and against Stardust
pnpm conformance:record   # the same, and writes Varial's replies to tests/data/varial/
pnpm api:check            # build, then fail if the public API differs from the reports in tests/api-report/
pnpm api:update           # build, then rewrite the reports in tests/api-report/
```

- Run `pnpm build` before `pnpm typecheck`. The e2e and dapp specs and their `stardust.config.ts` files import `stardust-stellar` from `dist`, so typecheck reads its type files.
- Some unit tests run in Chromium. Install it once with `pnpm exec playwright install chromium`.
- `pnpm test:e2e` sends real testnet transactions and funds every test's accounts through the machine funder in `~/.stardust/funders/`, which calls Friendbot when it's created or refilled. Pass a file to run only that one, for example `pnpm test:e2e pay.spec.ts`. Results, with screenshots and traces of failed tests, go to `tests/e2e/app/stardust-results/`.
- `pnpm test:dapps` packs Stardust, then for each folder in `tests/dapps/`: checks out the dapp's repository at the commit in `dapp.json` into `tests/dapps/.checkouts/<dapp>`, runs its `install`, installs the tarball with its `add`, runs its `build` if set, copies in `stardust.config.ts` and `e2e/`, and runs the dapp's own `stardust` command. Name dapps to run only those (`pnpm test:dapps blend`); other arguments go to `stardust test`. Run it on Node 22, as CI does. It funds accounts through the machine funder like `test:e2e`, and the nightly `dapps.yml` runs it. To move a dapp to a newer commit, change `commit` and check its specs still pass. Results go to `tests/dapps/.checkouts/<dapp>/stardust-results/`.
- `pnpm test:conformance` clones `stellar/freighter` at its latest release into `conformance/.varial/<tag>` and builds it with Yarn 4 (run `corepack enable yarn` once on Node 22). Set `VARIAL_TAG` to pin a release, and `INDEXER_URL` and `INDEXER_V2_URL` to use Varial's backend instead of the stub. The two Stellar Asset Contract `addToken` scenarios fund accounts through the machine funder. Results go to `conformance/stardust-results/`, and the nightly `conformance.yml` runs it in record mode.
- `pnpm conformance:record` (or `CONFORMANCE_RECORD=1`) writes Varial's replies to `tests/data/varial/<scenario>.json`, which `tests/unit/golden.test.ts` replays through Stardust. Commit only files a run recorded, after checking the run's differences. When the replies come from a new Varial release, change `varialVersion` in `src/protocols/varial/varial.ts` in the same commit; `golden.test.ts` fails while the two differ.
- `pnpm api:check` compares the public API of both entries with `tests/api-report/index.api.md` and `tests/api-report/test.api.md`, and on any difference prints it and fails. CI runs it. When you change the public API on purpose, run `pnpm api:update`, review the reports' diff, and commit the reports with the change.

## Releasing

1. Set `version` in `package.json`, and rename `## Unreleased` in `CHANGELOG.md` to the version and date. The entry names the Varial, SEP-43 and SEP-60 versions the release matches.
2. Commit both as `chore: release <version>`, then push a tag `v<version>` on that commit.
3. `publish.yml` runs CI on the tag, checks the tag matches `package.json`, and publishes to npm with provenance.

Never publish from a local machine, and never move or reuse a version tag.

## Conventions

- File names are kebab-case with at most 2 hyphens. Name a file after what it does (`network/rpc.ts`, `protocols/varial/handler.ts`), not after its folder. A folder's Zod schemas go in `schema.ts` in the same folder.
- Imports use the aliases `@/` (`src`) and `@tests/` (`tests`). ESLint rejects relative imports.
- Use `import type` for type-only imports.
- Identifiers are camelCase, matching the API in the spec.
- Prettier: single quotes, trailing commas. Run `pnpm format` after editing.
- Amounts are `bigint` stroops or token units, parsed from decimal strings with `xlm` and `units`. Never use floating point for amounts or fees.
- No top-level `await` in `src`. CommonJS projects load `stardust-stellar/test` with `require()`, which can't load a module that has one.
- Comment only when the code can't explain itself. No large comment blocks or banners.
- Public API types, functions and members get a short TSDoc comment, worded from the spec, when it says something the name and type don't: units, formats, defaults, behaviour, errors thrown. It's what users see when they hover in their editor. Don't add one that only repeats the name; the API report then shows the item as `(undocumented)`, which is fine.
- Unit tests go in `tests/unit`, test data in `tests/data`. Never hand-write data that claims to be recorded: golden Varial replies come from the conformance suite, RPC responses from real testnet calls.
- Commit messages use a type prefix: `feat:`, `fix:`, `refactor:`, `test:`, `doc:`, `chore:`.

## Safety rules

These come from section 9 of the spec. Do not weaken them.

- Never mainnet. The CLI and the fixtures refuse a network that reports the mainnet passphrase, nothing is signed for it, and there's no setting to turn this off.
- Secret keys stay in Node and never enter the page.
- The origin comes from the browser, through the binding's calling frame, never from the page's message.
- Only same-window messages are answered.
- Every wire message is validated against a schema, in both directions.
- A transaction not seen in time is `OUTCOME_UNKNOWN`, never "failed".
- Accounts are throwaway keys generated per test. Stardust never asks for a real key.

## Secrets and funder state

- `~/.stardust/funders/` holds the machine's testnet funder key. Never print, copy or delete it. Unit tests point the funder at a temporary folder.
- Do not remove a funder lock file without confirming its process has exited.
- Testnet Friendbot is rate limited. Never call it in a loop, and don't retry a funding request whose outcome is unresolved.

## Before you finish

Run the checks that cover what you changed, in this order: at least `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm api:check`.
