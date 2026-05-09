/// <reference types="vite/client" />

// Minimal EIP-1193 provider type so `window.ethereum` is recognized by TS.
// viem's `custom(window.ethereum)` transport accepts this shape.
interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
}

interface Window {
  ethereum?: EthereumProvider;
}
