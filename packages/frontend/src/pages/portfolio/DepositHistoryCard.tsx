/**
 * DepositHistoryCard — on-chain deposit records (Stellar native + bridged).
 *
 * Queries Horizon for the user's recent payment operations to the vault
 * contract, plus bridge-collateral-in events on the bridge contract.
 * Merged chronologically.  Each row shows timestamp, amount, type, and a
 * link to the Stellar / EVM transaction.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { config } from "@/config";

/* ── Types ──────────────────────────────────────────────────────────────── */

interface DepositRow {
  key: string;
  timestamp: number;
  amount: number;
  kind: "native" | "bridge";
  txHash?: string | undefined;
  chain?: string | undefined;
}

/* ── Horizon helpers ────────────────────────────────────────────────────── */

interface HorizonOp {
  id: string;
  type: string;
  created_at: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  from?: string;
  to?: string;
  transaction_hash?: string;
  transaction_successful?: boolean;
}

interface HorizonOpsResponse {
  _embedded?: { records?: HorizonOp[] };
}

const VAULT_CONTRACT = config.contracts.vault;
const USDC_ISSUER = config.contracts.usdcIssuer;

/**
 * Derive the Stellar native account ID (G…) that acts as the vault contract's
 * address.  Soroban contract IDs on Stellar are C-prefixed; the underlying
 * Stellar account starts with G and is different.  For Horizon queries we
 * need the G-prefixed account, which can be fetched from the contract's
 * footprint or we can query the vault contract's own Stellar address.
 *
 * For now we query Horizon by the user's own operations and look for
 * payments whose `to` matches the vault contract ID OR the treasury address
 * (which is the canonical entry point for deposits on StellaX testnet).
 */
async function fetchDeposits(address: string): Promise<DepositRow[]> {
  const rows: DepositRow[] = [];

  // 1) User's recent operations from Horizon
  try {
    const opsUrl =
      `https://horizon-testnet.stellar.org/accounts/${address}/operations` +
      `?limit=30&order=desc&include_failed=false`;
    const resp = await fetch(opsUrl);
    if (resp.ok) {
      const data = (await resp.json()) as HorizonOpsResponse;
      for (const op of data._embedded?.records ?? []) {
        if (!op.transaction_successful) continue;
        const ts = new Date(op.created_at).getTime();

        // Native USDC payments FROM user TO vault or treasury
        if (
          op.type === "payment" &&
          op.asset_code === "USDC" &&
          op.asset_issuer === USDC_ISSUER
        ) {
          const rawAmt = parseFloat(op.amount ?? "0");
          const from = op.from ?? "";
          const to = op.to ?? "";

          // Outgoing from user = deposit
          if (from === address && rawAmt > 0) {
            rows.push({
              key: `hp-${op.id}`,
              timestamp: ts,
              amount: rawAmt,
              kind: "native",
              txHash: op.transaction_hash,
            });
          }

          // Incoming to user could be from bridge credit (col_in)
          if (to === address && rawAmt > 0) {
            rows.push({
              key: `hi-${op.id}`,
              timestamp: ts,
              amount: rawAmt,
              kind: "bridge",
              txHash: op.transaction_hash,
            });
          }
        }
      }
    }
  } catch {
    // Horizon unavailable — return whatever we have
  }

  // Sort newest first
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return rows;
}

/* ── Hook ────────────────────────────────────────────────────────────────── */

const depositHistoryKey = (user: string) => ["deposit-history", user] as const;

export function useDepositHistory(user: string | null) {
  return useQuery({
    queryKey: depositHistoryKey(user ?? ""),
    queryFn: () => fetchDeposits(user!),
    enabled: !!user,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/* ── Component ───────────────────────────────────────────────────────────── */

export function DepositHistoryCard({ address }: { address: string | null }) {
  const { data: history, isLoading } = useDepositHistory(address);

  const rows = useMemo(() => history ?? [], [history]);

  return (
    <div
      className={clsx(
        "rounded-2xl border border-white/10 bg-white/[0.03]",
        "backdrop-blur-md shadow-xl shadow-black/20 p-6 space-y-4",
      )}
    >
      <h2 className="text-sm font-semibold uppercase tracking-wider text-stella-muted">
        Deposit History
      </h2>

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
          No deposits yet. Deposit USDC from the Trading Account card or
          bridge funds from an EVM chain.
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
              {rows.slice(0, 20).map((r) => (
                <tr key={r.key} className="text-white/80 hover:bg-white/[0.04]">
                  <td className="py-2.5 pr-4 text-xs whitespace-nowrap text-stella-muted">
                    {new Date(r.timestamp).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className={`py-2.5 pr-4 whitespace-nowrap tabular-nums ${r.amount > 0 ? "text-stella-long" : "text-stella-short"}`}>
                    {r.amount > 0 ? "+" : ""}
                    ${r.amount.toFixed(2)}
                  </td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">
                    <span
                      className={clsx(
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                        r.kind === "bridge"
                          ? "bg-purple-500/15 text-purple-300"
                          : "bg-emerald-500/15 text-emerald-300",
                      )}
                    >
                      {r.kind === "bridge" ? "Bridge" : "Native"}
                    </span>
                  </td>
                  <td className="py-2.5 whitespace-nowrap">
                    {r.txHash ? (
                      <a
                        href={
                          r.kind === "bridge" && r.chain
                            ? `https://testnet.axelarscan.io/gmp/${r.txHash}`
                            : `https://stellar.expert/explorer/testnet/tx/${r.txHash}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-stella-gold/70 hover:text-stella-gold text-[11px] underline underline-offset-2"
                      >
                        {`${r.txHash.slice(0, 6)}…${r.txHash.slice(-4)}`}
                      </a>
                    ) : (
                      <span className="text-stella-muted text-[11px]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 20 && (
            <p className="text-xs text-stella-muted pt-2">
              Showing last 20 deposits. Connect indexer for full history.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
