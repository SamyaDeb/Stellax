/**
 * evmWallet.ts — MetaMask / EVM wallet integration using viem.
 *
 * Provides helpers for:
 *   - Connecting MetaMask and switching to Avalanche Fuji
 *   - Reading aUSDC balance on Fuji
 *   - Calling depositToStellar() on the deployed EVM bridge contract
 */

import {
  createWalletClient,
  createPublicClient,
  custom,
  parseUnits,
  formatUnits,
  getContract,
  type WalletClient,
  type PublicClient,
  type Address,
  type Hex,
} from "viem";
import { avalancheFuji } from "viem/chains";

// ── Chain constants ──────────────────────────────────────────────────────────

/** USDC on Avalanche Fuji (6 decimals, Circle native testnet USDC). */
export const FUJI_USDC: Address = "0x5425890298aed601595a70AB815c96711a31Bc65";

/**
 * Deployed StellaXBridgeEVM address on Avalanche Fuji.
 *
 * Update this after running:
 *   forge script script/Deploy.s.sol:Deploy --rpc-url fuji --broadcast --private-key $PRIVATE_KEY
 */
export const EVM_BRIDGE: Address = "0xa0b38B5F76C97e05DA9AcA0e2bd7788fBF0F207A";

// ── Minimal ABI fragments ────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

const EVM_BRIDGE_ABI = [
  {
    type: "function",
    name: "depositToStellar",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "stellarRecipient", type: "string" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "gasEstimate",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ── Wallet state ─────────────────────────────────────────────────────────────

export interface EvmWalletState {
  address: Address;
  chainId: number;
}

// ── Connect MetaMask ─────────────────────────────────────────────────────────

/**
 * Request MetaMask account access and switch to Avalanche Fuji.
 * Throws if MetaMask is not installed or the user rejects.
 */
export async function connectMetaMask(): Promise<EvmWalletState> {
  if (!window.ethereum) {
    throw new Error(
      "MetaMask not found. Please install MetaMask (https://metamask.io) and reload.",
    );
  }

  const walletClient = createWalletClient({
    chain: avalancheFuji,
    transport: custom(window.ethereum),
  });

  // Request account access
  const [address] = await walletClient.requestAddresses();
  if (!address) throw new Error("No accounts found in MetaMask.");

  // Switch to / add Avalanche Fuji
  try {
    await walletClient.switchChain({ id: avalancheFuji.id });
  } catch (err) {
    // Error code 4902 = chain not added yet
    if ((err as { code?: number }).code === 4902) {
      await walletClient.addChain({ chain: avalancheFuji });
      await walletClient.switchChain({ id: avalancheFuji.id });
    } else {
      throw err;
    }
  }

  return { address, chainId: avalancheFuji.id };
}

// ── Viem client factories ────────────────────────────────────────────────────

/** Returns viem wallet + public client for the connected MetaMask account. */
export function getEvmClients(): { wallet: WalletClient; public: PublicClient } {
  if (!window.ethereum) throw new Error("MetaMask not connected.");
  return {
    wallet: createWalletClient({
      chain: avalancheFuji,
      transport: custom(window.ethereum),
    }),
    public: createPublicClient({
      chain: avalancheFuji,
      transport: custom(window.ethereum),
    }),
  };
}

// ── Balance query ────────────────────────────────────────────────────────────

/**
 * Returns the USDC balance of `account` on Fuji as a formatted string (e.g. "12.50").
 */
export async function getUsdcBalance(account: Address): Promise<string> {
  const { public: pub } = getEvmClients();
  const usdc = getContract({ address: FUJI_USDC, abi: ERC20_ABI, client: pub });
  const raw = await usdc.read.balanceOf([account]);
  // aUSDC has 6 decimals
  return formatUnits(raw, 6);
}

// ── depositToStellar ─────────────────────────────────────────────────────────

export interface DepositToStellarResult {
  txHash: Hex;
  amount: string;
  stellarRecipient: string;
}

/**
 * Approve aUSDC transfer to the bridge and call depositToStellar().
 *
 * @param amount            Human-readable amount (e.g. "10.00")
 * @param stellarRecipient  Stellar G-address of the recipient
 * @param axelarGasFee      AVAX to attach for Axelar relayer gas (default: 0.01 AVAX)
 *
 * The function:
 *   1. Parses `amount` into 6-decimal USDC units.
 *   2. Checks allowance and approves if needed.
 *   3. Calls depositToStellar(usdcAmount, stellarRecipient) with the gas fee.
 *   4. Returns the EVM transaction hash.
 */
export async function depositToStellar(
  amount: string,
  stellarRecipient: string,
  axelarGasFee = "0.01",
): Promise<DepositToStellarResult> {
  if (EVM_BRIDGE.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      "EVM bridge address not configured. " +
        "Deploy the EVM contract and update EVM_BRIDGE in evmWallet.ts.",
    );
  }

  // Validate Stellar address format (G + 55 base32 chars)
  if (!/^G[A-Z2-7]{55}$/.test(stellarRecipient)) {
    throw new Error(`Invalid Stellar address: ${stellarRecipient}`);
  }

  const usdcAmount = parseUnits(amount, 6);
  const gasFee = parseUnits(axelarGasFee, 18); // AVAX in wei

  const { wallet, public: pub } = getEvmClients();
  const [account] = await wallet.getAddresses();
  if (!account) throw new Error("No MetaMask account.");

  const usdc = getContract({ address: FUJI_USDC, abi: ERC20_ABI, client: pub });

  const usdcBalance = await usdc.read.balanceOf([account]);
  if (usdcBalance < usdcAmount) {
    throw new Error(
      `Insufficient aUSDC balance. Available ${formatUnits(usdcBalance, 6)} aUSDC.`,
    );
  }

  // Check and set allowance
  const allowance = await usdc.read.allowance([account, EVM_BRIDGE]);
  if (allowance < usdcAmount) {
    const approveHash = await wallet.writeContract({
      address: FUJI_USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [EVM_BRIDGE, usdcAmount],
      account,
      chain: avalancheFuji,
    });
    // Wait for approval to land
    await pub.waitForTransactionReceipt({ hash: approveHash });
  }

  await pub.simulateContract({
    address: EVM_BRIDGE,
    abi: EVM_BRIDGE_ABI,
    functionName: "depositToStellar",
    args: [usdcAmount, stellarRecipient],
    value: gasFee,
    account,
  });

  // Call depositToStellar with Axelar relayer gas
  const txHash = await wallet.writeContract({
    address: EVM_BRIDGE,
    abi: EVM_BRIDGE_ABI,
    functionName: "depositToStellar",
    args: [usdcAmount, stellarRecipient],
    value: gasFee,
    account,
    chain: avalancheFuji,
  });

  await pub.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    amount,
    stellarRecipient,
  };
}
