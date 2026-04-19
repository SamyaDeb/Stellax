// ── Full deployment + wiring orchestration ────────────────────────────────────

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { deployContract, deploySacAsset, invoke } from "./soroban.js";
import {
  invokeSDK,
  addrVal,
  i128Val,
  u32Val,
  u64Val,
  symbolVal,
  mapVal,
} from "./sdkinvoke.js";
import {
  CIRCLE_TESTNET_USDC_ISSUER,
  REDSTONE_PRIMARY_SIGNER_EVM,
  emptyDeployment,
  type Deployment,
  type Network,
  type NetworkSection,
  type MarketDef,
} from "./config.js";

// ── CLI arg helpers (used for invoke() calls that have no enum UDT args) ──────

function arg(name: string, value: string | number | bigint | boolean): string[] {
  return [`--${name}`, String(value)];
}

function jarg(name: string, value: unknown): string[] {
  return [`--${name}`, JSON.stringify(value)];
}

function hexBytes(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2).toLowerCase() : hex.toLowerCase();
}

// ── Checkpoint helpers ────────────────────────────────────────────────────────

/** Write deployment state to disk after each major step so reruns can resume. */
function checkpoint(outDir: string, dep: Deployment): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${dep.network}.json`),
    JSON.stringify(dep, null, 2) + "\n",
  );
}

/** Load a previous partial deployment if one exists. */
function loadCheckpoint(outDir: string, network: Network): Deployment | null {
  const p = join(outDir, `${network}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Deployment;
  } catch {
    return null;
  }
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export interface DeployArgs {
  repoRoot: string;
  network: Network;
  netCfg: NetworkSection;
  markets: MarketDef[];
  deployer: string;       // G...
  identity: string;       // CLI identity name
}

export async function runDeploy(args: DeployArgs): Promise<Deployment> {
  const { repoRoot, network, netCfg, markets, deployer, identity } = args;
  const net = network;
  const outDir = join(repoRoot, "deployments");

  // Resume from checkpoint if present.
  const saved = loadCheckpoint(outDir, network);
  const dep: Deployment = saved ?? emptyDeployment(
    network, netCfg.network_passphrase, netCfg.rpc_url, identity,
  );
  dep.deployer = deployer;
  if (saved) {
    console.log("  ↻ resuming from checkpoint");
  }

  const rpcUrl = netCfg.rpc_url;
  const passphrase = netCfg.network_passphrase;

  // ── Step 1: USDC SAC ───────────────────────────────────────────────────────
  if (!dep.usdc_token) {
    console.log("\n═══ 1. USDC collateral (Circle testnet issuer) ═══════════════");
    const usdc = network === "testnet"
      ? deploySacAsset(net, identity, "USDC", CIRCLE_TESTNET_USDC_ISSUER)
      : "<mainnet-USDC-SAC-TBD>";
    dep.usdc_token = usdc;
    console.log(`   USDC SAC: ${usdc}`);
    checkpoint(outDir, dep);
  } else {
    console.log(`\n═══ 1. USDC (cached: ${dep.usdc_token}) ═════════════════════`);
  }
  const usdc = dep.usdc_token!;
  const admin = deployer;
  if (!dep.contracts.governor) {
    console.log("\n═══ 2. Governor ══════════════════════════════════════════════");
    const governor = deployContract({
      repoRoot, contract: "stellax_governor", network: net, source: identity,
    });
    dep.contracts.governor = governor.contractId;
    dep.wasm_hashes["stellax_governor"] = governor.wasmHash;
    checkpoint(outDir, dep);

    invoke(net, identity, governor.contractId, "initialize", [
      ...jarg("multisig", [deployer]),
      ...arg("threshold", 1),
      ...arg("timelock_ledgers", 0),
      ...arg("guardian", deployer),
    ]);
  } else {
    console.log(`\n═══ 2. Governor (cached: ${dep.contracts.governor}) ══════════`);
  }

  // ── Step 3: Oracle ─────────────────────────────────────────────────────────
  if (!dep.contracts.oracle) {
    console.log("\n═══ 3. Oracle ════════════════════════════════════════════════");
    const oracle = deployContract({
      repoRoot, contract: "stellax_oracle", network: net, source: identity,
      ctorArgs: [
        ...arg("admin", admin),
        ...jarg("signers", [hexBytes(REDSTONE_PRIMARY_SIGNER_EVM)]),
        ...arg("signer_count_threshold", netCfg.redstone_signer_threshold ?? 1),
        ...arg("max_timestamp_staleness_ms", netCfg.redstone_max_staleness_ms ?? 60000),
        ...jarg("feed_ids", ["XLM", "BTC", "ETH", "SOL"]),
      ],
    });
    dep.contracts.oracle = oracle.contractId;
    dep.wasm_hashes["stellax_oracle"] = oracle.wasmHash;
    checkpoint(outDir, dep);
  } else {
    console.log(`\n═══ 3. Oracle (cached: ${dep.contracts.oracle}) ══════════════`);
  }
  const oracleId = dep.contracts.oracle!;

  // ── Step 4: Treasury ───────────────────────────────────────────────────────
  if (!dep.contracts.treasury) {
    console.log("\n═══ 4. Treasury ══════════════════════════════════════════════");
    const treasury = deployContract({
      repoRoot, contract: "stellax_treasury", network: net, source: identity,
    });
    dep.contracts.treasury = treasury.contractId;
    dep.wasm_hashes["stellax_treasury"] = treasury.wasmHash;
    checkpoint(outDir, dep);

    invoke(net, identity, treasury.contractId, "initialize", [
      ...arg("admin", admin),
      ...arg("insurance_fund", admin),
      ...arg("insurance_cap", 1_000_000_000_000_000_000_000n.toString()),
    ]);
  } else {
    console.log(`\n═══ 4. Treasury (cached: ${dep.contracts.treasury}) ══════════`);
  }
  const treasuryId = dep.contracts.treasury!;
  const insuranceFundId = treasuryId; // reuse treasury as insurance fund

  // ── Step 5: Vault ──────────────────────────────────────────────────────────
  if (!dep.contracts.vault) {
    console.log("\n═══ 5. Vault (risk=deployer placeholder, rewired in step 12) ═");
    const vault = deployContract({
      repoRoot, contract: "stellax_vault", network: net, source: identity,
      ctorArgs: [
        ...arg("admin", admin),
        ...arg("oracle", oracleId),
        ...arg("risk", admin), // placeholder
        ...arg("treasury", treasuryId),
        ...arg("insurance_fund", insuranceFundId),
        ...jarg("authorized_callers", [admin]),
        ...jarg("collateral_configs", [
          {
            token_address: usdc,
            asset_symbol: "USDC",
            decimals: 7,
            haircut_bps: 0,
            max_deposit_cap: "1000000000000000000000000",
            is_active: true,
          },
        ]),
      ],
    });
    dep.contracts.vault = vault.contractId;
    dep.wasm_hashes["stellax_vault"] = vault.wasmHash;
    checkpoint(outDir, dep);
  } else {
    console.log(`\n═══ 5. Vault (cached: ${dep.contracts.vault}) ════════════════`);
  }
  const vaultId = dep.contracts.vault!;

  // ── Step 6: Funding ────────────────────────────────────────────────────────
  if (!dep.contracts.funding) {
    console.log("\n═══ 6. Funding ═══════════════════════════════════════════════");
    const funding = deployContract({
      repoRoot, contract: "stellax_funding", network: net, source: identity,
      ctorArgs: [
        ...arg("admin", admin),
        ...arg("oracle", oracleId),
        ...arg("perp_engine", admin), // placeholder
        ...arg("funding_factor", 100_000_000_000_000n.toString()),
      ],
    });
    dep.contracts.funding = funding.contractId;
    dep.wasm_hashes["stellax_funding"] = funding.wasmHash;
    checkpoint(outDir, dep);
  } else {
    console.log(`\n═══ 6. Funding (cached: ${dep.contracts.funding}) ════════════`);
  }
  const fundingId = dep.contracts.funding!;

  // ── Step 7: Risk ───────────────────────────────────────────────────────────
  if (!dep.contracts.risk) {
    console.log("\n═══ 7. Risk ══════════════════════════════════════════════════");
    const risk = deployContract({
      repoRoot, contract: "stellax_risk", network: net, source: identity,
      ctorArgs: [
        ...arg("admin", admin),
        ...arg("vault", vaultId),
        ...arg("perp_engine", admin), // placeholder
        ...arg("funding", fundingId),
        ...arg("oracle", oracleId),
        ...arg("insurance_fund", insuranceFundId),
        ...arg("treasury", treasuryId),
        ...arg("settlement_token", usdc),
      ],
    });
    dep.contracts.risk = risk.contractId;
    dep.wasm_hashes["stellax_risk"] = risk.wasmHash;
    checkpoint(outDir, dep);
  } else {
    console.log(`\n═══ 7. Risk (cached: ${dep.contracts.risk}) ══════════════════`);
  }
  const riskId = dep.contracts.risk!;

  // ── Step 8: Perp engine ────────────────────────────────────────────────────
  if (!dep.contracts.perp_engine) {
    console.log("\n═══ 8. Perp engine ═══════════════════════════════════════════");
    const perp = deployContract({
      repoRoot, contract: "stellax_perp_engine", network: net, source: identity,
      ctorArgs: [
        ...arg("admin", admin),
        ...arg("oracle", oracleId),
        ...arg("vault", vaultId),
        ...arg("funding", fundingId),
        ...arg("risk", riskId),
        ...arg("treasury", treasuryId),
        ...arg("settlement_token", usdc),
      ],
    });
    dep.contracts.perp_engine = perp.contractId;
    dep.wasm_hashes["stellax_perp_engine"] = perp.wasmHash;
    checkpoint(outDir, dep);
  } else {
    console.log(`\n═══ 8. Perp (cached: ${dep.contracts.perp_engine}) ═══════════`);
  }
  const perpId = dep.contracts.perp_engine!;

  // ── Step 9: Options ────────────────────────────────────────────────────────
  if (!dep.contracts.options) {
    console.log("\n═══ 9. Options ═══════════════════════════════════════════════");
    const options = deployContract({
      repoRoot, contract: "stellax_options", network: net, source: identity,
    });
    dep.contracts.options = options.contractId;
    dep.wasm_hashes["stellax_options"] = options.wasmHash;
    checkpoint(outDir, dep);

    invoke(net, identity, options.contractId, "initialize", [
      ...arg("admin", admin),
      ...arg("keeper", admin),
      ...arg("vault", vaultId),
      ...arg("oracle", oracleId),
      ...arg("treasury", treasuryId),
      ...arg("insurance_fund", insuranceFundId),
    ]);
  } else {
    console.log(`\n═══ 9. Options (cached: ${dep.contracts.options}) ════════════`);
  }
  const optionsId = dep.contracts.options!;

  // ── Step 10: Structured ────────────────────────────────────────────────────
  if (!dep.contracts.structured) {
    console.log("\n═══ 10. Structured ═══════════════════════════════════════════");
    const structured = deployContract({
      repoRoot, contract: "stellax_structured", network: net, source: identity,
    });
    dep.contracts.structured = structured.contractId;
    dep.wasm_hashes["stellax_structured"] = structured.wasmHash;
    checkpoint(outDir, dep);

    // stellar-cli v23.4.1 panics on UdtEnumV0 (VaultKind enum).
    // Use JS SDK directly to build the ScVal for StructuredConfig.
    console.log(`» invokeSDK ${structured.contractId.slice(0, 12)}… initialize`);
    await invokeSDK(rpcUrl, passphrase, identity, structured.contractId, "initialize", [
      // StructuredConfig as ScvMap — fields in declaration order.
      mapVal([
        ["admin",                  addrVal(admin)],
        ["keeper",                 addrVal(admin)],
        ["options_contract",       addrVal(optionsId)],
        ["vault_contract",         addrVal(vaultId)],
        ["oracle_contract",        addrVal(oracleId)],
        ["treasury",               addrVal(treasuryId)],
        ["underlying_token",       addrVal(usdc)],
        ["underlying_asset_symbol", symbolVal("USDC")],
        ["option_market_id",       u32Val(0)],
        ["epoch_duration",         u64Val(7 * 24 * 60 * 60)],   // 1 week
        ["strike_delta_bps",       u32Val(1000)],               // 10% OTM
        ["premium_budget_bps",     u32Val(100)],                // 1%
        ["max_vault_cap",          i128Val(100_000_000_000_000_000_000_000n)],
        ["performance_fee_bps",    u32Val(1000)],               // 10%
        ["kind",                   u32Val(0)],                  // VaultKind::CoveredCall = 0
      ]),
    ]);
  } else {
    console.log(`\n═══ 10. Structured (cached: ${dep.contracts.structured}) ═════`);
  }

  // ── Step 11: Bridge ────────────────────────────────────────────────────────
  if (!dep.contracts.bridge) {
    console.log("\n═══ 11. Bridge ═══════════════════════════════════════════════");
    const bridge = deployContract({
      repoRoot, contract: "stellax_bridge", network: net, source: identity,
    });
    dep.contracts.bridge = bridge.contractId;
    dep.wasm_hashes["stellax_bridge"] = bridge.wasmHash;
    checkpoint(outDir, dep);

    if (netCfg.axelar_gateway && netCfg.axelar_gas_service) {
      invoke(net, identity, bridge.contractId, "initialize", [
        ...jarg("config", {
          admin,
          gateway: netCfg.axelar_gateway,
          gas_service: netCfg.axelar_gas_service,
          its: netCfg.axelar_gas_service,
          vault: vaultId,
          treasury: treasuryId,
          protocol_fee_bps: 5,
        }),
      ]);
    } else {
      console.log("   (skipped bridge.initialize — axelar not configured)");
    }
  } else {
    console.log(`\n═══ 11. Bridge (cached: ${dep.contracts.bridge}) ════════════`);
  }
  const bridgeId = dep.contracts.bridge!;

  // ── Step 12: Post-deploy wiring ────────────────────────────────────────────
  // Mark wiring done with a sentinel in wasm_hashes so reruns don't re-wire.
  if (!dep.wasm_hashes["__wired__"]) {
    console.log("\n═══ 12. Post-deploy wiring ═══════════════════════════════════");

    console.log("   → vault.update_dependencies(risk=real)");
    invoke(net, identity, vaultId, "update_dependencies", [
      ...arg("oracle", oracleId),
      ...arg("risk", riskId),
      ...arg("treasury", treasuryId),
      ...arg("insurance_fund", insuranceFundId),
    ]);

    console.log("   → funding.update_config(perp_engine=real)");
    invoke(net, identity, fundingId, "update_config", [
      ...arg("oracle", oracleId),
      ...arg("perp_engine", perpId),
      ...arg("funding_factor", 100_000_000_000_000n.toString()),
    ]);

    console.log("   → risk.update_dependencies(perp_engine=real)");
    invoke(net, identity, riskId, "update_dependencies", [
      ...arg("vault", vaultId),
      ...arg("perp_engine", perpId),
      ...arg("funding", fundingId),
      ...arg("oracle", oracleId),
      ...arg("insurance_fund", insuranceFundId),
      ...arg("treasury", treasuryId),
      ...arg("settlement_token", usdc),
    ]);

    // Vault: authorize perp + options + risk as callers.
    for (const caller of [perpId, optionsId, riskId]) {
      invoke(net, identity, vaultId, "add_authorized_caller", [
        ...arg("caller", caller),
      ]);
    }

    // Treasury: authorize perp, options, risk as fee sources.
    for (const src of [perpId, optionsId, riskId]) {
      invoke(net, identity, treasuryId, "add_authorized_source", [
        ...arg("source", src),
      ]);
    }

    // Register markets on perp and options engines.
    for (const m of markets) {
      invoke(net, identity, perpId, "register_market", [
        ...jarg("market", {
          market_id: m.id,
          base_asset: m.base,
          quote_asset: m.quote,
          max_leverage: m.max_leverage,
          maker_fee_bps: m.maker_fee_bps,
          taker_fee_bps: m.taker_fee_bps,
          max_oi_long: "100000000000000000000",
          max_oi_short: "100000000000000000000",
          is_active: true,
        }),
        ...arg("min_position_size", "1000000000000000"),
        ...arg("price_impact_factor", "100000000000000"),
        ...arg("base_reserve", "1000000000000000000000"),
        ...arg("quote_reserve", "100000000000000000000000"),
      ]);
      invoke(net, identity, optionsId, "register_market", [
        ...arg("market_id", m.id),
        ...arg("base_asset", m.base),
        ...arg("is_active", true),
      ]);
    }

    // Bridge: register Axelar trusted source for Avalanche.
    if (netCfg.axelar_gateway && network === "testnet") {
      invoke(net, identity, bridgeId, "set_trusted_source", [
        ...arg("chain_name", "Avalanche"),
        ...arg("remote_address", "0x0000000000000000000000000000000000000000"),
      ]);
    }

    dep.wasm_hashes["__wired__"] = "true";
    checkpoint(outDir, dep);
    console.log("   ✓ wiring complete");
  } else {
    console.log("\n═══ 12. Post-deploy wiring (cached: already done) ════════════");
  }

  return dep;
}

// ── Serialization outputs ─────────────────────────────────────────────────────

export function writeDeploymentFiles(
  repoRoot: string,
  dep: Deployment,
): { json: string; env: string } {
  const outDir = join(repoRoot, "deployments");
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, `${dep.network}.json`);
  writeFileSync(jsonPath, JSON.stringify(dep, null, 2) + "\n");

  const envPath = join(outDir, `${dep.network}.env`);
  const env = [
    `# StellaX ${dep.network} deployment — generated ${dep.deployed_at}`,
    `STELLAX_NETWORK=${dep.network}`,
    `STELLAX_NETWORK_PASSPHRASE="${dep.network_passphrase}"`,
    `STELLAX_RPC_URL=${dep.rpc_url}`,
    `STELLAX_DEPLOYER=${dep.deployer}`,
    `STELLAX_USDC=${dep.usdc_token ?? ""}`,
    `STELLAX_GOVERNOR=${dep.contracts.governor ?? ""}`,
    `STELLAX_ORACLE=${dep.contracts.oracle ?? ""}`,
    `STELLAX_VAULT=${dep.contracts.vault ?? ""}`,
    `STELLAX_FUNDING=${dep.contracts.funding ?? ""}`,
    `STELLAX_RISK=${dep.contracts.risk ?? ""}`,
    `STELLAX_PERP_ENGINE=${dep.contracts.perp_engine ?? ""}`,
    `STELLAX_OPTIONS=${dep.contracts.options ?? ""}`,
    `STELLAX_STRUCTURED=${dep.contracts.structured ?? ""}`,
    `STELLAX_TREASURY=${dep.contracts.treasury ?? ""}`,
    `STELLAX_BRIDGE=${dep.contracts.bridge ?? ""}`,
    "",
  ].join("\n");
  writeFileSync(envPath, env);

  return { json: jsonPath, env: envPath };
}
