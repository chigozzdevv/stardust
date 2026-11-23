import {
  BadgeCheck,
  Coins,
  FileSearch,
  MousePointerClick,
  SlidersHorizontal,
  Wallet,
} from 'lucide-react';

export const features = [
  {
    icon: Wallet,
    title: 'Real wallet behaviour',
    text: 'Varial and SEP-60 wallets, checked every night against the real Varial extension.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Any wallet state',
    text: 'No wallet, connected, locked, on the wrong network, or holding several accounts.',
  },
  {
    icon: Coins,
    title: 'Funded accounts',
    text: 'Fresh testnet accounts with XLM in every test, even in parallel.',
  },
  {
    icon: MousePointerClick,
    title: 'Prompts on your terms',
    text: 'Approve, reject, fail or ignore any prompt, with a policy or from the test.',
  },
  {
    icon: BadgeCheck,
    title: 'Checks on chain',
    text: 'Check contract calls, balance changes and events on the network.',
  },
  {
    icon: FileSearch,
    title: 'Clear failures',
    text: "A screenshot, a trace and the wallet's timeline for every failed test.",
  },
];
