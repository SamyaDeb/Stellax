/**
 * `useTx` — React wrapper for SDK write methods.
 *
 * Usage:
 *   const { run, pending, clients } = useTx();
 *   await run("Open position", () =>
 *     clients().perp.openPosition(..., { sourceAccount: address }),
 *   );
 *
 * The hook:
 *   - requires a connected wallet and passes `address` as `sourceAccount`
 *   - tracks status in the global tx-store so toasts update automatically
 *   - invalidates TanStack Query cache keys optionally passed as `invalidate`
 *   - `clients()` returns SDK clients wired to the current network passphrase,
 *     so network switches in Freighter are handled automatically
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { InvokeResult } from "@stellax/sdk";
import { useWallet } from "./WalletContext";
import { useTxStore, nextTxId } from "./tx-store";
import { useWalletStore } from "./store";
import { getClients } from "@/stellar/clients";
import { config } from "@/config";

export interface RunOptions {
  /** Query keys to invalidate on success. */
  invalidate?: readonly (readonly unknown[])[];
}

export function useTx() {
  const { address, status } = useWallet();
  const qc = useQueryClient();
  const tx = useTxStore();
  const [pending, setPending] = useState(false);

  /** Return SDK clients wired to the active network passphrase. */
  const clients = useCallback(() => {
    const np = useWalletStore.getState().networkPassphrase;
    return getClients(np ?? config.network.passphrase);
  }, []);

  const run = useCallback(
    async (
      label: string,
      fn: (sourceAccount: string) => Promise<InvokeResult>,
      opts: RunOptions = {},
    ): Promise<InvokeResult | null> => {
      if (status !== "connected" || address === null) {
        tx.push({
          id: nextTxId(),
          label,
          phase: "failed",
          message: "Wallet not connected",
        });
        return null;
      }

      const id = nextTxId();
      tx.push({ id, label, phase: "pending" });
      setPending(true);
      try {
        const result = await fn(address);
        let phase: "success" | "failed" | "pending";
        let message: string | undefined;
        if (result.status === "SUCCESS") {
          phase = "success";
        } else if (result.status === "PENDING") {
          phase = "pending";
          message = "Still confirming on-chain…";
        } else {
          phase = "failed";
          message = `Transaction ${result.status.toLowerCase()}`;
        }
        const patch: { phase: typeof phase; hash: string; message?: string } = {
          phase,
          hash: result.hash,
          ...(message !== undefined ? { message } : {}),
        };
        tx.update(id, patch);
        if (opts.invalidate) {
          const keysSnapshot = opts.invalidate;

          const sweep = () => {
            for (const key of keysSnapshot) {
              void qc.invalidateQueries({ queryKey: key as unknown[] });
            }
          };

          if (result.status === "SUCCESS") {
            // Immediate invalidation (optimistic — may read pre-tx ledger ~50% of the time)
            for (const key of keysSnapshot) {
              await qc.invalidateQueries({ queryKey: key as unknown[] });
            }
            // Delayed re-invalidations after ~2 and ~4 Stellar ledger closes (≈6s / 12s)
            // to guarantee the RPC node has processed the tx ledger before we refetch.
            setTimeout(sweep, 6_000);
            setTimeout(sweep, 12_000);
          } else if (result.status === "PENDING") {
            // Executor timed out polling. The tx may still land on-chain.
            // Schedule three deferred sweeps so data refreshes once it does.
            setTimeout(sweep, 8_000);
            setTimeout(sweep, 16_000);
            setTimeout(sweep, 30_000);
          }
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        tx.update(id, { phase: "failed", message: msg });
        return null;
      } finally {
        setPending(false);
      }
    },
    // tx store is stable; qc reference is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address, status],
  );

  return { run, pending, address, connected: status === "connected", clients };
}
