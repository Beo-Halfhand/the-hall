// The cage contract in the browser. The page runs the circuit, and the wallet proves, balances, signs and submits.
// The player key stays in memory for the length of one call. Preprod only.
//
// Ledger 9 (11-09): Midnight.js 5 and DApp Connector API 4.1.0. Preprod forked in place at block 3,348,434, and cage4 was deployed
// before it, so it stays a ledger 8 contract: its deployed 0.31.1 build (runtime 0.16.0) runs here, passed as `new Contract(witnesses)`,
// with the verifier keys that are on chain. Its state now comes in the ledger 9 format and is decoded with the 0.21 runtime, then
// handed to the 0.16 build as plain encoded data. The wallet (Lace or 1AM) must be a build that speaks ledger 9 on preprod.

import './shims/buffer-global.js';
import * as runtime8 from '@midnight-ntwrk/compact-runtime'; // 0.16.0: the copy the cage's generated code imports
import { ContractState as ContractState9 } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime'; // 0.21.0
import { CostModel, Transaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { createUnprovenCallTx, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { dappConnectorProofProvider, dappConnectorWalletProviders } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';

import { Contract, ledger, pureCircuits } from './generated/index.js';
import { baseOf, findByPayout, readPlayer, toHex } from './cage-read.js';
import { memoryPrivateState } from './private-state.js';

const NETWORK = 'preprod';
const PRIVATE_STATE_ID = 'player';
const LANDED_WAIT_MS = 6 * 60 * 1000;

function fromHex(hex) {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('That is not hex.');
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

const witnesses = { secretKey: ({ privateState }) => [privateState, fromHex(privateState.sk)] };
// A ledger 8 contract goes to Midnight.js 5 as the generated instance, not wrapped in CompiledContract.make.
const contract = () => new Contract(witnesses);

/** The cage's ledger as its 0.16 build reads it, from a Midnight.js 5 contract-state read of either era. */
export function ledgerOfRead(read) {
  const state = read.contractState.deserialize({
    v8: { deserialize: (bytes) => runtime8.ContractState.deserialize(bytes).data.state },
    v9: { deserialize: (bytes) => runtime8.StateValue.decode(ContractState9.deserialize(bytes).data.state.encode()) },
  });
  return ledger(state);
}

/** A UserAddress for the contract, from the wallet's bech32 address. Refuses any address not on preprod. */
export function payoutFromAddress(address) {
  const decoded = MidnightBech32m.parse(address).decode(UnshieldedAddress, NETWORK);
  return { bytes: Uint8Array.from(decoded.data) };
}

export async function openCage({ api: firstApi, address, indexerHttp, indexerWs, walletAddress, zkBase, walletName = 'your wallet' }) {
  let api = firstApi;
  let sent = false;
  // midnight-js wraps what it catches and drops the connector's error code, so keep what the wallet actually said.
  let walletError = null;
  const fromWallet = async (ask) => {
    try { return await ask(); } catch (e) { walletError = e; throw e; }
  };
  const payout = payoutFromAddress(walletAddress);
  const payoutHex = toHex(payout.bytes);

  const privateStateProvider = memoryPrivateState();
  // 0.31.1 writes compiler/contract-info.json and no manifest, so a missing manifest only warns. The page's server must serve compiler/.
  const zkConfigProvider = new FetchZkConfigProvider(zkBase, { fetchFunc: fetch.bind(globalThis), verify: 'require-if-present' });
  const publicDataProvider = indexerPublicDataProvider({ queryURL: indexerHttp, subscriptionURL: indexerWs, webSocket: WebSocket });

  let say = () => {};
  let proofProvider = null;
  // Asked for at the first call, so that reading the cage works on a wallet that can't prove.
  async function ensureProver() {
    if (proofProvider) return proofProvider;
    if (typeof api.getProvingProvider !== 'function') throw new Error(`${walletName} can’t prove for a page. Update it if you can.`);
    const inner = await fromWallet(() => dappConnectorProofProvider(api, zkConfigProvider, CostModel.initialCostModel()));
    proofProvider = {
      supportedEras: inner.supportedEras, // Midnight.js 5 checks which ledger eras each provider serves before it proves
      proveTx: (tx, config) => {
        say(`Proving with ${walletName}. Approve there if it asks. This can take a few minutes.`);
        return fromWallet(() => inner.proveTx(tx, config));
      },
    };
    return proofProvider;
  }

  // The wallet side, through Midnight.js 5's DApp Connector providers (both eras). They see this narrow API, which keeps what the
  // page says to the player and what the wallet actually answered.
  const walletApi = {
    getShieldedAddresses: () => fromWallet(() => api.getShieldedAddresses()),
    balanceUnsealedTransaction: (tx, options) => {
      say(`Approve in ${walletName}.`);
      return fromWallet(() => api.balanceUnsealedTransaction(tx, options));
    },
    submitTransaction: async (tx) => {
      say(`${walletName} is sending it.`);
      sent = true; // from here it may land, even if the wallet then fails to answer
      await fromWallet(() => api.submitTransaction(tx));
      say('Sent. Waiting for a block.');
    },
  };
  const { walletProvider: wallet, midnightProvider } = await dappConnectorWalletProviders(walletApi);

  // The watch can outlast a person's patience, and a retry could pay twice, so it says what to do when it gives up.
  const watching = Object.create(publicDataProvider);
  watching.watchForTxData = (id) => Promise.race([
    publicDataProvider.watchForTxData(id),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Not on the indexer after 6 minutes. It may still land. Check your balance before you try again.')), LANDED_WAIT_MS);
    }),
  ]);

  const providersWith = (proof) => ({
    privateStateProvider, publicDataProvider: watching, zkConfigProvider, proofProvider: proof, walletProvider: wallet, midnightProvider,
    config: { networkId: NETWORK, ttlSeconds: 3600 },
  });

  async function ledgerNow() {
    const read = await publicDataProvider.queryContractState(address);
    if (!read) throw new Error(`No contract at ${address} on preprod.`);
    return ledgerOfRead(read);
  }

  return {
    payoutOf: () => ({ bytes: Uint8Array.from(payout.bytes) }),

    /** After the wallet drops the page and connect() runs again. The old prover went with the old connection. */
    useApi(next) { api = next; proofProvider = null; },

    /** Whether the latest call reached the wallet's submit. If so it must never be run again on its own. */
    sent: () => sent,

    async read(skHex) {
      const L = await ledgerNow();
      if (!skHex) return { ...baseOf(L), id: null, balance: 0n, seat: null, table: null, permit: null, bound: false, ours: false };
      return readPlayer(L, pureCircuits.playerId(fromHex(skHex)), payoutHex);
    },

    /** Every player id whose withdrawals are fixed to this wallet. The cage's payout list is public. */
    async findByAddress() {
      return findByPayout(await ledgerNow(), payoutHex);
    },

    async call(circuitId, skHex, args, progress = () => {}) {
      say = progress;
      sent = false;
      walletError = null;
      try {
        say('Running the circuit.');
        const proof = await ensureProver();
        await privateStateProvider.forContract(address).set(PRIVATE_STATE_ID, { sk: skHex });
        const r = await submitCallTx(providersWith(proof), {
          compiledContract: contract(), contractAddress: address, circuitId, privateStateId: PRIVATE_STATE_ID, args,
        });
        return r.public;
      } catch (e) {
        const d = e?.record ?? e?.finalizedTxData; // Midnight.js 5: TxFailedError.record (4.1.1: finalizedTxData)
        if (d && (e?.name === 'TxFailedError' || e?.finalizedTxData)) {
          throw new Error(`It landed but the cage refused it (${d.status}). The fee was spent and your balance didn’t change. Transaction ${d.txHash ?? d.txId ?? '?'}`);
        }
        throw walletError ?? e;
      } finally {
        say = () => {};
        await privateStateProvider.forContract(address).remove(PRIVATE_STATE_ID);
      }
    },

    /** Asks the wallet to balance a call without paying the fee, then counts tDUST spends. Sends nothing. */
    async probeNoDust(circuitId, skHex, args, progress = () => {}) {
      say = progress;
      walletError = null;
      try {
        say('Running the circuit.');
        const proof = await ensureProver();
        await privateStateProvider.forContract(address).set(PRIVATE_STATE_ID, { sk: skHex });
        const built = await createUnprovenCallTx(providersWith(proof), {
          compiledContract: contract(), contractAddress: address, circuitId, privateStateId: PRIVATE_STATE_ID, args,
        });
        const unbound = await proof.proveTx(built.private.unprovenTx);
        say(`Approve in ${walletName}. Nothing will be sent.`);
        const balanced = await fromWallet(() => api.balanceUnsealedTransaction(toHex(unbound.serialize()), { payFees: false }));
        const tx = Transaction.deserialize('signature', 'proof', 'binding', fromHex(balanced.tx));
        let dustSpends = 0;
        for (const [, intent] of tx.intents ?? []) dustSpends += intent.dustActions?.spends?.length ?? 0;
        return { dustSpends };
      } catch (e) {
        throw walletError ?? e;
      } finally {
        say = () => {};
        await privateStateProvider.forContract(address).remove(PRIVATE_STATE_ID);
      }
    },
  };
}
