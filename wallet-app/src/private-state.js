// In-memory private state for the wallet page's contracts, in Midnight.js 5's shape (11-09). Nothing goes to disk, so there's no password.

/** One view per contract (Midnight.js 5's forContract). */
export function memoryPrivateState() {
  const byContract = new Map();
  const signingKeys = new Map();
  const view = (contractAddress) => {
    const key = String(contractAddress).toLowerCase();
    if (!byContract.has(key)) byContract.set(key, new Map());
    const states = byContract.get(key);
    return {
      contractAddress: key,
      async set(id, value) { states.set(id, value); },
      async get(id) { return states.has(id) ? states.get(id) : null; },
      async remove(id) { states.delete(id); },
      async clear() { states.clear(); },
      async exportPrivateStates() { throw new Error('Nothing to export: the page keeps no private state.'); },
      async importPrivateStates() { throw new Error('Nothing to import: the page keeps no private state.'); },
    };
  };
  return {
    forContract: view,
    async clearAll() { byContract.clear(); },
    async setSigningKey(address, key) { signingKeys.set(String(address).toLowerCase(), key); },
    async getSigningKey(address) { return signingKeys.get(String(address).toLowerCase()) ?? null; },
    async removeSigningKey(address) { signingKeys.delete(String(address).toLowerCase()); },
    async clearSigningKeys() { signingKeys.clear(); },
    async exportSigningKeys() { throw new Error('Nothing to export.'); },
    async importSigningKeys() { throw new Error('Nothing to import.'); },
  };
}

