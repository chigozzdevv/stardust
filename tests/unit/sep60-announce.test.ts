import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { version } from '@/../package.json';
import { pageScript } from '@/protocols/page-script';
import {
  providerInfo,
  sep43Version,
  sep60Version,
} from '@/protocols/sep60/sep60';
import type { ProviderInfo } from '@/protocols/sep60/sep60';
import { FakeWindow } from '@tests/helpers/page';
import { sep60, site } from '@tests/helpers/sep60';
import type { Signed } from '@tests/helpers/sep60';

interface Detail {
  readonly info: ProviderInfo;
  readonly provider: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

const binding = '__stardust';
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function announcer({ framed = false } = {}) {
  const bench = sep60({ policy: 'approve', connected: true });
  const top = framed ? new FakeWindow('https://parent.test/') : undefined;
  const window = new FakeWindow(`${site}/`, top);
  const announced: Detail[] = [];
  window.addEventListener('sep0060:announceProvider', (event) => {
    announced.push((event as CustomEvent<Detail>).detail);
  });
  window.expose(binding, (origin, payload) =>
    bench.wallet.handle(origin, payload),
  );
  window.run(pageScript({ wallet: 'sep60', binding, info: providerInfo }));
  const request = () =>
    window.dispatchEvent(new Event('sep0060:requestProvider'));
  return { ...bench, window, announced, request };
}

describe('versions', () => {
  it('match SEP-43 v1.2.1 and SEP-60 v0.1.0', () => {
    expect(sep43Version).toBe('1.2.1');
    expect(sep60Version).toBe('0.1.0');
  });
});

describe('announcement', () => {
  it('announces once ready, with the info SEP-60 asks for', () => {
    const { announced } = announcer();
    expect(announced).toHaveLength(1);
    const [{ info }] = announced as [Detail];
    expect(info).toEqual({
      uuid: expect.stringMatching(uuidV4),
      name: 'Stardust (test wallet)',
      icon: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
      rdns: 'io.github.stardust-stellar',
      version,
    });
    const svg = Buffer.from(info.icon.split(',')[1] ?? '', 'base64');
    expect(svg.toString()).toMatch(/^<svg [^>]*width="96" height="96"/);
    const label = '[a-z0-9]([a-z0-9-]*[a-z0-9])?';
    expect(info.rdns).toMatch(new RegExp(`^${label}(\\.${label})+$`));
  });

  it('freezes detail, info and provider', () => {
    const { announced } = announcer();
    const [detail] = announced as [Detail];
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail.info)).toBe(true);
    expect(Object.isFrozen(detail.provider)).toBe(true);
    expect(Object.keys(detail.provider).sort()).toEqual([
      'getAddress',
      'getNetwork',
      'signAuthEntry',
      'signMessage',
      'signTransaction',
    ]);
  });

  it('announces again with the same detail on every sep0060:requestProvider', () => {
    const { announced, request } = announcer();
    request();
    request();
    expect(announced).toHaveLength(3);
    expect(new Set(announced).size).toBe(1);
  });

  it('keeps one uuid per page session, and a new document gets a new one', () => {
    const first = announcer();
    const second = announcer();
    first.request();
    expect(first.announced[1]?.info.uuid).toBe(first.announced[0]?.info.uuid);
    expect(second.announced[0]?.info.uuid).not.toBe(
      first.announced[0]?.info.uuid,
    );
  });

  it('announces only in the top-level frame', () => {
    const { announced, request } = announcer({ framed: true });
    request();
    expect(announced).toEqual([]);
  });

  it('bridges provider methods to the wallet in Node', async () => {
    const { announced, state } = announcer();
    const [{ provider }] = announced as [Detail];
    await expect(provider.getNetwork?.()).resolves.toEqual({
      network: 'TESTNET',
      networkPassphrase: Networks.TESTNET,
    });
    await expect(provider.getAddress?.()).resolves.toEqual({
      address: state.address,
    });
    const signed = (await provider.signMessage?.('Sign in')) as Signed;
    expect(signed.signerAddress).toBe(state.address);
  });
});
