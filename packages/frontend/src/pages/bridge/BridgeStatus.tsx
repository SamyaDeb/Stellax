import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Input } from "@/ui/Input";

/** Axelar GMP scan API (testnet). */
const AXELAR_GMP_API = "https://testnet.api.gmp.axelarscan.io";

interface GmpStatus {
  status: string;        // "executed" | "executing" | "confirmed" | "error" | ...
  sourceChain?: string;
  destinationChain?: string;
  amount?: string;
  senderAddress?: string;
  destinationContractAddress?: string;
  executed?: {
    transactionHash?: string;
    blockNumber?: number;
  };
  callTx?: {
    blockTimestamp?: number;
    from?: string;
  };
}

async function fetchGmpStatus(txHash: string): Promise<GmpStatus | null> {
  const url = `${AXELAR_GMP_API}/gmp/searchGMP?txHash=${encodeURIComponent(txHash)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Axelar API ${res.status}`);
  const json = (await res.json()) as { data?: GmpStatus[] };
  const events = json.data ?? [];
  return events[0] ?? null;
}

function statusLabel(status: string): string {
  switch (status) {
    case "executed":     return "Delivered";
    case "executing":    return "Executing";
    case "confirmed":    return "Confirmed — awaiting execution";
    case "approved":     return "Approved by Axelar";
    case "pending":      return "Pending";
    default:             return status;
  }
}

function statusColor(status: string): string {
  if (status === "executed") return "text-stella-long";
  if (status === "error")    return "text-stella-short";
  return "text-stella-accent";
}

/**
 * Deposit status panel.
 *
 * Enter the EVM transaction hash of your depositToStellar() call.
 * The panel polls the Axelar GMP API to show relay progress.
 * Once status is "executed", the bridge keeper credits your Stellar vault.
 */
export function BridgeStatus() {
  const [txInput, setTxInput] = useState("");

  const txHash = /^0x[0-9a-fA-F]{64}$/.test(txInput.trim())
    ? txInput.trim()
    : null;

  const gmpQ = useQuery({
    queryKey: ["axelar-gmp", txHash ?? ""],
    queryFn: () => fetchGmpStatus(txHash as string),
    enabled: txHash !== null,
    refetchInterval: 8_000,
  });

  const gmp = gmpQ.data;

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Deposit status</CardTitle>
        <span className="text-xs text-stella-muted">Axelar GMP</span>
      </CardHeader>
      <div className="space-y-4 p-4">
        <Input
          label="EVM transaction hash"
          placeholder="0x..."
          value={txInput}
          onChange={(e) => setTxInput(e.target.value)}
        />

        {txInput.length > 0 && txHash === null && (
          <p className="text-xs text-stella-short">
            Enter a valid EVM tx hash (0x + 64 hex chars).
          </p>
        )}

        {txHash !== null && gmpQ.isError && (
          <p className="text-xs text-stella-short">
            Could not reach Axelar API. Check{" "}
            <a
              href={`https://testnet.axelarscan.io/gmp/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              AxelarScan
            </a>{" "}
            directly.
          </p>
        )}

        {txHash !== null && gmpQ.isLoading && (
          <p className="text-xs text-stella-muted animate-pulse">
            Looking up transaction…
          </p>
        )}

        {gmp !== null && gmp !== undefined && (
          <>
            <div className="space-y-1.5 rounded-xl bg-black/30 px-4 py-3 text-xs border border-white/5">
              {gmp.sourceChain && (
                <Row label="From" value={gmp.sourceChain} />
              )}
              {gmp.destinationChain && (
                <Row label="To" value={gmp.destinationChain} />
              )}
              {gmp.amount && (
                <Row label="Amount" value={`${gmp.amount} aUSDC`} />
              )}
              {gmp.callTx?.from && (
                <Row
                  label="Sender"
                  value={`${gmp.callTx.from.slice(0, 6)}…${gmp.callTx.from.slice(-4)}`}
                />
              )}
              {gmp.callTx?.blockTimestamp && (
                <Row
                  label="Submitted"
                  value={new Date(gmp.callTx.blockTimestamp * 1000).toLocaleString()}
                />
              )}
              <Row
                label="Status"
                value={statusLabel(gmp.status)}
                valueClassName={statusColor(gmp.status)}
              />
              {gmp.executed?.transactionHash && (
                <Row
                  label="Stellar tx"
                  value={`${gmp.executed.transactionHash.slice(0, 8)}…`}
                />
              )}
            </div>

            {gmp.status === "executed" ? (
              <div className="rounded-md bg-stella-long/10 px-3 py-2.5 text-xs text-stella-long">
                Delivered on Stellar. The bridge keeper will credit your vault
                within the next poll cycle (~15 seconds).
              </div>
            ) : gmp.status === "error" ? (
              <div className="rounded-md bg-stella-short/10 px-3 py-2.5 text-xs text-stella-short">
                Relay error. Check{" "}
                <a
                  href={`https://testnet.axelarscan.io/gmp/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  AxelarScan
                </a>{" "}
                for details.
              </div>
            ) : (
              <div className="rounded-xl bg-black/30 px-3 py-2.5 text-xs text-stella-muted border border-white/5">
                Relaying via Axelar — no action needed. Funds are credited
                automatically once the message is executed on Stellar.
              </div>
            )}

            <a
              href={`https://testnet.axelarscan.io/gmp/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="block text-center text-xs text-stella-accent underline"
            >
              View on AxelarScan →
            </a>
          </>
        )}

        {txHash !== null && !gmpQ.isLoading && gmp === null && !gmpQ.isError && (
          <p className="text-xs text-stella-muted">
            Transaction not yet indexed by Axelar. It may take 1–2 minutes to
            appear after submission.
          </p>
        )}

        {txHash === null && txInput.length === 0 && (
          <p className="text-xs text-stella-muted">
            Paste the EVM transaction hash from your depositToStellar() call to
            track relay progress. Delivery is automatic — no claim needed.
          </p>
        )}
      </div>
    </Card>
  );
}

function Row({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-stella-muted">{label}</span>
      <span className={clsx("num text-white", valueClassName)}>{value}</span>
    </div>
  );
}
