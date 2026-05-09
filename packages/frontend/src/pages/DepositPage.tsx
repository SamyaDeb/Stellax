/**
 * Phase W / Ω4 — Deposit-anything + claimable balances.
 *
 * 1. Asset picker (XLM / USDC); user enters target USDC amount they want
 *    deposited into the vault.
 * 2. Frontend calls Horizon strict-receive paths to find the cheapest path,
 *    pre-fills `sendMax` with 1% slippage, builds a path-payment-strict-
 *    receive tx via `stellarNative.buildPathPaymentStrictReceive`, signs via
 *    Freighter and submits to Horizon.
 * 3. After classic settlement, calls `vault.deposit(user, USDC, amount)` to
 *    bring funds into Soroban accounting.
 * 4. A "Pending Payouts" panel lists claimable balances for the connected
 *    address (Horizon `/claimable_balances?claimant=…`) with one-click
 *    Claim buttons.
 *
 * Pure UI / no backend. Errors surface inline.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Asset,
  Horizon,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { signTransaction as freighterSign } from "@stellar/freighter-api";
import { stellarNative } from "@stellax/sdk";
import { Button } from "@/ui/Button";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { config, hasContract } from "@/config";
import { qk } from "@/hooks/queries";

const USDC_DECIMALS = 7;

const SUPPORTED_SOURCES: { code: string; asset: () => Asset; label: string }[] = [
  { code: "XLM", asset: () => Asset.native(), label: "Stellar Lumens (XLM)" },
  {
    code: "USDC",
    asset: () => new Asset("USDC", config.contracts.usdcIssuer),
    label: "USDC",
  },
];

interface ClaimableBalance {
  id: string;
  amount: string;
  asset: string;
  sponsor?: string | undefined;
}

export function DepositPage() {
  const { address, connected, run } = useTx();
  const [sendCode, setSendCode] = useState("XLM");
  const [destAmount, setDestAmount] = useState("");
  const [pathLoading, setPathLoading] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [pathInfo, setPathInfo] = useState<{
    sendMax: string;
    path: Asset[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const qc = useQueryClient();

  const usdcAsset = new Asset("USDC", config.contracts.usdcIssuer);
  const sendEntry =
    SUPPORTED_SOURCES.find((s) => s.code === sendCode) ?? SUPPORTED_SOURCES[0]!;

  // Query Horizon strict-receive paths whenever inputs change (debounced).
  useEffect(() => {
    setPathError(null);
    setPathInfo(null);
    if (!connected || address === null || destAmount === "") return;
    const n = Number(destAmount);
    if (!Number.isFinite(n) || n <= 0) return;

    const timer = setTimeout(async () => {
      try {
        setPathLoading(true);
        const url =
          `${config.network.horizonUrl}/paths/strict-receive` +
          `?destination_asset_type=credit_alphanum4` +
          `&destination_asset_code=USDC` +
          `&destination_asset_issuer=${config.contracts.usdcIssuer}` +
          `&destination_amount=${destAmount}` +
          `&source_account=${address}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Horizon ${res.status}`);
        const json = (await res.json()) as { _embedded: { records: PathRecord[] } };
        const records = json._embedded.records;
        // Pick the path matching our send asset.
        const match = records.find((r) => {
          if (sendCode === "XLM") return r.source_asset_type === "native";
          return (
            r.source_asset_type !== "native" &&
            r.source_asset_code === sendCode &&
            r.source_asset_issuer === config.contracts.usdcIssuer
          );
        });
        if (!match) {
          setPathError(`No path from ${sendCode} → USDC for that amount.`);
          return;
        }
        const sendMaxRaw = Number(match.source_amount);
        const sendMax = (sendMaxRaw * 1.01).toFixed(7); // 1% slippage
        const pathAssets = (match.path ?? []).map((p) =>
          p.asset_type === "native"
            ? Asset.native()
            : new Asset(p.asset_code as string, p.asset_issuer as string),
        );
        setPathInfo({ sendMax, path: pathAssets });
      } catch (e) {
        setPathError((e as Error).message);
      } finally {
        setPathLoading(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [destAmount, sendCode, address, connected]);

  async function submitDeposit() {
    if (!connected || address === null || pathInfo === null) return;
    if (!hasContract(config.contracts.vault) || !hasContract(config.contracts.usdcSac)) {
      setStatusMsg("Error: Vault or USDC contract is not configured.");
      return;
    }
    setSubmitting(true);
    setStatusMsg(null);
    try {
      const nativeAmount = nativeAmountFromDecimal(destAmount, USDC_DECIMALS);
      const horizon = new Horizon.Server(config.network.horizonUrl);
      const account = await horizon.loadAccount(address);
      const tx = stellarNative.buildPathPaymentStrictReceive({
        source: account,
        networkPassphrase: config.network.passphrase,
        sendAsset: sendEntry.asset(),
        sendMax: pathInfo.sendMax,
        destination: address,
        destAsset: usdcAsset,
        destAmount,
        path: pathInfo.path,
      });
      const xdr = tx.toXDR();
      const signed = await freighterSign(xdr, {
        networkPassphrase: config.network.passphrase,
      });
      // Different freighter versions return `string` or `{ signedTxXdr, ... }`.
      const signedXdr =
        typeof signed === "string"
          ? signed
          : (signed as { signedTxXdr: string }).signedTxXdr;
      const signedTx = TransactionBuilder.fromXDR(
        signedXdr,
        config.network.passphrase,
      );
      const result = await horizon.submitTransaction(signedTx);
      setStatusMsg(`Path payment settled: ${result.hash.slice(0, 10)}…. Depositing USDC to vault…`);
      const vaultResult = await run(
        `Deposit ${destAmount} USDC to vault`,
        (sourceAccount) =>
          getClients().vault.deposit(sourceAccount, config.contracts.usdcSac, nativeAmount, {
            sourceAccount,
          }),
        {
          invalidate: [
            qk.vaultBalance(address),
            qk.vaultTokenBalance(address, config.contracts.usdcSac),
            qk.vaultTotal(),
            qk.accountHealth(address),
          ],
        },
      );
      if (vaultResult?.status === "SUCCESS") {
        setStatusMsg(
          `Path payment ${result.hash.slice(0, 10)}… and vault deposit ${vaultResult.hash.slice(0, 10)}… succeeded.`,
        );
        // Optimistic cache update — instantly bump free balance so the
        // AccountSummary / CollateralVaultCard reflect the deposit without
        // waiting for the next 4s poll cycle.
        const vaultDelta = nativeAmount * 10n ** 11n;
        qc.setQueryData<{ free: bigint; locked: bigint }>(
          qk.vaultBalance(address),
          (prev) => ({
            free: (prev?.free ?? 0n) + vaultDelta,
            locked: prev?.locked ?? 0n,
          }),
        );
      }
      await qc.invalidateQueries({ queryKey: qk.vaultBalance(address) });
      await qc.invalidateQueries({ queryKey: qk.vaultTokenBalance(address, config.contracts.usdcSac) });
    } catch (e) {
      setStatusMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-[900px] space-y-8 px-4 py-8">
      <header className="text-center">
        <h1 className="text-3xl font-semibold text-white tracking-tight mb-2">
          Deposit Anything
        </h1>
        <p className="text-base text-stella-muted max-w-2xl mx-auto">
          Pay with XLM, USDC, or any Stellar asset — receive USDC in your vault
          via a single path-payment.
        </p>
      </header>

      <div className="glass-card p-6 space-y-5">
        <div>
          <label className="text-xs uppercase tracking-wider text-stella-muted">
            Source asset
          </label>
          <select
            value={sendCode}
            onChange={(e) => setSendCode(e.target.value)}
            className="glass-input mt-1 px-3 text-sm w-full"
          >
            {SUPPORTED_SOURCES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stella-muted">
            Target USDC to deposit
          </label>
          <div className="relative flex items-center mt-1">
            <input
              type="text"
              inputMode="decimal"
              placeholder="100.00"
              value={destAmount}
              onChange={(e) => setDestAmount(e.target.value)}
              className="glass-input pl-4 pr-16 num"
            />
            <div className="absolute right-4 text-stella-muted font-semibold">
              USDC
            </div>
          </div>
        </div>

        {pathLoading && (
          <p className="text-xs text-stella-muted">Searching for cheapest path…</p>
        )}
        {pathError && (
          <p className="text-xs text-stella-short">{pathError}</p>
        )}
        {pathInfo && (
          <div className="rounded-lg border border-stella-border/50 bg-[#0a0b10]/60 p-3 text-xs text-stella-muted space-y-1">
            <div>
              You pay up to{" "}
              <span className="text-stella-gold font-semibold num">
                {pathInfo.sendMax} {sendCode}
              </span>{" "}
              (1% slippage)
            </div>
            <div>
              You receive exactly{" "}
              <span className="text-stella-long font-semibold num">
                {destAmount} USDC
              </span>
            </div>
            <div>
              Hops: {pathInfo.path.length === 0 ? "direct" : pathInfo.path.length}
            </div>
          </div>
        )}

        <Button
          variant="primary"
          className="w-full h-11 text-base font-semibold shadow-xl"
          disabled={!connected || pathInfo === null || submitting}
          onClick={() => void submitDeposit()}
        >
          {!connected
            ? "Connect Wallet"
            : submitting
              ? "Submitting…"
              : `Deposit ${destAmount || "0"} USDC`}
        </Button>

        {statusMsg && (
          <p className="text-xs text-stella-muted">{statusMsg}</p>
        )}
      </div>

      <PendingPayouts address={address} />
    </div>
  );
}

function nativeAmountFromDecimal(input: string, decimals: number): bigint {
  const clean = input.trim();
  if (!/^\d+(\.\d*)?$/.test(clean)) {
    throw new Error("Enter a positive decimal amount");
  }
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > decimals) {
    throw new Error(`Amount supports at most ${decimals} decimal places`);
  }
  const scale = 10n ** BigInt(decimals);
  const native = BigInt(whole || "0") * scale + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (native <= 0n) throw new Error("Amount must be greater than zero");
  return native;
}

interface PathRecord {
  source_asset_type: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  source_amount: string;
  path?: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
}

function PendingPayouts({ address }: { address: string | null }) {
  const qc = useQueryClient();
  const balancesQ = useQuery({
    queryKey: ["claimable-balances", address ?? ""],
    queryFn: async (): Promise<ClaimableBalance[]> => {
      if (address === null) return [];
      const url =
        `${config.network.horizonUrl}/claimable_balances` +
        `?claimant=${address}&limit=20`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Horizon ${res.status}`);
      const json = (await res.json()) as {
        _embedded: { records: ClaimableBalanceRecord[] };
      };
      return json._embedded.records.map((r) => ({
        id: r.id,
        amount: r.amount,
        asset: r.asset,
        sponsor: r.sponsor,
      }));
    },
    enabled: address !== null,
    refetchInterval: 30_000,
  });

  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function claim(balanceId: string) {
    if (address === null) return;
    setClaimingId(balanceId);
    setMsg(null);
    try {
      const horizon = new Horizon.Server(config.network.horizonUrl);
      const account = await horizon.loadAccount(address);
      const tx = stellarNative.buildClaimClaimableBalance({
        source: account,
        networkPassphrase: config.network.passphrase,
        balanceId,
      });
      const signed = await freighterSign(tx.toXDR(), {
        networkPassphrase: config.network.passphrase,
      });
      const signedXdr =
        typeof signed === "string"
          ? signed
          : (signed as { signedTxXdr: string }).signedTxXdr;
      const signedTx = TransactionBuilder.fromXDR(
        signedXdr,
        config.network.passphrase,
      );
      const result = await horizon.submitTransaction(signedTx);
      setMsg(`Claimed: ${result.hash.slice(0, 10)}…`);
      await qc.invalidateQueries({
        queryKey: ["claimable-balances", address],
      });
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setClaimingId(null);
    }
  }

  const balances = balancesQ.data ?? [];

  return (
    <div className="glass-card p-6 space-y-4">
      <div>
        <h3 className="text-xl font-semibold text-white tracking-tight">
          Pending Payouts
        </h3>
        <p className="text-sm text-stella-gold mt-1 drop-shadow-md">
          Claimable balances issued by the keeper
        </p>
      </div>

      {address === null && (
        <p className="text-sm text-stella-muted">
          Connect a wallet to view payouts.
        </p>
      )}

      {address !== null && balances.length === 0 && (
        <p className="text-sm text-stella-muted">No pending payouts.</p>
      )}

      {balances.map((b) => (
        <div
          key={b.id}
          className="flex items-center justify-between rounded-lg border border-stella-border/40 bg-[#0a0b10]/60 px-3 py-2"
        >
          <div className="text-sm">
            <span className="text-stella-long font-semibold num">
              {b.amount} {b.asset === "native" ? "XLM" : b.asset.split(":")[0]}
            </span>
            <div className="text-[10px] text-stella-muted">{b.id.slice(0, 14)}…</div>
          </div>
          <Button
            variant="ghost"
            className="h-8 px-3 text-xs border border-stella-border"
            disabled={claimingId !== null}
            onClick={() => void claim(b.id)}
          >
            {claimingId === b.id ? "Claiming…" : "Claim"}
          </Button>
        </div>
      ))}

      {msg && <p className="text-xs text-stella-muted">{msg}</p>}
    </div>
  );
}

interface ClaimableBalanceRecord {
  id: string;
  amount: string;
  asset: string;
  sponsor?: string;
}
