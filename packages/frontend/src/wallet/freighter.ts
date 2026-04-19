/**
 * Wallet connection API. Thin wrapper over @stellar/freighter-api.
 *
 * All Freighter calls return `{ ...result, error? }` — we surface the
 * error as thrown exceptions so callers can use try/catch / toast.
 */

import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
  setAllowed,
} from "@stellar/freighter-api";

export interface ConnectedWallet {
  address: string;
  networkPassphrase: string;
  network: string;
}

export async function isFreighterInstalled(): Promise<boolean> {
  try {
    const r = await isConnected();
    return Boolean(r.isConnected);
  } catch {
    return false;
  }
}

export async function connectWallet(): Promise<ConnectedWallet> {
  const installed = await isFreighterInstalled();
  if (!installed) {
    throw new Error("Freighter wallet not detected. Install from freighter.app.");
  }

  // Prompt the user for access if not yet granted.
  const access = await requestAccess();
  if (access.error) {
    throw new Error(`Wallet access denied: ${String(access.error)}`);
  }
  await setAllowed();

  const addr = access.address ? { address: access.address } : await getAddress();
  if (!addr.address) {
    throw new Error("No address returned from Freighter");
  }

  const net = await getNetwork();
  if (net.error) {
    throw new Error(`getNetwork failed: ${String(net.error)}`);
  }

  return {
    address: addr.address,
    networkPassphrase: net.networkPassphrase,
    network: net.network,
  };
}

export async function refreshWallet(): Promise<ConnectedWallet | null> {
  try {
    const addr = await getAddress();
    if (!addr.address) return null;
    const net = await getNetwork();
    if (net.error) return null;
    return {
      address: addr.address,
      networkPassphrase: net.networkPassphrase,
      network: net.network,
    };
  } catch {
    return null;
  }
}
