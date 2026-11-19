import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import type { PromptRef } from '@/wallet/prompts';
import { Violations, pendingReport } from '@/wallet/strict';

const p2: PromptRef = { id: 'p2', kind: 'signTransaction' };
const p3: PromptRef = { id: 'p3', kind: 'addToken' };
const signer = 'GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV';
const active = 'GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH';

describe('Violations', () => {
  it('reports a network mismatch exactly as the spec shows it', () => {
    const violations = new Violations();
    violations.networkMismatch(
      p2,
      Networks.FUTURENET,
      Networks.TESTNET,
      'varial',
    );
    const report = violations.report();
    expect(report).toMatchObject({ code: 'PROTOCOL_VIOLATION' });
    expect(report?.message).toBe(
      [
        'Stardust: 1 protocol violation in this test',
        '  p2 signTransaction  networkMismatch',
        '  The app asked to sign for "Test SDF Future Network ; October 2022",',
        '  but the wallet is on "Test SDF Network ; September 2015".',
        '  Varial refuses this, so Stardust refused it too.',
      ].join('\n'),
    );
    expect(violations.list()).toEqual([
      {
        promptId: 'p2',
        kind: 'networkMismatch',
        detail: [
          'The app asked to sign for "Test SDF Future Network ; October 2022",',
          'but the wallet is on "Test SDF Network ; September 2015".',
          'Varial refuses this, so Stardust refused it too.',
        ].join('\n'),
      },
    ]);
  });

  it('words a mismatch for addToken, an unknown network and the sep60 wallet', () => {
    const violations = new Violations();
    violations.networkMismatch(p3, Networks.PUBLIC, Networks.TESTNET, 'sep60');
    violations.networkMismatch(
      { id: 'p4', kind: 'signAuthEntry' },
      null,
      Networks.TESTNET,
      'varial',
    );
    expect(violations.list().map(({ detail }) => detail)).toEqual([
      [
        'The app asked to add a token on "Public Global Stellar Network ; September 2015",',
        'but the wallet is on "Test SDF Network ; September 2015".',
        'A real wallet refuses this, so Stardust refused it too.',
      ].join('\n'),
      [
        'The app asked to sign for an unknown network,',
        'but the wallet is on "Test SDF Network ; September 2015".',
        'Varial refuses this, so Stardust refused it too.',
      ].join('\n'),
    ]);
  });

  it('records a missing passphrase instead of, not as well as, a network mismatch', () => {
    const before = new Violations();
    before.missingNetworkPassphrase(p2, Networks.TESTNET);
    before.networkMismatch(p2, Networks.PUBLIC, Networks.TESTNET, 'varial');
    const after = new Violations();
    after.networkMismatch(p2, Networks.PUBLIC, Networks.TESTNET, 'varial');
    after.missingNetworkPassphrase(p2, Networks.TESTNET);

    const expected = {
      promptId: 'p2',
      kind: 'missingNetworkPassphrase',
      detail: [
        'The app sent signTransaction without networkPassphrase, so Varial reads it as mainnet.',
        `Pass the passphrase of the wallet's network, "Test SDF Network ; September 2015".`,
      ].join('\n'),
    };
    expect(before.list()).toEqual([expected]);
    expect(after.list()).toEqual([expected]);
  });

  it('keeps network mismatches of other prompts', () => {
    const violations = new Violations();
    violations.networkMismatch(p3, Networks.PUBLIC, Networks.TESTNET, 'varial');
    violations.missingNetworkPassphrase(p2, Networks.TESTNET);
    expect(violations.list().map(({ kind }) => kind)).toEqual([
      'networkMismatch',
      'missingNetworkPassphrase',
    ]);
  });

  it('records invalid XDR, signer mismatches and unknown messages', () => {
    const violations = new Violations();
    violations.invalidXdr(null, 'transactionXdr', new Error('XDR Read Error'));
    violations.signerMismatch(p2, signer, active);
    violations.unknownMessage('REQUEST_EVERYTHING');

    expect(violations.list()).toEqual([
      {
        promptId: null,
        kind: 'invalidXdr',
        detail: [
          "The app sent a transactionXdr that isn't valid XDR: XDR Read Error.",
          'Send it as base64 XDR, for example from toXDR().',
        ].join('\n'),
      },
      {
        promptId: 'p2',
        kind: 'signerMismatch',
        detail: [
          `The app asked for a signature from ${signer},`,
          `but the wallet signs with ${active}.`,
          'Use the address the wallet reports from getAddress().',
        ].join('\n'),
      },
      {
        promptId: null,
        kind: 'unknownMessage',
        detail: [
          "The app sent a message of type 'REQUEST_EVERYTHING', which Varial doesn't recognize.",
          'Use a message type that @stellar/freighter-api or @stellar/varial-sdk sends.',
        ].join('\n'),
      },
    ]);
  });

  it('lists every violation in the report, one block each', () => {
    const violations = new Violations();
    violations.unknownMessage(42);
    violations.signerMismatch(p2, signer, active);
    expect(violations.report()?.message).toBe(
      [
        'Stardust: 2 protocol violations in this test',
        '  unknownMessage',
        "  The app sent a message of type 42, which Varial doesn't recognize.",
        '  Use a message type that @stellar/freighter-api or @stellar/varial-sdk sends.',
        '',
        '  p2 signTransaction  signerMismatch',
        `  The app asked for a signature from ${signer},`,
        `  but the wallet signs with ${active}.`,
        '  Use the address the wallet reports from getAddress().',
      ].join('\n'),
    );
  });

  it('reports nothing without violations', () => {
    expect(new Violations().report()).toBeNull();
    expect(new Violations().list()).toEqual([]);
  });
});

describe('pendingReport', () => {
  it('reports an unanswered prompt exactly as the spec shows it', () => {
    const report = pendingReport([p2]);
    expect(report).toMatchObject({ code: 'PROMPTS_PENDING', retryable: false });
    expect(report?.message).toBe(
      [
        'Stardust: test ended with 1 unanswered prompt',
        '  p2 signTransaction (pending)',
        '  Call approve(), reject(), fail() or hang() before the test ends.',
      ].join('\n'),
    );
  });

  it('lists every unanswered prompt', () => {
    expect(pendingReport([p2, p3])?.message).toBe(
      [
        'Stardust: test ended with 2 unanswered prompts',
        '  p2 signTransaction (pending)',
        '  p3 addToken (pending)',
        '  Call approve(), reject(), fail() or hang() before the test ends.',
      ].join('\n'),
    );
  });

  it('reports nothing when every prompt was answered', () => {
    expect(pendingReport([])).toBeNull();
  });
});
