import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { WalletState, varialNetwork } from '@/wallet/state';
import { account, testnet } from '@tests/helpers/prompt-queue';

const app = 'http://localhost:3000';

function wallet(connected = false) {
  const accounts = [account(), account()];
  return {
    accounts,
    state: new WalletState({ accounts, network: testnet, connected }),
  };
}

describe('WalletState', () => {
  it('starts with the first account active and unlocked', () => {
    const { accounts, state } = wallet();
    expect(state.account).toBe(accounts[0]);
    expect(state.address).toBe(accounts[0]?.address);
    expect(state.network).toBe(testnet);
    expect(state.locked).toBe(false);
  });

  it("switches to another of the wallet's accounts", () => {
    const { accounts, state } = wallet();
    const [, second] = accounts;
    if (!second) throw new Error('no second account');
    state.switchAccount({ ...second });
    expect(state.account).toBe(second);
    expect(state.findAccount(second.address)).toBe(second);
  });

  it('refuses an account from outside the wallet with UNKNOWN_ACCOUNT', () => {
    const { accounts, state } = wallet();
    const stranger = account();
    expect(() => state.switchAccount(stranger)).toThrow(
      expect.objectContaining({
        code: 'UNKNOWN_ACCOUNT',
        message: `${stranger.address} isn't an account in this wallet, which holds ${accounts.map(({ address }) => address).join(', ')}. Pass one of this user's accounts.`,
      }),
    );
    expect(state.account).toBe(accounts[0]);
  });

  it('needs at least one account', () => {
    expect(() => new WalletState({ accounts: [], network: testnet })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('refuses to start on mainnet', () => {
    expect(
      () =>
        new WalletState({
          accounts: [account()],
          network: {
            ...testnet,
            name: 'mainnet',
            networkPassphrase: Networks.PUBLIC,
          },
        }),
    ).toThrow(expect.objectContaining({ code: 'MAINNET_REFUSED' }));
  });
});

describe('connected sites', () => {
  it('connects a hostname for the active account on the active network', () => {
    const { accounts, state } = wallet();
    const [, second] = accounts;
    if (!second) throw new Error('no second account');
    expect(state.isConnected(app)).toBe(false);

    state.connect(app);
    expect(state.isConnected(app)).toBe(true);
    expect(state.isConnected('http://localhost:5173')).toBe(true);
    expect(state.isConnected('https://localhost')).toBe(true);
    expect(state.isConnected('http://127.0.0.1:3000')).toBe(false);

    state.switchAccount(second);
    expect(state.isConnected(app)).toBe(false);
    state.switchNetwork('futurenet');
    expect(state.isConnected(app)).toBe(false);
    state.switchAccount(accounts[0] ?? second);
    expect(state.isConnected(app)).toBe(false);
    state.switchNetwork('testnet');
    expect(state.isConnected(app)).toBe(true);
  });

  it('with connected: true, connects every site for every account on the starting network only', () => {
    const { accounts, state } = wallet(true);
    const [, second] = accounts;
    if (!second) throw new Error('no second account');
    expect(state.isConnected(app)).toBe(true);
    expect(state.isConnected('https://example.com')).toBe(true);
    state.switchAccount(second);
    expect(state.isConnected(app)).toBe(true);
    state.switchNetwork('futurenet');
    expect(state.isConnected(app)).toBe(false);
  });

  it('disconnects one site, or every site of the active account and network', () => {
    const { accounts, state } = wallet(true);
    const [, second] = accounts;
    if (!second) throw new Error('no second account');

    state.disconnect(app);
    expect(state.isConnected(app)).toBe(false);
    expect(state.isConnected('https://example.com')).toBe(true);
    state.connect(app);
    expect(state.isConnected(app)).toBe(true);

    state.disconnect();
    expect(state.isConnected(app)).toBe(false);
    expect(state.isConnected('https://example.com')).toBe(false);
    state.switchAccount(second);
    expect(state.isConnected(app)).toBe(true);
  });
});

describe('networks', () => {
  it('reports the network it switched to, and the starting one when switched back', () => {
    const { state } = wallet();
    state.switchNetwork('futurenet');
    expect(state.network).toEqual({
      name: 'futurenet',
      rpcUrl: 'https://rpc-futurenet.stellar.org',
      networkPassphrase: Networks.FUTURENET,
      friendbotUrl: 'https://friendbot-futurenet.stellar.org/',
      protocolVersion: 30,
    });
    state.switchNetwork('mainnet');
    expect(state.network).toMatchObject({
      name: 'mainnet',
      networkPassphrase: Networks.PUBLIC,
      friendbotUrl: null,
    });
    state.switchNetwork('testnet');
    expect(state.network).toBe(testnet);
  });

  it("reports Varial's network details for testnet, futurenet and mainnet", () => {
    const { state } = wallet();
    expect(state.varialNetwork).toEqual({
      network: 'TESTNET',
      networkName: 'Test Net',
      networkUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org/',
      friendbotUrl: 'https://friendbot.stellar.org',
    });
    state.switchNetwork('futurenet');
    expect(state.varialNetwork).toEqual({
      network: 'FUTURENET',
      networkName: 'Future Net',
      networkUrl: 'https://horizon-futurenet.stellar.org',
      networkPassphrase: Networks.FUTURENET,
      sorobanRpcUrl: 'https://rpc-futurenet.stellar.org/',
      friendbotUrl: 'https://friendbot-futurenet.stellar.org',
    });
    state.switchNetwork('mainnet');
    expect(state.varialNetwork).toEqual({
      network: 'PUBLIC',
      networkName: 'Main Net',
      networkUrl: 'https://horizon.stellar.org',
      networkPassphrase: Networks.PUBLIC,
      sorobanRpcUrl: 'http://stellar-rpc-pubnet-prd:8000',
    });
  });

  it('reports testnet details for an { rpcUrl } network with the testnet passphrase', () => {
    expect(
      varialNetwork({ ...testnet, rpcUrl: 'http://localhost:8000/rpc' }),
    ).toMatchObject({ network: 'TESTNET', networkName: 'Test Net' });
  });

  it('reports a custom network the way Varial stores one added by hand', () => {
    const custom = {
      name: 'custom',
      rpcUrl: 'http://localhost:8000/rpc',
      networkPassphrase: 'Standalone Network ; February 2017',
      friendbotUrl: 'http://localhost:8000/friendbot',
      protocolVersion: 23,
    } as const;
    expect(varialNetwork(custom)).toEqual({
      network: 'STANDALONE',
      networkName: 'Custom Network',
      networkUrl: custom.rpcUrl,
      networkPassphrase: custom.networkPassphrase,
      sorobanRpcUrl: custom.rpcUrl,
      friendbotUrl: custom.friendbotUrl,
    });
    expect(varialNetwork({ ...custom, friendbotUrl: null })).toHaveProperty(
      'friendbotUrl',
      '',
    );
  });
});
