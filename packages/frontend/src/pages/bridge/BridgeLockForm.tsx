import { useState } from "react";
import clsx from "clsx";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { Input, Select } from "@/ui/Input";
import { formatUsd, toFixed, fromFixed } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { config } from "@/config";
import { qk } from "@/hooks/queries";

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

/**
 * Lock-side bridge form: user deposits USD-equiv on Stellar, the Axelar
 * relayer observes the Lock event and mints on the destination chain.
 */
export function BridgeLockForm() {
  const { run, pending, connected, address } = useTx();
  const [chain, setChain] = useState<string>(SUPPORTED_CHAINS[0].id);
  const [evmAddr, setEvmAddr] = useState("");
  const [amount, setAmount] = useState("");

  const parsed = toFixed(amount || "0");
  // Bridge contract expects 7-decimal USDC amounts (like vault/treasury)
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
      {
        invalidate: [qk.vaultBalance(address)],
      },
    );
    setAmount("");
  }

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Bridge out</CardTitle>
        <span className="text-xs text-stella-muted">Stellar → EVM</span>
      </CardHeader>
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

        <div className="space-y-1.5 rounded-md bg-stella-bg px-3 py-3 text-xs">
          <Row label="You send" value={formatUsd(parsed)} />
          <Row label="Bridge fee" value="— (paid by relayer)" />
          <Row label="ETA" value="≤ 2 minutes" />
        </div>

        <Button
          variant="primary"
          size="lg"
          className={clsx("w-full")}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {pending
            ? "Submitting…"
            : !connected
              ? "Connect wallet"
              : "Lock & bridge"}
        </Button>
      </div>
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
