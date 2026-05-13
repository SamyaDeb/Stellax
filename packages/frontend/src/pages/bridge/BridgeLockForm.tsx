import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { Input, Select } from "@/ui/Input";
import { formatUsd, toFixed, fromFixed } from "@/ui/format";
import { useTx, useWallet } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { config } from "@/config";
import { qk, useVaultBalance } from "@/hooks/queries";
import {
  connectMetaMask,
  depositToStellar,
  getUsdcBalance,
  EVM_BRIDGE,
  type EvmWalletState,
} from "@/wallet/evmWallet";

const SUPPORTED_CHAINS = [
  { id: "ethereum", label: "Ethereum" },
  { id: "polygon", label: "Polygon" },
  { id: "arbitrum", label: "Arbitrum" },
  { id: "optimism", label: "Optimism" },
  { id: "base", label: "Base" },
] as const;

/** Hex "0x..." address → Uint8Array(20). */
function parseEvmAddress(s: string): Uint8Array | null {
  const m = /^0x([0-9a-fA-F]{40})$/.exec(s.trim());
  if (!m) return null;
  const hex = m[1] as string;
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── Outbound form (Stellar → EVM) ────────────────────────────────────────────

function OutboundForm() {
  const { run, pending, connected, address } = useTx();
  const [chain, setChain] = useState<string>(SUPPORTED_CHAINS[0].id);
  const [evmAddr, setEvmAddr] = useState("");
  const [amount, setAmount] = useState("");

  const parsed = toFixed(amount || "0");
  const amount7dec = parsed / 10n ** 11n;
  const evmBytes = parseEvmAddress(evmAddr);
  const addrValid = evmBytes !== null;
  const canSubmit = connected && !pending && amount7dec > 0n && addrValid;

  async function submit() {
    if (!canSubmit || !address || evmBytes === null) return;
    await run(
      `Bridge ${fromFixed(parsed).toFixed(2)} USD → ${chain}`,
      (source) =>
        getClients().bridge.lock({
          user: source,
          amount: amount7dec,
          destChain: chain,
          destAddress: evmBytes,
          gasToken: config.contracts.usdcSac,
          opts: { sourceAccount: source },
        }),
      { invalidate: [qk.vaultBalance(address), qk.accountHealth(address), qk.vaultTotal()] },
    );
    setAmount("");
  }

  return (
    <div className="space-y-4 p-4">
      <Select
        label="Destination chain"
        value={chain}
        onChange={(e) => setChain(e.target.value)}
        options={SUPPORTED_CHAINS.map((c) => ({ value: c.id, label: c.label }))}
      />
      <Input
        label="Destination address (EVM)"
        placeholder="0x..."
        value={evmAddr}
        onChange={(e) => setEvmAddr(e.target.value)}
      />
      {evmAddr.length > 0 && !addrValid && (
        <p className="-mt-3 text-xs text-stella-short">
          Invalid EVM address. Must be 0x + 40 hex chars.
        </p>
      )}
      <Input
        label="Amount"
        suffix="USD"
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <div className="space-y-1.5 rounded-xl bg-black/30 px-4 py-3 text-xs border border-white/5">
        <Row label="You send" value={formatUsd(parsed)} />
        <Row label="Bridge fee" value="— (paid by relayer)" />
        <Row label="ETA" value="≤ 2 minutes" />
      </div>
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={!canSubmit}
        onClick={() => void submit()}
      >
        {pending ? "Submitting…" : !connected ? "Connect wallet" : "Lock & bridge"}
      </Button>
    </div>
  );
}

// ── Inbound form (EVM → Stellar) ──────────────────────────────────────────────

function InboundForm({ onDeposited }: { onDeposited?: ((txHash: string) => void) | undefined }) {
  const { address: stellarAddress } = useWallet();
  const qc = useQueryClient();
  const vaultBal = useVaultBalance(stellarAddress);
  const [evmWallet, setEvmWallet] = useState<EvmWalletState | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [customRecipient, setCustomRecipient] = useState("");
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const bridgeDeployed =
    EVM_BRIDGE !== "0x0000000000000000000000000000000000000000";
  const recipient = customRecipient.trim() || stellarAddress || "";
  const recipientValid = /^G[A-Z2-7]{55}$/.test(recipient);
  const amountNum = parseFloat(amount);
  const canSubmit =
    bridgeDeployed &&
    evmWallet !== null &&
    status !== "pending" &&
    amountNum > 0 &&
    !isNaN(amountNum) &&
    recipientValid;

  async function handleConnect() {
    setErrorMsg(null);
    try {
      const state = await connectMetaMask();
      setEvmWallet(state);
      const bal = await getUsdcBalance(state.address);
      setUsdcBalance(bal);
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  }

  async function handleDeposit() {
    if (!canSubmit) return;
    setStatus("pending");
    setErrorMsg(null);
    setTxHash(null);
    try {
      const result = await depositToStellar(amount, recipient);
      setTxHash(result.txHash);
      setStatus("done");
      setAmount("");
      onDeposited?.(result.txHash);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.vaultBalance(recipient) }),
        qc.invalidateQueries({ queryKey: qk.vaultTokenBalance(recipient, config.contracts.usdcSac) }),
        qc.invalidateQueries({ queryKey: qk.accountHealth(recipient) }),
        qc.invalidateQueries({ queryKey: ["axelar-gmp", result.txHash] }),
      ]);
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus("error");
    }
  }

  if (!bridgeDeployed) {
    return (
      <div className="p-4 text-xs text-stella-muted">
        EVM bridge contract not yet deployed. Deploy{" "}
        <code>contracts/evm/src/StellaXBridgeEVM.sol</code> to Avalanche Fuji
        and set <code>EVM_BRIDGE</code> in{" "}
        <code>packages/frontend/src/wallet/evmWallet.ts</code>.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {evmWallet === null ? (
        <Button variant="primary" size="lg" className="w-full" onClick={() => void handleConnect()}>
          Connect MetaMask
        </Button>
      ) : (
        <div className="rounded-xl bg-black/30 px-4 py-3 text-xs border border-white/5 space-y-1.5">
          <Row label="MetaMask" value={`${evmWallet.address.slice(0, 6)}…${evmWallet.address.slice(-4)}`} />
          {usdcBalance !== null && <Row label="aUSDC balance (Fuji)" value={`${usdcBalance} USDC`} />}
          {vaultBal.data !== undefined && (
            <Row
              label="Stellar vault balance"
              value={formatUsd(vaultBal.data.free)}
            />
          )}
        </div>
      )}

      <Input
        label="Stellar recipient"
        placeholder={stellarAddress ?? "G…"}
        value={customRecipient}
        onChange={(e) => setCustomRecipient(e.target.value)}
      />
      {customRecipient.length > 0 && !recipientValid && (
        <p className="-mt-3 text-xs text-stella-short">
          Invalid Stellar address. Must start with G and be 56 chars.
        </p>
      )}

      <Input
        label="Amount"
        suffix="USDC"
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      <div className="space-y-1.5 rounded-xl bg-black/30 px-4 py-3 text-xs border border-white/5">
        <Row label="You send" value={`${amountNum > 0 ? amountNum.toFixed(2) : "—"} aUSDC`} />
        <Row label="You receive" value={`${amountNum > 0 ? amountNum.toFixed(2) : "—"} USDC (Stellar vault)`} />
        <Row label="Gas fee" value="~0.01 AVAX (Axelar relayer)" />
        <Row label="ETA" value="≤ 2 minutes" />
      </div>

      {status === "done" && txHash && (
        <div className="rounded-md bg-stella-long/10 px-3 py-2.5 text-xs text-stella-long">
          Submitted! Track on{" "}
          <a
            href={`https://testnet.axelarscan.io/gmp/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            AxelarScan
          </a>
          .{" "}
          <span className="text-stella-muted">
            The bridge keeper will credit your Stellar vault automatically.
          </span>
        </div>
      )}

      {errorMsg && (
        <p className="rounded-md bg-stella-short/10 px-3 py-2 text-xs text-stella-short">
          {errorMsg}
        </p>
      )}

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={!canSubmit}
        onClick={() => void handleDeposit()}
      >
        {status === "pending"
          ? "Waiting for MetaMask…"
          : evmWallet === null
            ? "Connect MetaMask first"
            : "Deposit to Stellar"}
      </Button>
    </div>
  );
}

// ── Tab container ─────────────────────────────────────────────────────────────

type Tab = "inbound" | "outbound";

/**
 * Bridge form with two tabs:
 *   - Inbound  : EVM (Avalanche Fuji aUSDC) → Stellar vault  [via MetaMask]
 *   - Outbound : Stellar vault → EVM  [via Freighter]
 */
export function BridgeLockForm({ onDeposited }: { onDeposited?: (txHash: string) => void }) {
  const [tab, setTab] = useState<Tab>("inbound");

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Bridge</CardTitle>
      </CardHeader>

      {/* Tab switcher */}
      <div className="flex border-b border-white/10">
        {(["inbound", "outbound"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              "flex-1 py-2 text-xs font-medium transition-colors",
              tab === t
                ? "border-b-2 border-stella-accent text-stella-accent"
                : "text-stella-muted hover:text-white",
            )}
          >
            {t === "inbound" ? "EVM → Stellar" : "Stellar → EVM"}
          </button>
        ))}
      </div>

      {tab === "inbound" ? <InboundForm onDeposited={onDeposited} /> : <OutboundForm />}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-stella-muted">{label}</span>
      <span className="num text-white">{value}</span>
    </div>
  );
}
