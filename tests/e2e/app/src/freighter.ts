import {
  WatchWalletChanges,
  addToken,
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signMessage,
  signTransaction,
} from '@stellar/freighter-api';
import { CONTRACTS } from '@tests/e2e/app/src/contracts';
import { byId, onClick, run, say } from '@tests/e2e/app/src/dom';
import {
  network,
  payment,
  send,
  transfer,
  verified,
} from '@tests/e2e/app/src/stellar';

type Build = (from: string, to: string, amount: string) => Promise<string>;
type SignOptions = Parameters<typeof signTransaction>[1];

const recipient = byId('recipient', HTMLInputElement);
const amount = byId('amount', HTMLInputElement);
const message = byId('message', HTMLInputElement);
let address = '';

run(async () => {
  const saved = await getAddress();
  if (saved.address && (await onTestnet())) connected(saved.address);
});

onClick('connect', async () => {
  if (!(await isConnected()).isConnected) {
    byId('install', HTMLAnchorElement).hidden = false;
    return;
  }
  if (!(await onTestnet())) return;
  const access = await requestAccess();
  if (access.error) return say('Connection rejected');
  connected(access.address);
});

onClick('pay', () => sendTransaction(payment, 'Payment sent'));
onClick('transfer', () => sendTransaction(transfer, 'Transfer sent'));
onClick('pay-without-passphrase', () =>
  sendTransaction(payment, 'Payment sent', { address }),
);

onClick('sign-message', async () => {
  const text = message.value;
  const { signedMessage, error } = await signMessage(text, {
    networkPassphrase: network.passphrase,
    address,
  });
  if (error || typeof signedMessage !== 'string') {
    return say('Message not signed');
  }
  const valid = verified(address, text, signedMessage);
  say(valid ? 'Signature verified' : 'Signature invalid');
});

onClick('add-token', async () => {
  const { error } = await addToken({
    contractId: CONTRACTS.testnet.xlmToken,
    networkPassphrase: network.passphrase,
  });
  say(error ? 'Token not added' : 'Token added');
});

async function onTestnet(): Promise<boolean> {
  const { networkPassphrase } = await getNetworkDetails();
  if (networkPassphrase === network.passphrase) return true;
  say(`Switch your wallet to ${network.name}`);
  return false;
}

function connected(account: string): void {
  showAddress(account);
  byId('connect', HTMLButtonElement).hidden = true;
  byId('wallet', HTMLElement).hidden = false;
  new WatchWalletChanges().watch((changes) => {
    if (changes.address && changes.address !== address) {
      showAddress(changes.address);
    }
  });
}

function showAddress(account: string): void {
  address = account;
  byId('address', HTMLParagraphElement).textContent = account;
}

async function sendTransaction(
  build: Build,
  done: string,
  opts: SignOptions = { networkPassphrase: network.passphrase, address },
): Promise<void> {
  const xdr = await build(address, recipient.value, amount.value);
  const { signedTxXdr, error } = await signTransaction(xdr, opts);
  if (error) {
    return say(error.code === -4 ? 'Transaction cancelled' : error.message);
  }
  await send(signedTxXdr);
  say(done);
}
