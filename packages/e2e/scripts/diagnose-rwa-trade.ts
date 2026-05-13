#!/usr/bin/env tsx
/**
 * Diagnostic: query on-chain skew state for RWA markets and simulate
 * open_position with the same size the frontend would send.
 *
 * Run: cd packages/e2e && npx tsx scripts/diagnose-rwa-trade.ts
 */

import {
  Account,
  Contract,
  Networks,
  TransactionBuilder,
  rpc as SorobanRpc,
  scValToNative,
  nativeToScVal,
  xdr,
  Address,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

const PERP_ENGINE  = "CDK7LFB334FDFEB5VHFAPTDJGDMTAVXTJQDCCHC2SUMEYLR7ZDQEYYYZ";
const ORACLE       = "CCESFJNJ3HS6DH2ZOSGSPMHH2GHE4MWJCWQR5A3RGLZYVZ37E5WBZEXB";
const VAULT        = "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM";

// Deterministic simulation source (no real account needed).
const SIM_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const server = new SorobanRpc.Server(RPC_URL);

function sym(s: string): xdr.ScVal { return xdr.ScVal.scvSymbol(Buffer.from(s, "utf8")); }
function u32(n: number): xdr.ScVal { return xdr.ScVal.scvU32(n); }
function i128(n: bigint): xdr.ScVal { return nativeToScVal(n, { type: "i128" }); }
function bool(b: boolean): xdr.ScVal { return xdr.ScVal.scvBool(b); }
function addr(s: string): xdr.ScVal { return new Address(s).toScVal(); }

async function simulateCall(contractId: string, method: string, args: xdr.ScVal[]) {
  const account = new Account(SIM_SOURCE, "0");
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} failed: ${sim.error}`);
  }
  const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result;
  return result?.retval ? scValToNative(result.retval) : undefined;
}

async function main() {
  console.log("=== RWA Trade Diagnostic ===\n");

  // 1. Query oracle prices for RWA feeds.
  for (const feed of ["USDY", "OUSG", "BENJI"]) {
    try {
      const data = await simulateCall(ORACLE, "get_price", [sym(feed)]) as {
        price: bigint; package_timestamp: bigint; write_timestamp: bigint;
      };
      const priceUsd = Number(data.price) / 1e18;
      const ageS = Math.floor(Date.now() / 1000) - Number(data.write_timestamp);
      console.log(`Oracle ${feed}: price=$${priceUsd.toFixed(6)} (${data.price}n), age=${ageS}s`);
    } catch (e) {
      console.log(`Oracle ${feed}: ERROR — ${(e as Error).message}`);
    }
  }

  console.log();

  // 2. Query skew state for all markets including RWA.
  for (const [name, id] of [["XLM",0],["BTC",1],["ETH",2],["BENJI",100],["USDY",101],["OUSG",102]] as [string,number][]) {
    try {
      const state = await simulateCall(PERP_ENGINE, "get_skew_state", [u32(id)]) as {
        skew: bigint; skew_scale: bigint; maker_rebate_bps: number;
      };
      console.log(`SkewState ${name}(${id}): skew=${state.skew}n skew_scale=${state.skew_scale}n maker_rebate=${state.maker_rebate_bps}bps`);
    } catch (e) {
      console.log(`SkewState ${name}(${id}): ERROR — ${(e as Error).message}`);
    }
  }

  console.log();

  // 3. Simulate open_position for USDY with the same parameters as the frontend.
  //    Frontend: user enters "$10", price ~1.13
  //    sizeInBaseAsset = (10 * 1e18 * 1e18) / (1.13 * 1e18) ≈ 8.85 * 1e18

  const USDC_SCALE = 10n ** 18n;
  const usdNotional = 10n * USDC_SCALE;  // $10 in 18-dec
  // Use a price; we'll fetch from oracle or use a hardcoded fallback.
  let usdyPrice18 = 1_130_000_000_000_000_000n; // $1.13 * 1e18

  try {
    const oracleData = await simulateCall(ORACLE, "get_price", [sym("USDY")]) as {
      price: bigint;
    };
    usdyPrice18 = oracleData.price;
    console.log(`Using live USDY price: $${Number(usdyPrice18)/1e18}`);
  } catch {
    console.log(`Using fallback USDY price: $${Number(usdyPrice18)/1e18}`);
  }

  const sizeInBaseAsset = (usdNotional * USDC_SCALE) / usdyPrice18;
  console.log(`\nFrontend would send size = ${sizeInBaseAsset}n (${Number(sizeInBaseAsset)/1e18} USDY)`);

  // Also test with 7-decimal scale (raw USDC notional / no conversion)
  const sizeRaw7dec = usdNotional / (10n ** 11n); // 10^18 → 10^7
  console.log(`Alternative: 7-dec size = ${sizeRaw7dec}n`);

  // Test various sizes.
  const testCases: Array<{ label: string; size: bigint }> = [
    { label: "1 USDY (1e18)",         size: 1_000_000_000_000_000_000n },
    { label: "$10 notional (18-dec)", size: sizeInBaseAsset },
    { label: "0.001 USDY",            size: 1_000_000_000_000_000n },
    { label: "tiny (1n)",             size: 1n },
  ];

  const dummyUser = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  console.log();
  for (const tc of testCases) {
    try {
      const result = await simulateCall(PERP_ENGINE, "open_position", [
        addr(dummyUser),
        u32(101),          // USDY market
        i128(tc.size),
        bool(true),        // long
        u32(2),            // 2x leverage
        u32(1_000_000_000), // bypass slippage
        xdr.ScVal.scvVoid(),
      ]);
      console.log(`open_position(${tc.label}): OK — result=${JSON.stringify(result)}`);
    } catch (e) {
      console.log(`open_position(${tc.label}): FAIL — ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // 4a. Read full market struct (shows max_oi_long).
  console.log("\n=== Market details ===");
  for (const [name, id] of [["USDY",101],["OUSG",102],["BENJI",100]] as [string,number][]) {
    try {
      const m = await simulateCall(PERP_ENGINE, "get_market", [u32(id)]) as Record<string,unknown>;
      console.log(`${name}(${id}): max_oi_long=${m.max_oi_long} max_leverage=${m.max_leverage}`);
    } catch (e) {
      console.log(`${name}(${id}): ${(e as Error).message.split("\n")[0]}`);
    }
  }

  // 4b. Check if Market struct exists (distinguishes "never registered" vs "missing V2 state").
  console.log("\n=== Market struct existence ===");
  for (const [name, id] of [["BENJI",100],["USDY",101],["OUSG",102]] as [string,number][]) {
    try {
      const m = await simulateCall(PERP_ENGINE, "get_market", [u32(id)]) as Record<string,unknown>;
      console.log(`get_market(${name}/${id}): EXISTS — base_asset=${m.base_asset} is_active=${m.is_active}`);
    } catch (e) {
      console.log(`get_market(${name}/${id}): ${(e as Error).message.split("\n")[0]}`);
    }
  }

  console.log("\nDone.");
}

main().catch(console.error);
