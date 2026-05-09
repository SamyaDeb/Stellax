// ── Perp open_position resource-budget probe ──────────────────────────────────
//
// Simulates open_position at multiple (size, leverage) combos against the
// already-deployed perp engine and prints:
//   - simulated min resource fee (stroops)
//   - cpu instructions
//   - read bytes / write bytes / footprint counts
//   - simulation success/failure (and error if any)
//
// No submission. Read-only. Use to find params that fit under the network
// per-tx budget without redeploying contracts.
//
// Run: pnpm -F @stellax/e2e exec vitest run --reporter=verbose --no-file-parallelism src/flows/perp-probe.test.ts

import { beforeAll, describe, it } from "vitest";
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";

import { getCtx, spawnUsers } from "../lib/fixtures.js";
import { invoke } from "../lib/invoke.js";
import { fetchRedStonePayload } from "../lib/redstone.js";
import {
  addrVal,
  boolVal,
  bytesVal,
  i128Val,
  u32Val,
} from "../lib/scval.js";
import { fundWithUsdc } from "../lib/stellar-classic.js";
import type { Keypair } from "@stellar/stellar-sdk";

const MARKET_XLM = 0;
const MAX_SLIPPAGE_BYPASS = 1_000_000_000;
const ALL_FEEDS = ["XLM", "BTC", "ETH", "SOL", "USDC"];

// 18-decimal base size helpers
const ONE_XLM = 1_000_000_000_000_000_000n;
const TENTH_XLM = 100_000_000_000_000_000n;
const HUNDREDTH_XLM = 10_000_000_000_000_000n;

interface Probe {
  label: string;
  size: bigint;
  leverage: number;
  isLong: boolean;
}

const PROBES: Probe[] = [
  { label: "0.01 XLM long 2x", size: HUNDREDTH_XLM, leverage: 2, isLong: true },
  { label: "0.1  XLM long 2x", size: TENTH_XLM, leverage: 2, isLong: true },
  { label: "0.1  XLM long 5x", size: TENTH_XLM, leverage: 5, isLong: true },
  { label: "1    XLM long 2x", size: ONE_XLM, leverage: 2, isLong: true },
  { label: "1    XLM long 5x", size: ONE_XLM, leverage: 5, isLong: true },
];

describe("perp-probe", () => {
  const ctx = getCtx();
  let user: Keypair;

  beforeAll(async () => {
    console.log("  ▸ refreshing oracle prices …");
    const payload = await fetchRedStonePayload(ALL_FEEDS);
    try {
      await invoke(ctx.net, ctx.deployer, ctx.deployments.oracle, "write_prices", [
        bytesVal(payload),
      ]);
    } catch (err) {
      if (!String(err).includes("#11")) throw err;
    }

    console.log("  ▸ spawning probe user, depositing 10 USDC …");
    [user] = await spawnUsers(1, "probe-user");
    await fundWithUsdc(user, 10);
    await invoke(ctx.net, user, ctx.deployments.vault, "deposit", [
      addrVal(user.publicKey()),
      addrVal(ctx.deployments.usdc),
      i128Val(100_000_000n), // 10 USDC native 7-dec
    ]);
    console.log(`    user: ${user.publicKey()}`);
  }, 180_000);

  it("probes open_position at multiple (size, leverage) combos", async () => {
    const server = new SorobanRpc.Server(ctx.net.rpcUrl, { allowHttp: false });
    const account = await server.getAccount(user.publicKey());
    const contract = new Contract(ctx.deployments.perp_engine);

    console.log("");
    console.log("  ╭───────────────────────────────────────────────────────────────────╮");
    console.log("  │ probe                  │ status   │ resourceFee │ cpu insn │ reads │ writes");
    console.log("  ├───────────────────────────────────────────────────────────────────┤");

    for (const p of PROBES) {
      // Build fresh tx (fresh seq each iteration)
      const acc = await server.getAccount(user.publicKey());
      const tx = new TransactionBuilder(acc, {
        fee: BASE_FEE,
        networkPassphrase: ctx.net.passphrase,
      })
        .addOperation(
          contract.call(
            "open_position",
            addrVal(user.publicKey()),
            u32Val(MARKET_XLM),
            i128Val(p.size),
            boolVal(p.isLong),
            u32Val(p.leverage),
            u32Val(MAX_SLIPPAGE_BYPASS),
            xdr.ScVal.scvVoid(),
          ),
        )
        .setTimeout(120)
        .build();

      let row: string;
      try {
        const sim = await server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(sim)) {
          row = `  │ ${p.label.padEnd(22)} │ SIM ERR  │ ${sim.error.slice(0, 60)}`;
        } else {
          const ok = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse;
          const data = ok.transactionData?.build();
          // SorobanTransactionData → resources + resources.footprint
          const resources = (data as unknown as { resources(): xdr.SorobanResources }).resources();
          const resourceFee = ok.minResourceFee ?? "?";
          const insn = resources.instructions();
          const readBytes = resources.diskReadBytes();
          const writeBytes = resources.writeBytes();
          const footprint = resources.footprint();
          const reads = footprint.readOnly().length;
          const writes = footprint.readWrite().length;
          row =
            `  │ ${p.label.padEnd(22)} │ OK       │ ${String(resourceFee).padStart(11)} │ ${String(insn).padStart(9)} │ R:${readBytes}B/${reads}keys W:${writeBytes}B/${writes}keys`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        row = `  │ ${p.label.padEnd(22)} │ THROW    │ ${msg.slice(0, 60)}`;
      }
      console.log(row);
    }
    console.log("  ╰───────────────────────────────────────────────────────────────────╯");

    // Dump the full write-footprint for the smallest variant: which contracts/keys are written?
    console.log("");
    console.log("  ▸ write footprint detail for 0.01 XLM long 2x:");
    const acc3 = await server.getAccount(user.publicKey());
    const detailTx = new TransactionBuilder(acc3, {
      fee: BASE_FEE,
      networkPassphrase: ctx.net.passphrase,
    })
      .addOperation(
        contract.call(
          "open_position",
          addrVal(user.publicKey()),
          u32Val(MARKET_XLM),
          i128Val(HUNDREDTH_XLM),
          boolVal(true),
          u32Val(2),
          u32Val(MAX_SLIPPAGE_BYPASS),
          xdr.ScVal.scvVoid(),
        ),
      )
      .setTimeout(120)
      .build();
    const detailSim = await server.simulateTransaction(detailTx) as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const detailData = detailSim.transactionData!.build();
    const detailRes = (detailData as unknown as { resources(): xdr.SorobanResources }).resources();
    const detailFp = detailRes.footprint();
    const contractIdToLabel: Record<string, string> = {
      [ctx.deployments.perp_engine]: "perp_engine",
      [ctx.deployments.vault]: "vault",
      [ctx.deployments.oracle]: "oracle",
      [ctx.deployments.risk]: "risk",
      [ctx.deployments.funding]: "funding",
      [ctx.deployments.usdc]: "usdc",
      [ctx.deployments.governor]: "governor",
    };
    function describeKey(le: xdr.LedgerKey): string {
      const t = le.switch().name;
      if (t === "contractData") {
        const cd = le.contractData();
        const addr = cd.contract();
        const cidBytes = addr.switch().name === "scAddressTypeContract"
          ? addr.contractId()
          : null;
        let cidStr = "";
        if (cidBytes) {
          // Encode as Stellar StrKey C... — fall back to hex
          try {
            const StrKey = (require("/Users/samya/Downloads/stellax/node_modules/@stellar/stellar-sdk")).StrKey;
            cidStr = StrKey.encodeContract(cidBytes);
          } catch {
            cidStr = Buffer.from(cidBytes).toString("hex");
          }
        }
        const label = contractIdToLabel[cidStr] ?? `${cidStr.slice(0, 8)}…`;
        let keyDesc = "";
        const k = cd.key();
        const ks = k.switch().name;
        if (ks === "scvLedgerKeyContractInstance") {
          keyDesc = "<instance>";
        } else if (ks === "scvVec") {
          const v = k.vec();
          if (v && v.length > 0 && v[0].switch().name === "scvSymbol") {
            keyDesc = `[${v[0].sym().toString()}, ...×${v.length - 1}]`;
          } else keyDesc = `<vec×${v?.length ?? 0}>`;
        } else if (ks === "scvSymbol") {
          keyDesc = k.sym().toString();
        } else {
          keyDesc = `<${ks}>`;
        }
        return `${label}::${keyDesc}`;
      }
      return `<${t}>`;
    }
    console.log(`    readOnly  (${detailFp.readOnly().length}):`);
    for (const le of detailFp.readOnly()) console.log(`      RO  ${describeKey(le)}`);
    console.log(`    readWrite (${detailFp.readWrite().length}):`);
    for (const le of detailFp.readWrite()) console.log(`      RW  ${describeKey(le)}`);
    console.log(`    writeBytes total: ${detailRes.writeBytes()}`);

    // Submit the smallest variant to capture the actual on-chain rejection (if any).
    console.log("");
    console.log("  ▸ submitting 0.01 XLM long 2x to capture on-chain response …");
    const acc2 = await server.getAccount(user.publicKey());
    const submitTx = new TransactionBuilder(acc2, {
      fee: BASE_FEE,
      networkPassphrase: ctx.net.passphrase,
    })
      .addOperation(
        contract.call(
          "open_position",
          addrVal(user.publicKey()),
          u32Val(MARKET_XLM),
          i128Val(HUNDREDTH_XLM),
          boolVal(true),
          u32Val(2),
          u32Val(MAX_SLIPPAGE_BYPASS),
          xdr.ScVal.scvVoid(),
        ),
      )
      .setTimeout(120)
      .build();
    const submitSim = await server.simulateTransaction(submitTx);
    if (SorobanRpc.Api.isSimulationError(submitSim)) {
      console.log(`    submit-sim error: ${submitSim.error}`);
      return;
    }
    const prepared = SorobanRpc.assembleTransaction(submitTx, submitSim).build();
    console.log(`    assembled inclusion+resource fee: ${prepared.fee}`);
    console.log(`    assembled minResourceFee from sim: ${(submitSim as SorobanRpc.Api.SimulateTransactionSuccessResponse).minResourceFee}`);
    prepared.sign(user);
    try {
      const send = await server.sendTransaction(prepared);
      console.log(`    sendTransaction.status: ${send.status}`);
      console.log(`    sendTransaction.hash:   ${send.hash}`);
      if (send.status === "ERROR" && send.errorResult) {
        const inner = send.errorResult.result();
        console.log(`    errorResult outer:      ${inner.switch().name}`);
        const events = (send as unknown as { diagnosticEvents?: xdr.DiagnosticEvent[] }).diagnosticEvents;
        if (events?.length) {
          console.log(`    diagnosticEvents:       ${events.length} events`);
          for (const ev of events) {
            const evBody = ev.event().body();
            if (evBody.switch().name === "v0") {
              const v0 = evBody.v0();
              const topics = v0.topics().map((t) => t.toXDR("base64").slice(0, 30));
              console.log(`      topics: ${JSON.stringify(topics)}`);
              const data = v0.data();
              if (data.switch().name === "scvVec") {
                const vec = data.vec() ?? [];
                for (const item of vec) {
                  if (item.switch().name === "scvString") {
                    console.log(`      string: "${item.str().toString()}"`);
                  } else if (item.switch().name === "scvU32") {
                    console.log(`      u32:    ${item.u32()}`);
                  } else if (item.switch().name === "scvU64") {
                    console.log(`      u64:    ${item.u64().toString()}`);
                  } else if (item.switch().name === "scvI32") {
                    console.log(`      i32:    ${item.i32()}`);
                  } else {
                    console.log(`      ${item.switch().name}: ${item.toXDR("base64").slice(0, 60)}`);
                  }
                }
              }
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    submit threw: ${msg}`);
    }
  }, 300_000);
});
