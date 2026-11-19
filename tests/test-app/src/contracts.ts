import { Asset, Networks } from '@stellar/stellar-sdk';

export const CONTRACTS = {
  testnet: {
    xlmToken: Asset.native().contractId(Networks.TESTNET),
  },
};
