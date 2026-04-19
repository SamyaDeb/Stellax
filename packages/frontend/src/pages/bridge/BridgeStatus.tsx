import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Input } from "@/ui/Input";
import { formatUsd, shortAddress } from "@/ui/format";
import { getClients } from "@/stellar/clients";
import { useBridgeValidators } from "@/hooks/queries";
import { config, hasContract } from "@/config";

function hexOf(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Deposit status panel.
 *
 * Inbound bridge (EVM → Stellar) works as follows:
 *   1. User sends on the EVM chain — Axelar relayer picks up the GMP message.
 *   2. Axelar validators attest to the message (threshold signatures).
 *   3. The Axelar relayer automatically calls `bridge_collateral_in` on this
 *      contract once the threshold is met — no user action needed on Stellar.
 *
 * The `release()` endpoint is called by the Axelar relayer, not the user.
 * This panel therefore shows attestation progress and links to AxelarScan
 * for real-time relay status rather than exposing a manual claim button.
 */
export function BridgeStatus() {
  const validatorsQ = useBridgeValidators();
  const [idInput, setIdInput] = useState("");

  const idBig = (() => {
    const t = idInput.trim();
    if (t === "" || !/^\d+$/.test(t)) return null;
    try {
      return BigInt(t);
    } catch {
      return null;
    }
  })();

  const depositQ = useQuery({
    queryKey: ["bridge-deposit", idBig?.toString() ?? ""],
    queryFn: () => getClients().bridge.getDeposit(idBig as bigint),
    enabled: idBig !== null && hasContract(config.contracts.bridge),
    refetchInterval: 5_000,
  });

  const attestQ = useQuery({
    queryKey: ["bridge-attest-count", idBig?.toString() ?? ""],
    queryFn: () => getClients().bridge.getAttestationCount(idBig as bigint),
    enabled: idBig !== null && hasContract(config.contracts.bridge),
    refetchInterval: 5_000,
  });

  const configQ = useQuery({
    queryKey: ["bridge-config"],
    queryFn: () => getClients().bridge.getConfig(),
    enabled: hasContract(config.contracts.bridge),
    staleTime: 300_000,
  });

  const deposit = depositQ.data;
  const attestations = attestQ.data ?? 0;
  const minValidators = configQ.data?.minValidators ?? 0;
  const threshold = minValidators > 0 ? minValidators : 1;
  const progress = Math.min(100, Math.floor((attestations / threshold) * 100));

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Deposit status</CardTitle>
        <span className="text-xs text-stella-muted">
          {validatorsQ.data?.length ?? 0} validators
        </span>
      </CardHeader>
      <div className="space-y-4 p-4">
        <Input
          label="Deposit id"
          inputMode="numeric"
          placeholder="123"
          value={idInput}
          onChange={(e) => setIdInput(e.target.value)}
        />

        {idBig !== null && depositQ.isError && (
          <p className="text-xs text-stella-short">
            Deposit not found or RPC error.
          </p>
        )}

        {deposit !== undefined && (
          <>
            <div className="space-y-1.5 rounded-md bg-stella-bg px-3 py-3 text-xs">
              <Row label="From" value={shortAddress(deposit.user)} />
              <Row label="Amount" value={formatUsd(deposit.amount)} />
              <Row label="Dest chain" value={deposit.destChain} />
              <Row
                label="Dest address"
                value={shortAddress(hexOf(deposit.destAddress))}
              />
              <Row
                label="Submitted"
                value={new Date(
                  Number(deposit.timestamp) * 1000,
                ).toLocaleString()}
              />
              <Row
                label="Released"
                value={deposit.released ? "yes" : "pending"}
              />
            </div>

            {!deposit.released && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-stella-muted">
                    Attestations {attestations} / {threshold}
                  </span>
                  <span
                    className={clsx(
                      "num",
                      attestations >= threshold
                        ? "text-stella-long"
                        : "text-stella-accent",
                    )}
                  >
                    {progress}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-stella-bg">
                  <div
                    className={clsx(
                      "h-full transition-[width]",
                      attestations >= threshold
                        ? "bg-stella-long"
                        : "bg-stella-accent",
                    )}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            {deposit.released ? (
              <div className="rounded-md bg-stella-long/10 px-3 py-2.5 text-xs text-stella-long">
                Funds delivered to your Stellar vault.
              </div>
            ) : attestations >= threshold ? (
              <div className="rounded-md bg-stella-accent/10 px-3 py-2.5 text-xs text-stella-accent">
                Threshold reached — Axelar relayer is executing delivery.
                No action required. Check{" "}
                <a
                  href="https://testnet.axelarscan.io"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  AxelarScan
                </a>{" "}
                for relay status.
              </div>
            ) : (
              <div className="rounded-md bg-stella-surface px-3 py-2.5 text-xs text-stella-muted">
                Awaiting validator attestations. Inbound funds are
                delivered automatically by the Axelar relayer once the
                threshold is met — no manual claim needed.
              </div>
            )}
          </>
        )}

        {idBig === null && idInput.length > 0 && (
          <p className="text-xs text-stella-short">
            Enter a numeric deposit id.
          </p>
        )}

        {idBig === null && idInput.length === 0 && (
          <p className="text-xs text-stella-muted">
            Enter your deposit id to track inbound attestation progress.
            Delivery is automatic via Axelar GMP — no on-chain claim needed.
          </p>
        )}
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
