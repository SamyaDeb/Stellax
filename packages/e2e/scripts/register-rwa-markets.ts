#!/usr/bin/env tsx
/**
 * Register RWA perp markets (BENJI/100, USDY/101, OUSG/102) on-chain.
 * USDY and OUSG are already registered; this script only needs to register BENJI.
 * Retries on txBadSeq (keeper shares the deployer account).
 *
 * Run: cd packages/e2e && npx tsx scripts/register-rwa-markets.ts
 */

import {
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  rpc as SorobanRpc,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";

const RPC_URL    = "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const PERP_ENGINE = "CDK7LFB334FDFEB5VHFAPTDJGDMTAVXTJQDCCHC2SUMEYLR7ZDQEYYYZ";

const server = new SorobanRpc.Server(RPC_URL);

// ── ScVal helpers ────────────────────────────────────────────────────────────
function sym(s: string): xdr.ScVal { return xdr.ScVal.scvSymbol(Buffer.from(s, "utf8")); }
function u32(n: number): xdr.ScVal { return xdr.ScVal.scvU32(n); }
function i128(n: bigint): xdr.ScVal { return nativeToScVal(n, { type: "i128" }); }
function bool(b: boolean): xdr.ScVal { return xdr.ScVal.scvBool(b); }

function mapVal(entries: [string, xdr.ScVal][]): xdr.ScVal {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
  return xdr.ScVal.scvMap(
    sorted.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })),
  );
}

function marketVal(
  marketId: number, baseAsset: string, quoteAsset: string,
  maxLeverage: number, makerFeeBps: number, takerFeeBps: number,
  maxOiLong: bigint, maxOiShort: bigint, isActive: boolean,
): xdr.ScVal {
  return mapVal([
    ["base_asset",    sym(baseAsset)],
    ["is_active",     bool(isActive)],
    ["maker_fee_bps", u32(makerFeeBps)],
    ["market_id",     u32(marketId)],
    ["max_leverage",  u32(maxLeverage)],
    ["max_oi_long",   i128(maxOiLong)],
    ["max_oi_short",  i128(maxOiShort)],
    ["quote_asset",   sym(quoteAsset)],
    ["taker_fee_bps", u32(takerFeeBps)],
  ]);
}

function loadDeployerKeypair(): Keypair {
  const r = spawnSync("stellar", ["keys", "show", "stellax-deployer"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show failed: ${r.stderr}`);
  return Keypair.fromSecret(r.stdout.trim());
}

// ── Invoke with txBadSeq retry ────────────────────────────────────────────────
async function invoke(
  signer: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<void> {
  const contract = new Contract(contractId);

  for (let attempt = 0; attempt < 8; attempt++) {
    // Re-fetch sequence every attempt.
    const acct  = await server.getAccount(signer.publicKey());
    const raw   = new TransactionBuilder(acct, { fee: "100000", networkPassphrase: PASSPHRASE })
      .addOperation(contract.call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(raw);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate(${method}) failed: ${sim.error}`);
    }
    const prep = SorobanRpc.assembleTransaction(raw, sim).build();
    prep.sign(signer);

    let send = await server.sendTransaction(prep);
    for (let i = 0; i < 5 && send.status === "TRY_AGAIN_LATER"; i++) {
      await new Promise(r => setTimeout(r, 1500));
      send = await server.sendTransaction(prep);
    }

    if (send.status === "ERROR") {
      const err = JSON.stringify(send.errorResult ?? {});
      if (err.includes("txBadSeq")) {
        console.log(`  ↻ txBadSeq on attempt ${attempt + 1} — waiting 4s and retrying`);
        await new Promise(r => setTimeout(r, 4000));
        continue; // retry with fresh sequence
      }
      throw new Error(`sendTransaction(${method}) rejected: ${err}`);
    }

    // Poll until terminal.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const got = await server.getTransaction(send.hash);
      if (got.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        console.log(`  ✓ ${method} confirmed (hash: ${send.hash.slice(0, 12)}…)`);
        return;
      }
      if (got.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const res = (got as SorobanRpc.Api.GetFailedTransactionResponse).resultXdr;
        throw new Error(`${method} failed on-chain: ${res?.toXDR("base64")}`);
      }
    }
    throw new Error(`${method} timed out`);
  }
  throw new Error(`${method} failed after 8 txBadSeq retries`);
}

// ── Constants ────────────────────────────────────────────────────────────────
const SKEW_SCALE        = 1_000_000_000_000_000_000_000_000n; // 10^24 (same as BTC/ETH)
const MIN_POSITION_SIZE = 1_000_000_000_000_000_000n;          // 1 token in 18-dec
const MAKER_REBATE_BPS  = 0;
const MAX_OI            = 100_000_000_000_000_000_000n;         // 100 tokens in 18-dec

const RWA_MARKETS = [
  { marketId: 100, baseAsset: "BENJI", quoteAsset: "USD", maxLeverage: 3, makerFeeBps: 5, takerFeeBps: 15 },
  { marketId: 101, baseAsset: "USDY",  quoteAsset: "USD", maxLeverage: 3, makerFeeBps: 5, takerFeeBps: 15 },
  { marketId: 102, baseAsset: "OUSG",  quoteAsset: "USD", maxLeverage: 3, makerFeeBps: 5, takerFeeBps: 15 },
];

async function main() {
  console.log("=== Registering RWA Markets ===\n");
  const deployer = loadDeployerKeypair();
  console.log(`Deployer: ${deployer.publicKey()}\n`);

  for (const m of RWA_MARKETS) {
    console.log(`Registering ${m.baseAsset} (market ${m.marketId})…`);
    try {
      await invoke(deployer, PERP_ENGINE, "register_market", [
        marketVal(m.marketId, m.baseAsset, m.quoteAsset, m.maxLeverage,
                  m.makerFeeBps, m.takerFeeBps, MAX_OI, MAX_OI, true),
        i128(MIN_POSITION_SIZE),
        i128(SKEW_SCALE),
        u32(MAKER_REBATE_BPS),
      ]);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("#4") || msg.includes("MarketExists")) {
        console.log(`  → already registered — skipping`);
      } else {
        console.error(`  ✗ FAILED: ${msg.slice(0, 300)}`);
      }
    }
  }

  console.log("\nVerification:");
  for (const m of RWA_MARKETS) {
    try {
      const acct = new (await import("@stellar/stellar-sdk")).Account(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"
      );
      const raw = new TransactionBuilder(acct, { fee: "100000", networkPassphrase: PASSPHRASE })
        .addOperation(new Contract(PERP_ENGINE).call("get_skew_state", u32(m.marketId)))
        .setTimeout(60).build();
      const sim = await server.simulateTransaction(raw);
      if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(sim.error);
      const { scValToNative } = await import("@stellar/stellar-sdk");
      const res = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      const state = res ? scValToNative(res) as Record<string,unknown> : {};
      console.log(`  ${m.baseAsset}(${m.marketId}): skew_scale=${state.skew_scale} ✓`);
    } catch (e) {
      console.log(`  ${m.baseAsset}(${m.marketId}): STILL FAILING — ${(e as Error).message.slice(0,100)}`);
    }
  }
}

main().catch(console.error);
