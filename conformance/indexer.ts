import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Horizon,
  Networks,
  NotFoundError,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';
import type { BrowserContext, Request } from '@playwright/test';
import { formatXlm, xlm } from '@/amounts';

export interface Chain {
  readonly passphrase: string;
  readonly horizonUrl: string;
  readonly rpcUrl: string;
}

interface Answer {
  readonly status: number;
  readonly json: unknown;
}

type HorizonAccount = Awaited<ReturnType<Horizon.Server['loadAccount']>>;

// Varial's CI builds with this host when no backend is configured.
export const noIndexer = 'http://indexer.invalid';

// By Varial's network ID. Mainnet isn't here: the stand-in never reads it.
export const testnet: Chain = {
  passphrase: Networks.TESTNET,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  rpcUrl: 'https://soroban-testnet.stellar.org',
};

const chains: Readonly<Record<string, Chain>> = {
  TESTNET: testnet,
  FUTURENET: {
    passphrase: Networks.FUTURENET,
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
  },
};

// Backend settings, answered as Varial's own e2e stubs answer them.
const settings: Readonly<Record<string, unknown>> = {
  'feature-flags': { useSorobanPublic: true },
  'user-notification': { enabled: false, message: '' },
  'subscription/account': { data: {}, error: null },
};

const nullAccount = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const baseReserve = xlm('0.5');
const noErrors = { horizon: null, soroban: null };

// Answers Varial's backend requests from the network itself, the way Varial
// does on a custom network. context.route sees the popups and the service
// worker. Every other request fails, as it would without a backend.
export async function standInIndexer(context: BrowserContext): Promise<void> {
  await context.route(`${noIndexer}/**`, async (route) => {
    const request = route.request();
    const answer = await answerRequest(request).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Backend stand-in: ${request.url()} failed: ${message}`);
      return { status: 502, json: { error: message } };
    });
    await (answer ? route.fulfill(answer) : route.abort()).catch(
      () => undefined,
    );
  });
}

async function answerRequest(request: Request): Promise<Answer | null> {
  const url = new URL(request.url());
  const path = url.pathname.slice(1);
  const setting = settings[path];
  if (setting) return { status: 200, json: setting };
  if (path === 'submit-tx') return submit(request.postDataJSON());
  const chain = chains[url.searchParams.get('network') ?? ''];
  if (!chain) return null;
  const [endpoint, id = ''] = path.split('/');
  switch (endpoint) {
    case 'rpc-health':
      return rpcHealth(chain);
    case 'account-balances':
      return accountBalances(chain, id);
    case 'token-details':
      return tokenDetails(chain, id, url.searchParams);
    case 'is-sac-contract':
      return isSacContract(chain, id);
    default:
      return null;
  }
}

async function rpcHealth(chain: Chain): Promise<Answer> {
  const { status } = await new rpc.Server(chain.rpcUrl).getHealth();
  return { status: 200, json: { status } };
}

async function accountBalances(
  chain: Chain,
  publicKey: string,
): Promise<Answer> {
  const account = await new Horizon.Server(chain.horizonUrl)
    .loadAccount(publicKey)
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    });
  const json = account
    ? {
        balances: displayable(account),
        isFunded: true,
        subentryCount: account.subentry_count,
        error: noErrors,
      }
    : { balances: {}, isFunded: false, subentryCount: 0, error: noErrors };
  return { status: 200, json };
}

// Varial's makeDisplayableBalances, without liquidity pool shares.
function displayable(account: HorizonAccount): Record<string, unknown> {
  const balances: Record<string, unknown> = {};
  for (const line of account.balances) {
    if (line.asset_type === 'liquidity_pool_shares') continue;
    const total = xlm(line.balance);
    const selling = xlm(line.selling_liabilities);
    const amounts = {
      total: formatXlm(total),
      available: formatXlm(total - selling),
      sellingLiabilities: formatXlm(selling),
      buyingLiabilities: formatXlm(xlm(line.buying_liabilities)),
    };
    if (line.asset_type === 'native') {
      const reserves =
        2n +
        BigInt(account.subentry_count) +
        BigInt(account.num_sponsoring) -
        BigInt(account.num_sponsored);
      balances.native = {
        token: { type: 'native', code: 'XLM' },
        ...amounts,
        minimumBalance: formatXlm(reserves * baseReserve + selling),
      };
    } else {
      balances[`${line.asset_code}:${line.asset_issuer}`] = {
        token: {
          type: line.asset_type,
          code: line.asset_code,
          issuer: { key: line.asset_issuer },
        },
        ...amounts,
        limit: line.limit,
        ...(line.sponsor ? { sponsor: line.sponsor } : {}),
      };
    }
  }
  return balances;
}

async function tokenDetails(
  chain: Chain,
  contractId: string,
  query: URLSearchParams,
): Promise<Answer> {
  const read = (method: string, ...args: xdr.ScVal[]) =>
    simulate(chain, contractId, method, args);
  const [name, symbol, decimals] = await Promise.all([
    read('name'),
    read('symbol'),
    read('decimals'),
  ]);
  const holder = query.get('pub_key') ?? '';
  const balance =
    query.get('should_fetch_balance') === 'true' &&
    StrKey.isValidEd25519PublicKey(holder)
      ? await read('balance', new Address(holder).toScVal()).then(
          String,
          () => undefined,
        )
      : undefined;
  return {
    status: 200,
    json: { name, symbol, decimals, ...(balance ? { balance } : {}) },
  };
}

async function simulate(
  chain: Chain,
  contractId: string,
  method: string,
  args: readonly xdr.ScVal[],
): Promise<unknown> {
  const transaction = new TransactionBuilder(new Account(nullAccount, '0'), {
    fee: BASE_FEE,
    networkPassphrase: chain.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const result = await new rpc.Server(chain.rpcUrl).simulateTransaction(
    transaction,
  );
  if (rpc.Api.isSimulationError(result)) {
    throw new Error(`${contractId} ${method}() failed: ${result.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(result) || !result.result) {
    throw new Error(`${contractId} ${method}() returned nothing.`);
  }
  return scValToNative(result.result.retval);
}

async function isSacContract(
  chain: Chain,
  contractId: string,
): Promise<Answer> {
  const { entries } = await new rpc.Server(chain.rpcUrl).getLedgerEntries(
    new Contract(contractId).getFootprint(),
  );
  const [entry] = entries;
  if (entry?.val.type !== 'contractData') {
    return { status: 404, json: { error: `${contractId} isn't on chain.` } };
  }
  const { val } = entry.val.contractData;
  const isSac =
    val.type === 'scvContractInstance' &&
    val.instance.executable.type === 'contractExecutableStellarAsset';
  return { status: 200, json: { isSacContract: isSac } };
}

// Sent on to Horizon as the backend does, for testnet and futurenet only.
async function submit(body: unknown): Promise<Answer> {
  const { signed_xdr: envelope, network_passphrase: passphrase } = (body ??
    {}) as { signed_xdr?: unknown; network_passphrase?: unknown };
  const chain = Object.values(chains).find(
    (candidate) => candidate.passphrase === passphrase,
  );
  if (!chain || typeof envelope !== 'string') {
    return {
      status: 400,
      json: { error: 'The stand-in submits only to testnet and futurenet.' },
    };
  }
  const response = await fetch(`${chain.horizonUrl}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tx: envelope }),
  });
  return { status: response.status, json: await response.json() };
}
