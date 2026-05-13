/**
 * DepositHistoryCard — on-chain deposit & withdrawal records.
 *
 * Queries Horizon for the user's recent transactions, decodes
 * invoke_host_function operations to find vault deposits / withdrawals
 * and bridge operations.  Shows amount (where extractable), timestamp,
 * type, and tx hash link.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { config } from "@/config";

/* ── Types ──────────────────────────────────────────────────────────────── */

interface HistoryRow {
  key: string;
  timestamp: string;
  amount: number | undefined;
  kind: "deposit" | "withdraw" | "bridge" | "bridge-out" | "vault-op";
  txHash: string;
  contract: string;
}

/* ── Constants ──────────────────────────────────────────────────────────── */

const HORIZON = "https://horizon-testnet.stellar.org";
const VAULT = config.contracts.vault;
const BRIDGE = config.contracts.bridge;
const USDC_SAC = config.contracts.usdcSac;

/* ── Helpers ────────────────────────────────────────────────────────────── */

/** Decode a base64 ScVal (from Horizon param) into a native JS value. */
function decodeScValBase64(b64: string): unknown {
  try {
    const val = xdr.ScVal.fromXDR(b64, "base64");
    return scValToNative(val);
  } catch {
    return null;
  }
}

/** Heuristic: guess the operation type from contract + parameter count. */
function guessOperationType(
  contractId: string,
  paramCount: number,
): HistoryRow["kind"] {
  if (contractId === VAULT) {
    // deposit(user, token, amount) → 3 params
    // withdraw(user, token, amount) → 3 params
    // credit(caller, user, token, amount) → 4 params
    // debit(caller, user, token, amount) → 4 params
    if (paramCount === 3) return "deposit";   // could be deposit or withdraw
    if (paramCount === 4) return "bridge";    // credit from bridge
    return "vault-op";
  }
  if (contractId === BRIDGE) {
    if (paramCount >= 5) return "bridge-out"; // bridge_collateral_out
    return "bridge";
  }
  return "vault-op";
}

/* ── Data fetch ─────────────────────────────────────────────────────────── */

interface HorizonTx {
  hash: string;
  created_at: string;
  source_account: string;
  operation_count: number;
}

interface HorizonOp {
  id: string;
  type: string;
  function?: string;
  parameters?: { type: string; value: string }[];
  transaction_hash?: string;
  created_at?: string;
}

async function fetchHistory(address: string): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [];

  // 1) Fetch user's recent transactions
  const txResp = await fetch(
    `${HORIZON}/accounts/${address}/transactions?limit=30&order=desc&include_failed=false`,
  );
  if (!txResp.ok) return rows;
  const txData = (await txResp.json()) as { _embedded?: { records?: HorizonTx[] } };
  const txs = txData._embedded?.records ?? [];

  for (const tx of txs) {
    // Fetch operations for this transaction
    const opsResp = await fetch(`${HORIZON}/transactions/${tx.hash}/operations`);
    if (!opsResp.ok) continue;
    const opsData = (await opsResp.json()) as { _embedded?: { records?: HorizonOp[] } };

    for (const op of opsData._embedded?.records ?? []) {
      if (op.type !== "invoke_host_function") continue;
      const params = op.parameters;
      if (!params || params.length === 0) continue;

      // First param is always the contract Address
      const firstParam = params[0];
      if (!firstParam) continue;
      const contractId = decodeScValBase64(firstParam.value) as string;
      if (typeof contractId !== "string") continue;

      // Only care about vault and bridge contract calls
      if (contractId !== VAULT && contractId !== BRIDGE) continue;

      // Try to extract amount from parameters (last param is usually amount)
      let amount: number | undefined = undefined;
      const lastParam = params[params.length - 1];
      if (lastParam) {
        const raw = decodeScValBase64(lastParam.value);
        if (typeof raw === "bigint") {
          // Amounts from vault are in native token decimals (7dp for USDC)
          amount = Number(raw) / 10_000_000;
        } else if (typeof raw === "number") {
          amount = raw / 10_000_000;
        }
      }

      const kind = guessOperationType(contractId, params.length);

      rows.push({
        key: `${tx.hash}-${op.id}`,
        timestamp: tx.created_at,
        amount,
        kind,
        txHash: tx.hash,
        contract: contractId === VAULT ? "Vault" : "Bridge",
      });
    }
  }

  return rows;
}

/* ── Hook ───────────────────────────────────────────────────────────────── */

const depositHistoryKey = (user: string) => ["deposit-history-v2", user] as const;

export function useDepositHistory(user: string | null) {
  return useQuery({
    queryKey: depositHistoryKey(user ?? ""),
    queryFn: () => fetchHistory(user!),
    enabled: !!user,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/* ── Component ──────────────────────────────────────────────────────────── */

export function DepositHistoryCard({ address }: { address: string | null }) {
  const { data: history, isLoading } = useDepositHistory(address);

  const rows = useMemo(() => history ?? [], [history]);

  const kindLabel = (k: HistoryRow["kind"]) => {
    switch (k) {
      case "deposit":
        return { text: "Deposit", class: "bg-emerald-500/15 text-emerald-300" };
      case "withdraw":
        return { text: "Withdraw", class: "bg-rose-500/15 text-rose-300" };
      case "bridge":
        return { text: "Bridge In", class: "bg-purple-500/15 text-purple-300" };
      case "bridge-out":
        return { text: "Bridge Out", class: "bg-orange-500/15 text-orange-300" };
      default:
        return { text: "Vault", class: "bg-gray-500/15 text-gray-300" };
    }
  };

  return (
    <div
      className={clsx(
        "rounded-2xl border border-white/10 bg-white/[0.03]",
        "backdrop-blur-md shadow-xl shadow-black/20 p-6 space-y-4",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stella-muted">
          Deposit History
        </h2>
        <span className="text-[10px] text-stella-muted">On-chain</span>
      </div>

      {!address ? (
        <p className="text-sm text-stella-muted">
          Connect wallet to see your deposit history.
        </p>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-6">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-stella-gold/30 border-t-stella-gold" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-stella-muted py-4">
          No vault or bridge operations found in the last 30 transactions.
          Deposit USDC from the Trading Account card or bridge funds from an EVM chain.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-stella-muted">
                <th className="pb-2 pr-4 font-medium">Date</th>
                <th className="pb-2 pr-4 font-medium">Amount</th>
                <th className="pb-2 pr-4 font-medium">Type</th>
                <th className="pb-2 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => {
                const kl = kindLabel(r.kind);
                const date = new Date(r.timestamp);
                return (
                  <tr key={r.key} className="text-white/80 hover:bg-white/[0.04]">
                    <td className="py-2.5 pr-4 text-xs whitespace-nowrap text-stella-muted">
                      {date.toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap tabular-nums">
                      {r.amount !== undefined ? (
                        <span className={r.amount > 0 ? "text-stella-long" : "text-stella-short"}>
                          {r.amount > 0 ? "+" : ""}
                          {Math.abs(r.amount).toFixed(2)} USDC
                        </span>
                      ) : (
                        <span className="text-stella-muted">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      <span
                        className={clsx(
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                          kl.class,
                        )}
                      >
                        {kl.text}
                      </span>
                    </td>
                    <td className="py-2.5 whitespace-nowrap">
                      <a
                        href={`https://stellar.expert/explorer/testnet/tx/${r.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-stella-gold/70 hover:text-stella-gold text-[11px] underline underline-offset-2"
                      >
                        {`${r.txHash.slice(0, 6)}…${r.txHash.slice(-4)}`}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
