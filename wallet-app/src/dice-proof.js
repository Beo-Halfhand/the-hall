// dice-proof in the browser: the contract that checks a Cup & Claim table's dice. The page runs the circuit, and the wallet proves, balances,
// signs and submits. The seed and the key stay in memory for the length of one call. Preprod only. Same path as cage.js.

// Ledger 9 (11-09): Midnight.js 5, DApp Connector API 4.1.0. dice-proof was deployed before the fork, so it stays a ledger 8
// contract on its deployed 0.31.1 build, as in cage.js.

import './shims/buffer-global.js';
import * as runtime8 from '@midnight-ntwrk/compact-runtime'; // 0.16.0: the copy the generated code imports
import { ContractState as ContractState9 } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { CostModel } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { dappConnectorProofProvider, dappConnectorWalletProviders } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { Contract, ledger } from './generated-dice/index.js';
import { memoryPrivateState } from './private-state.js';

const NETWORK = 'preprod';
const STATE_ID = 'cup';
const LANDED_WAIT_MS = 6 * 60 * 1000;
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));

const witnesses = {
  seatKey: ({ privateState }) => [privateState, privateState.sk ?? new Uint8Array(32)],
  cupSeed: ({ privateState }) => [privateState, privateState.seed ?? new Uint8Array(32)],
};
const contract = () => new Contract(witnesses); // a ledger 8 contract: the generated instance, not CompiledContract.make

export async function openDiceProof({ api, address, indexerHttp, indexerWs, zkBase, walletName = 'your wallet' }) {
  let walletError = null;
  const fromWallet = async (ask) => { try { return await ask(); } catch (e) { walletError = e; throw e; } };
  const privateStateProvider = memoryPrivateState();
  const zkConfigProvider = new FetchZkConfigProvider(zkBase, { fetchFunc: fetch.bind(globalThis), verify: 'require-if-present' });
  const publicDataProvider = indexerPublicDataProvider({ queryURL: indexerHttp, subscriptionURL: indexerWs, webSocket: WebSocket });
  let say = () => {};
  let proofProvider = null;
  async function prover() {
    if (proofProvider) return proofProvider;
    if (typeof api.getProvingProvider !== 'function') throw new Error(`${walletName} can’t prove for a page. Update it if you can.`);
    const inner = await fromWallet(() => dappConnectorProofProvider(api, zkConfigProvider, CostModel.initialCostModel()));
    proofProvider = { supportedEras: inner.supportedEras, proveTx: (tx, config) => { say(`Proving with ${walletName}. Approve there if it asks.`); return fromWallet(() => inner.proveTx(tx, config)); } };
    return proofProvider;
  }
  const { walletProvider: wallet, midnightProvider } = await dappConnectorWalletProviders({
    getShieldedAddresses: () => fromWallet(() => api.getShieldedAddresses()),
    balanceUnsealedTransaction: (tx, options) => { say(`Approve in ${walletName}.`); return fromWallet(() => api.balanceUnsealedTransaction(tx, options)); },
    submitTransaction: async (tx) => { say(`${walletName} is sending it.`); await fromWallet(() => api.submitTransaction(tx)); say('Sent. Waiting for a block.'); },
  });
  const watching = Object.create(publicDataProvider);
  watching.watchForTxData = (id) => Promise.race([
    publicDataProvider.watchForTxData(id),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('Not on the indexer after 6 minutes. It may still land.')), LANDED_WAIT_MS); }),
  ]);
  return {
    /** What the chain says about one round. Public: nothing from the server, and no key. */
    async readRound(table, round, seats) {
      const read = await publicDataProvider.queryContractState(address);
      if (!read) throw new Error(`No contract at ${address} on preprod.`);
      const L = ledger(read.contractState.deserialize({
        v8: { deserialize: (bytes) => runtime8.ContractState.deserialize(bytes).data.state },
        v9: { deserialize: (bytes) => runtime8.StateValue.decode(ContractState9.deserialize(bytes).data.state.encode()) },
      }));
      const id = { table: BigInt(table), round: BigInt(round) };
      if (!L.rounds.member(id)) return null;
      const r = L.rounds.lookup(id);
      const cup = (seat) => ({ ...id, seat: BigInt(seat) });
      return {
        bidder: Number(r.bidder), caller: Number(r.caller), bidCount: Number(r.bidCount), bidFace: Number(r.bidFace),
        seats: Object.fromEntries(seats.map((seat) => {
          const c = cup(seat);
          const h = L.holders.member(c) ? L.holders.lookup(c) : null;
          return [seat, { houseRun: L.houseRun.member(c), holder: h ? toHex(h.key) : null, preseal: h ? toHex(h.preseal) : null }];
        })),
      };
    },

    async call(circuitId, privateState, args, progress = () => {}) {
      say = progress;
      walletError = null;
      try {
        say('Running the circuit.');
        const proof = await prover();
        await privateStateProvider.forContract(address).set(STATE_ID, privateState);
        const r = await submitCallTx({ privateStateProvider, publicDataProvider: watching, zkConfigProvider, proofProvider: proof, walletProvider: wallet, midnightProvider, config: { networkId: NETWORK, ttlSeconds: 3600 } }, { compiledContract: contract(), contractAddress: address, circuitId, privateStateId: STATE_ID, args });
        return r.public;
      } catch (e) {
        const d = e?.record ?? e?.finalizedTxData;
        if (d && (e?.name === 'TxFailedError' || e?.finalizedTxData)) throw new Error(`It landed but the contract refused it (${d.status}). The fee was spent. Transaction ${d.txHash ?? '?'}`);
        throw walletError ?? e;
      } finally {
        say = () => {};
        await privateStateProvider.forContract(address).remove(STATE_ID);
      }
    },
  };
}
