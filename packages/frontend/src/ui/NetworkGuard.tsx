/**
 * NetworkGuard — red warning banner shown when the Freighter wallet is
 * connected to a different Stellar network than the one the app is configured
 * for (VITE_NETWORK_PASSPHRASE).
 *
 * When a mismatch is detected:
 *   • A dismissible red banner is shown at the top of the page.
 *   • An `disabled` prop is exported so callers can disable the OrderForm.
 *
 * Usage:
 *   <NetworkGuard />                    // just the banner
 *   const { networkMismatch } = useNetworkGuard();  // for disabling forms
 */

import { useWallet } from "@/wallet";
import { config } from "@/config";

export function useNetworkGuard(): { networkMismatch: boolean } {
  const { status, networkPassphrase } = useWallet();
  if (status !== "connected" || networkPassphrase === null) {
    return { networkMismatch: false };
  }
  return {
    networkMismatch: networkPassphrase !== config.network.passphrase,
  };
}

export function NetworkGuard() {
  const { networkMismatch } = useNetworkGuard();
  const { networkPassphrase } = useWallet();

  if (!networkMismatch) return null;

  // Derive a human-readable name for the expected network.
  const expectedName = config.network.passphrase.includes("Test SDF Network")
    ? "Stellar Testnet"
    : config.network.passphrase.includes("Public Global")
      ? "Stellar Mainnet"
      : config.network.passphrase.slice(0, 32) + "…";

  // Derive what the wallet is actually on.
  const actualName =
    networkPassphrase?.includes("Test SDF Network")
      ? "Stellar Testnet"
      : networkPassphrase?.includes("Public Global")
        ? "Stellar Mainnet"
        : (networkPassphrase ?? "Unknown network");

  return (
    <div className="flex items-center gap-3 border border-stella-short/30 bg-stella-short/10 px-4 py-2.5 text-[12px] text-stella-short">
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>
      <span>
        <strong>Wrong network:</strong> your Freighter wallet is on{" "}
        <span className="font-semibold">{actualName}</span> but this app requires{" "}
        <span className="font-semibold">{expectedName}</span>. Switch networks in
        Freighter to continue.
      </span>
    </div>
  );
}
