import { byId, onClick, run, say } from '@tests/test-app/src/dom';
import { network, verified } from '@tests/test-app/src/stellar';

type Reply<T> = T | { error: { code: number; message: string } };

interface Provider {
  getAddress(): Promise<Reply<{ address: string }>>;
  signMessage(
    message: string,
    opts: { networkPassphrase: string; address: string },
  ): Promise<Reply<{ signedMessage: string }>>;
}

interface Announcement {
  info: { uuid: string; name: string };
  provider: Provider;
}

declare global {
  interface WindowEventMap {
    'sep0060:announceProvider': CustomEvent<Announcement>;
  }
}

const install = byId('install', HTMLParagraphElement);
const announced = new Set<string>();
let wallet: { provider: Provider; address: string } | null = null;

window.addEventListener('sep0060:announceProvider', ({ detail }) => {
  const { info, provider } = detail;
  if (announced.has(info.uuid)) return;
  announced.add(info.uuid);
  install.hidden = true;
  const button = document.createElement('button');
  button.textContent = info.name;
  button.addEventListener('click', () => run(() => connect(provider)));
  byId('wallets', HTMLDivElement).append(button);
});
window.dispatchEvent(new Event('sep0060:requestProvider'));
setTimeout(() => {
  install.hidden = announced.size > 0;
}, 1000);

onClick('sign-message', async () => {
  if (!wallet) return;
  const { provider, address } = wallet;
  const text = byId('message', HTMLInputElement).value;
  const reply = await provider.signMessage(text, {
    networkPassphrase: network.passphrase,
    address,
  });
  if ('error' in reply) return say('Message not signed');
  const valid = verified(address, text, reply.signedMessage);
  say(valid ? 'Signature verified' : 'Signature invalid');
});

async function connect(provider: Provider): Promise<void> {
  const reply = await provider.getAddress();
  if ('error' in reply) return say('Connection rejected');
  wallet = { provider, address: reply.address };
  byId('address', HTMLParagraphElement).textContent = reply.address;
  byId('wallet', HTMLElement).hidden = false;
}
