import { config as loadDotenv } from "dotenv";

loadDotenv();

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function optNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name} is not a number: ${v}`);
  }
  return n;
}

function optBigInt(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`Env var ${name} is not an integer: ${v}`);
  }
}

function optBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

function optList(name: string, fallback: string[] = []): string[] {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function optNumList(name: string, fallback: number[] = []): number[] {
  return optList(name).map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) {
      throw new Error(`Env var ${name} contains non-numeric: ${s}`);
    }
    return n;
  }).concat(optList(name).length === 0 ? fallback : []);
}

function parseKvMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k && v) out[k.toUpperCase()] = v;
  }
  return out;
}

function parseRwaContractMap(raw: string): Record<string, string> {
  return parseKvMap(raw);
}

function parseHolderMap(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (!k || !v) continue;
    out[k.toUpperCase()] = v
      .split(/[|;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return out;
}

function parseApyMap(raw: string): Record<string, number> {
  const kv = parseKvMap(raw);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(kv)) {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new Error(`apy map contains non-numeric: ${k}=${v}`);
    }
    out[k] = n;
  }
  return out;
}

export interface KeeperConfig {
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
  keeperSecretKey: string;
  indexerUrl: string;
  contracts: {
    oracle: string;
    funding: string;
    perpEngine: string;
    risk: string;
    structured: string;
    clob: string;
    slpVault: string;
    /** Main StellaX collateral vault — used by the SLP fee sweeper to query treasury balance. */
    vault: string;
  };
  /** Bridge keeper config — only populated when STELLAX_ADMIN_SECRET is set. */
  bridge: {
    adminSecret: string | null;
    contractId: string;
    intervalMs: number;
  };
  redstone: {
    gatewayUrl: string;
    feeds: string[];
    dataServiceId: string;
    uniqueSigners: number;
  };
  rwa: {
    /** Map of asset symbol -> deployed `stellax-rwa-issuer` contract id. */
    contracts: Record<string, string>;
    /** Feeds whose NAVs are pushed via the rwa-nav-pusher worker. */
    feeds: string[];
    /** Annualised yield in basis points per feed; overridden at runtime by the issuer feed. */
    apyBpsByFeed: Record<string, number>;
    /** Static demo holder addresses per feed for yield drips before an indexer holder source exists. */
    holdersByFeed: Record<string, string[]>;
    /** Effective start timestamp for static holder yield accrual. */
    holderSinceTs: number;
    /** Issuer NAV API endpoints. */
    ondoNavUrl: string;
    ousgNavUrl: string;
    benjiNavUrl: string;
    defiLlamaFallback: string;
    /** Staleness alert threshold for RWA NAV pushes — much higher than crypto. */
    stalenessAlertMs: number;
    /** CoinMarketCap pro API key (blank disables CMC source). */
    cmcApiKey: string;
    /** Skip on-chain push when price moved less than this. */
    minDeviationBps: number;
    /** Reject source quotes diverging more than this from the median. */
    maxDeviationBps: number;
    /** Drop source quotes older than this before median selection. */
    maxPriceAgeMs: number;
    /** Always push at least this often regardless of deviation. */
    forcePushMs: number;
    /** Consecutive tick failures before emitting a critical alert. */
    failureAlertThreshold: number;
  };
  intervals: {
    oraclePushMs: number;
    fundingUpdateMs: number;
    liquidationScanMs: number;
    vaultRollMs: number;
    clobMatchMs: number;
    rwaNavPushMs: number;
    yieldSimulatorMs: number;
    ttlExtenderMs: number;
    slpFeeSweeperMs: number;
    /** Phase 3: interval between continuous funding settlement ticks. */
    fundingSettlerMs: number;
  };
  workers: {
    oracle: boolean;
    funding: boolean;
    liquidation: boolean;
    vault: boolean;
    clob: boolean;
    rwaNav: boolean;
    yieldSimulator: boolean;
    ttlExtender: boolean;
    slpFeeSweeper: boolean;
    /** Phase 3: continuous funding settlement worker. */
    fundingSettler: boolean;
    /** Bridge keeper: credits inbound Axelar EVM→Stellar deposits. */
    bridgeKeeper: boolean;
  };
  perpMarketIds: number[];
  structuredVaultIds: string[];
  slp: {
    /** Native 7-decimal USDC amount cap to sweep from treasury per tick. 0 = disabled. */
    feeSweepAmountNative: bigint;
    /** Treasury address within the collateral vault — source of fee sweeps. */
    treasuryAddress: string;
    /** SEP-41 USDC token contract ID — used to query the treasury vault balance. */
    usdcTokenId: string;
  };
  monitoring: {
    healthPort: number;
    logLevel: string;
    discordWebhook: string | null;
    telegramBotToken: string | null;
    telegramChatId: string | null;
  };
  thresholds: {
    minKeeperBalanceStroops: bigint;
    oracleStalenessAlertMs: number;
  };
  ttl: {
    /**
     * How many ledgers to extend each contract instance + wasm code TTL by
     * on every successful tick. Testnet caps `extendTo` at maxEntryTTL-1
     * (~535,679 ≈ 30 days).
     */
    ledgersToExtend: number;
    /**
     * Optional explicit map of contract-name → wasm hash (hex). When unset
     * the keeper expects to read these from `deployments/<network>.json`
     * via the `TTL_DEPLOYMENTS_FILE` env var. Format: `name=hash,…`.
     */
    wasmHashes: Record<string, string>;
    /**
     * Path to the deployments JSON used to discover wasm hashes when
     * `wasmHashes` is empty. Falls back to "" (no auto-discovery).
     */
    deploymentsFile: string;
  };
}

export function loadConfig(): KeeperConfig {
  return {
    horizonUrl: opt("HORIZON_URL", "https://horizon-testnet.stellar.org"),
    rpcUrl: opt("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org"),
    networkPassphrase: opt(
      "STELLAR_NETWORK_PASSPHRASE",
      "Test SDF Network ; September 2015",
    ),
    keeperSecretKey: req("KEEPER_SECRET_KEY"),
    indexerUrl: opt("INDEXER_URL", "http://localhost:4001"),
    contracts: {
      oracle: req("ORACLE_CONTRACT_ID"),
      funding: req("FUNDING_CONTRACT_ID"),
      perpEngine: req("PERP_ENGINE_CONTRACT_ID"),
      risk: req("RISK_CONTRACT_ID"),
      structured: opt("STRUCTURED_CONTRACT_ID", ""),
      clob: opt("CLOB_CONTRACT_ID", ""),
      slpVault: opt("SLP_VAULT_CONTRACT_ID", ""),
      vault: opt("VAULT_CONTRACT_ID", ""),
    },
    bridge: {
      adminSecret: process.env.STELLAX_ADMIN_SECRET || null,
      contractId: opt("STELLAX_BRIDGE", ""),
      intervalMs: optNum("BRIDGE_KEEPER_INTERVAL_MS", 15_000),
    },
    redstone: {
      gatewayUrl: opt(
        "REDSTONE_GATEWAY_URL",
        "https://oracle-gateway-1.a.redstone.finance",
      ),
      feeds: optList("REDSTONE_FEEDS", ["BTC", "ETH", "XLM"]),
      dataServiceId: opt("REDSTONE_DATA_SERVICE_ID", "redstone-primary-prod"),
      uniqueSigners: optNum("REDSTONE_UNIQUE_SIGNERS", 3),
    },
    rwa: {
      contracts: parseRwaContractMap(opt("RWA_CONTRACTS", "")),
      feeds: optList("RWA_FEEDS", ["BENJI", "USDY", "OUSG"]),
      apyBpsByFeed: parseApyMap(opt("RWA_APY_BPS", "BENJI=500,USDY=505,OUSG=450")),
      holdersByFeed: parseHolderMap(opt("RWA_HOLDERS", "")),
      holderSinceTs: optNum("RWA_HOLDER_SINCE_TS", Math.floor(Date.now() / 1_000) - 24 * 3_600),
      ondoNavUrl: opt(
        "RWA_ONDO_NAV_URL",
        "https://api.ondo.finance/v1/nav/usdy",
      ),
      ousgNavUrl: opt(
        "RWA_OUSG_NAV_URL",
        "https://api.ondo.finance/v1/nav/ousg",
      ),
      benjiNavUrl: opt(
        "RWA_BENJI_NAV_URL",
        "https://nav.franklintempleton.com/v1/funds/benji/nav",
      ),
      defiLlamaFallback: opt(
        "RWA_DEFILLAMA_URL",
        "https://api.llama.fi/protocol/franklin-templeton-benji",
      ),
      stalenessAlertMs: optNum("RWA_NAV_STALENESS_ALERT_MS", 7_200_000),
      cmcApiKey: opt("CMC_API_KEY", ""),
      minDeviationBps: optNum("RWA_PRICE_MIN_DEVIATION_BPS", 10),
      maxDeviationBps: optNum("RWA_PRICE_MAX_DEVIATION_BPS", 100),
      maxPriceAgeMs: optNum("RWA_PRICE_MAX_AGE_MS", 300_000),
      forcePushMs: optNum("RWA_PRICE_FORCE_PUSH_MS", 60_000),
      failureAlertThreshold: optNum("RWA_PRICE_FAILURE_ALERT_THRESHOLD", 8),
    },
    intervals: {
      oraclePushMs: optNum("ORACLE_PUSH_INTERVAL_MS", 10_000),
      fundingUpdateMs: optNum("FUNDING_UPDATE_INTERVAL_MS", 3_600_000),
      liquidationScanMs: optNum("LIQUIDATION_SCAN_INTERVAL_MS", 5_000),
      vaultRollMs: optNum("VAULT_ROLL_INTERVAL_MS", 60_000),
      clobMatchMs: optNum("CLOB_MATCH_INTERVAL_MS", 2_000),
      rwaNavPushMs: optNum("RWA_NAV_PUSH_INTERVAL_MS", 15_000), // every 15s — RWA price loop
      yieldSimulatorMs: optNum("YIELD_SIMULATOR_INTERVAL_MS", 3_600_000), // every hour
      // Default: every 6 hours. With ledgersToExtend=535,680 (~30 days) this
      // gives ~29.75 days of slack between successful extensions.
      ttlExtenderMs: optNum("TTL_EXTENDER_INTERVAL_MS", 21_600_000),
      // Default: every 24 hours — matches the production cooldown period.
      slpFeeSweeperMs: optNum("SLP_FEE_SWEEP_INTERVAL_MS", 86_400_000),
      // Default: every 1 hour — continuous funding settlement for open positions.
      fundingSettlerMs: optNum("FUNDING_SETTLER_INTERVAL_MS", 3_600_000),
    },
    workers: {
      oracle: optBool("WORKER_ORACLE_ENABLED", true),
      funding: optBool("WORKER_FUNDING_ENABLED", true),
      liquidation: optBool("WORKER_LIQUIDATION_ENABLED", true),
      vault: optBool("WORKER_VAULT_ENABLED", true),
      clob: optBool("WORKER_CLOB_ENABLED", true),
      rwaNav: optBool("WORKER_RWA_NAV_ENABLED", true),
      yieldSimulator: optBool("WORKER_YIELD_SIMULATOR_ENABLED", true),
      ttlExtender: optBool("WORKER_TTL_EXTENDER_ENABLED", true),
      slpFeeSweeper: optBool("WORKER_SLP_FEE_SWEEPER_ENABLED", true),
      fundingSettler: optBool("WORKER_FUNDING_SETTLER_ENABLED", true),
      bridgeKeeper: optBool("WORKER_BRIDGE_KEEPER_ENABLED", false),
    },
    perpMarketIds: optNumList("PERP_MARKET_IDS", [1, 2, 3, 100, 101, 102]),
    structuredVaultIds: optList("STRUCTURED_VAULT_IDS"),
    slp: {
      feeSweepAmountNative: optBigInt("SLP_FEE_SWEEP_AMOUNT", 0n),
      treasuryAddress: opt("SLP_TREASURY_ADDRESS", ""),
      usdcTokenId: opt("USDC_TOKEN_ID", ""),
    },
    monitoring: {
      healthPort: optNum("HEALTH_PORT", 9090),
      logLevel: opt("LOG_LEVEL", "info"),
      discordWebhook: process.env.ALERT_DISCORD_WEBHOOK || null,
      telegramBotToken: process.env.ALERT_TELEGRAM_BOT_TOKEN || null,
      telegramChatId: process.env.ALERT_TELEGRAM_CHAT_ID || null,
    },
    thresholds: {
      minKeeperBalanceStroops: optBigInt(
        "MIN_KEEPER_BALANCE_STROOPS",
        1_000_000_000n,
      ),
      oracleStalenessAlertMs: optNum("ORACLE_STALENESS_ALERT_MS", 60_000),
    },
    ttl: {
      ledgersToExtend: optNum("TTL_LEDGERS_TO_EXTEND", 535_680),
      wasmHashes: parseKvMap(opt("TTL_WASM_HASHES", "")),
      deploymentsFile: opt("TTL_DEPLOYMENTS_FILE", ""),
    },
  };
}
