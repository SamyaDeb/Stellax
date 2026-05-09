/**
 * Typed access to Vite env variables.
 * All contract IDs are pre-populated from .env (testnet defaults).
 * Uses hardcoded fallbacks so module-level init never throws.
 */

function env(key: string, fallback = ""): string {
  try {
    // import.meta.env may be undefined outside Vite's browser context
    const metaEnv = (import.meta as unknown as Record<string, unknown>).env as
      | Record<string, string>
      | undefined;
    if (!metaEnv) return fallback;
    const v = metaEnv[key];
    if (v !== undefined && v !== "") return v;
  } catch {
    // swallow — return fallback
  }
  return fallback;
}

export const config = {
  network: {
    passphrase: env(
      "VITE_NETWORK_PASSPHRASE",
      "Test SDF Network ; September 2015",
    ),
    rpcUrl: env(
      "VITE_SOROBAN_RPC_URL",
      "https://soroban-testnet.stellar.org",
    ),
    horizonUrl: env(
      "VITE_HORIZON_URL",
      "https://horizon-testnet.stellar.org",
    ),
  },
  contracts: {
    oracle: env(
      "VITE_ORACLE_CONTRACT_ID",
      "CCESFJNJ3HS6DH2ZOSGSPMHH2GHE4MWJCWQR5A3RGLZYVZ37E5WBZEXB",
    ),
    vault: env(
      "VITE_VAULT_CONTRACT_ID",
      "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM",
    ),
    perpEngine: env(
      "VITE_PERP_ENGINE_CONTRACT_ID",
      "CD3PV6GINVKT7VVM4HDBKUTWP2HJYJCCRWA2VJKWCP3B4SJQHE63MF7H",
    ),
    funding: env(
      "VITE_FUNDING_CONTRACT_ID",
      "CBTHQWJUT3VITY7XXDJVR7IA4DPUECXIBW6V4DCCBSIQWDTY3VWT4JRI",
    ),
    risk: env(
      "VITE_RISK_CONTRACT_ID",
      "CBRF3VSZK2GOLKK4BHAH6GULEETDPAOZFLNTNQTHTCJEXVZF2V2FJWOX",
    ),
    structured: env(
      "VITE_STRUCTURED_CONTRACT_ID",
      "CCM5AQAZFBNG4R4SZDCZSQ6SZKX53QWNQ3EGKBXS7JNS5GP6LIKUYTPX",
    ),
    bridge: env(
      "VITE_BRIDGE_CONTRACT_ID",
      "CDTZX3CTVVHN67ONILVY7PHSQDGZHMKCP3EM4NHATYUYA5J5NYSDZMVL",
    ),
    governor: env(
      "VITE_GOVERNOR_CONTRACT_ID",
      "CB3VSLPIXYXEOZ34CGOOAHS5L5CW4YITAGBFODMMCZOA73KBM7OFL4PD",
    ),
    treasury: env(
      "VITE_TREASURY_CONTRACT_ID",
      "CCPGPJKOUTI5ES2DPFH5PPM2AP5RQPAESREHYEEPWJ46FY7JM6K7JUTF",
    ),
    usdcSac: env(
      "VITE_USDC_SAC_ADDRESS",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    ),
    /**
     * USDC issuer account — used by DepositPage to identify USDC on the
     * path-payment route. Differs from the SAC address.
     */
    usdcIssuer: env(
      "VITE_USDC_ISSUER",
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    ),
    /** Phase B — hybrid CLOB. */
    clob: env(
      "VITE_CLOB_CONTRACT_ID",
      "CDKOESSQL5KFH6LFJ5XKLNIDYBN7NX4OYV4V7VQ5RNAGVILHCIH7KSJV",
    ),
    /** Phase F — STLX staking. */
    staking: env(
      "VITE_STAKING_CONTRACT_ID",
      "CC63QLGI3VV5BGA5F7GQN2TNUV4AYNHMPR334TNJV6SMATAPD723LUIT",
    ),
    /** Phase F — STLX token SAC. */
    stlxSac: env(
      "VITE_STLX_SAC_ADDRESS",
      "CBH3LOMBQ3K3NF2MAPRLGQYB5H3MHGZV74BXBGDSIT2VWWJHZHZ5ZQX6",
    ),
    /** Phase M — mock RWA issuer contracts deployed on testnet. */
    rwaBenji: env(
      "VITE_RWA_BENJI_CONTRACT_ID",
      "CBYVEVYQSO5VNNH42GD2WKPSFX6RKND6VCPYTJNNKI5FTVC6KIJHMKPB",
    ),
    rwaUsdy: env(
      "VITE_RWA_USDY_CONTRACT_ID",
      "CBW6X6P4SIESU5XFSCMCZAXAYKEA3TYI4JCQHHBB7EI4X6HYT3XWGQH5",
    ),
    rwaOusg: env(
      "VITE_RWA_OUSG_CONTRACT_ID",
      "CBO7WFREUENMIFEO4RNYJEFA3W7JZ2BAU4JM2T7Q2ZWX76QU7H3GHQNM",
    ),
    /**
     * Phase U — admin address used to gate treasury/lending controls in the UI.
     * Defaults to the testnet deployer.
     */
    adminAddress: env(
      "VITE_ADMIN_ADDRESS",
      "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG",
    ),
  },
  indexer: {
    /** REST + WebSocket base URL of the StellaX event indexer. */
    url: env("VITE_INDEXER_URL", "http://localhost:4001"),
    /** Set to "false" to disable indexer usage and fall back to session store. */
    enabled: env("VITE_INDEXER_ENABLED", "true") !== "false",
  },
} as const;

export function hasContract(id: string): boolean {
  return id.length > 0;
}

/**
 * True when the app is pointed at the Stellar public testnet.
 * Used to gate demo-only UI panels (e.g. SpotSwapPanel) that require
 * a vault-authorized keeper wallet — unsafe to show on mainnet.
 */
export function isTestnet(): boolean {
  return config.network.passphrase.includes("Test SDF Network");
}
