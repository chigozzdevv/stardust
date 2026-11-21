import {
  VARIAL_ID,
  VarialModule,
} from '@creit.tech/stellar-wallets-kit/modules/varial';
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { Networks } from '@creit.tech/stellar-wallets-kit/types';
import { byId, onClick, run } from '@tests/e2e/app/src/dom';

StellarWalletsKit.init({
  modules: [new VarialModule()],
  network: Networks.TESTNET,
});

run(async () => {
  const saved = await StellarWalletsKit.getAddress().catch(() => null);
  if (saved) connected(saved.address);
});

onClick('connect', async () => {
  StellarWalletsKit.setWallet(VARIAL_ID);
  connected((await StellarWalletsKit.fetchAddress()).address);
});

function connected(address: string): void {
  byId('address', HTMLParagraphElement).textContent = address;
  byId('connect', HTMLButtonElement).hidden = true;
}
