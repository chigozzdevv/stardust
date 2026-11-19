import { Networks } from '@stellar/stellar-sdk';
import { StardustError } from '@/errors';
import type { Account } from '@/funding/accounts';
import { refuseMainnet, resolveNetwork } from '@/network/network';
import type { NetworkInfo } from '@/network/network';

export type NetworkName = 'testnet' | 'futurenet' | 'mainnet';

export interface VarialNetwork {
  readonly network: string;
  readonly networkName: string;
  readonly networkUrl: string;
  readonly networkPassphrase: string;
  readonly sorobanRpcUrl: string;
  readonly friendbotUrl?: string;
}

export interface WalletStateOptions {
  readonly accounts: readonly Account[];
  readonly network: NetworkInfo;
  readonly connected?: boolean;
}

interface KnownNetwork {
  readonly info: Omit<NetworkInfo, 'protocolVersion'>;
  readonly varial: VarialNetwork;
}

const known: Record<NetworkName, KnownNetwork> = {
  testnet: {
    info: {
      name: 'testnet',
      rpcUrl: resolveNetwork('testnet'),
      networkPassphrase: Networks.TESTNET,
      friendbotUrl: 'https://friendbot.stellar.org/',
    },
    varial: {
      network: 'TESTNET',
      networkName: 'Test Net',
      networkUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org/',
      friendbotUrl: 'https://friendbot.stellar.org',
    },
  },
  futurenet: {
    info: {
      name: 'futurenet',
      rpcUrl: 'https://rpc-futurenet.stellar.org',
      networkPassphrase: Networks.FUTURENET,
      friendbotUrl: 'https://friendbot-futurenet.stellar.org/',
    },
    varial: {
      network: 'FUTURENET',
      networkName: 'Future Net',
      networkUrl: 'https://horizon-futurenet.stellar.org',
      networkPassphrase: Networks.FUTURENET,
      sorobanRpcUrl: 'https://rpc-futurenet.stellar.org/',
      friendbotUrl: 'https://friendbot-futurenet.stellar.org',
    },
  },
  mainnet: {
    info: {
      name: 'mainnet',
      rpcUrl: 'http://stellar-rpc-pubnet-prd:8000',
      networkPassphrase: Networks.PUBLIC,
      friendbotUrl: null,
    },
    varial: {
      network: 'PUBLIC',
      networkName: 'Main Net',
      networkUrl: 'https://horizon.stellar.org',
      networkPassphrase: Networks.PUBLIC,
      sorobanRpcUrl: 'http://stellar-rpc-pubnet-prd:8000',
    },
  },
};

export class WalletState {
  readonly accounts: readonly Account[];
  locked = false;
  private active: Account;
  private current: NetworkInfo;
  private readonly initial: NetworkInfo;
  private readonly sites = new Set<string>();
  private readonly everySite = new Set<string>();
  private readonly removed = new Set<string>();

  constructor({ accounts, network, connected = false }: WalletStateOptions) {
    const [first] = accounts;
    if (!first) {
      throw new StardustError(
        'CONFIG_INVALID',
        'a wallet needs at least one account. Pass accounts: [account], where the first account is the active one.',
      );
    }
    refuseMainnet(network.networkPassphrase);
    this.accounts = accounts;
    this.active = first;
    this.initial = network;
    this.current = network;
    if (connected) {
      for (const { address } of accounts) {
        this.everySite.add(scopeKey(network.name, address));
      }
    }
  }

  get account(): Account {
    return this.active;
  }

  get address(): string {
    return this.active.address;
  }

  get network(): NetworkInfo {
    return this.current;
  }

  get varialNetwork(): VarialNetwork {
    return varialNetwork(this.current);
  }

  findAccount(address: string): Account | undefined {
    return this.accounts.find((account) => account.address === address);
  }

  switchAccount({ address }: Account): void {
    const account = this.findAccount(address);
    if (!account) {
      throw new StardustError(
        'UNKNOWN_ACCOUNT',
        `${address} isn't an account in this wallet, which holds ${this.accounts.map((held) => held.address).join(', ')}. Pass one of this user's accounts.`,
      );
    }
    this.active = account;
  }

  switchNetwork(name: NetworkName): void {
    this.current =
      name === this.initial.name
        ? this.initial
        : {
            ...known[name].info,
            protocolVersion: this.initial.protocolVersion,
          };
  }

  isConnected(origin: string): boolean {
    const site = this.siteKey(origin);
    return (
      this.sites.has(site) ||
      (this.everySite.has(this.scope) && !this.removed.has(site))
    );
  }

  connect(origin: string): void {
    const site = this.siteKey(origin);
    this.sites.add(site);
    this.removed.delete(site);
  }

  disconnect(origin?: string): void {
    if (origin !== undefined) {
      const site = this.siteKey(origin);
      this.sites.delete(site);
      if (this.everySite.has(this.scope)) this.removed.add(site);
      return;
    }
    const prefix = `${this.scope}\n`;
    for (const site of this.sites) {
      if (site.startsWith(prefix)) this.sites.delete(site);
    }
    this.everySite.delete(this.scope);
  }

  private get scope(): string {
    return scopeKey(this.current.name, this.active.address);
  }

  private siteKey(origin: string): string {
    return `${this.scope}\n${URL.parse(origin)?.hostname || origin}`;
  }
}

export function varialNetwork(network: NetworkInfo): VarialNetwork {
  const match = Object.values(known).find(
    ({ info }) => info.networkPassphrase === network.networkPassphrase,
  );
  if (match) return match.varial;
  return {
    network: 'STANDALONE',
    networkName: 'Custom Network',
    networkUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
    sorobanRpcUrl: network.rpcUrl,
    friendbotUrl: network.friendbotUrl ?? '',
  };
}

function scopeKey(network: string, address: string): string {
  return `${network}\n${address}`;
}
