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
    options: env(
      "VITE_OPTIONS_CONTRACT_ID",
      "CBM3RVMH7EEJQUWEVHSKSDJFFBGDLLA7QVJMFWM46H2BUP6XODTJ7ZGT",
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
  },
} as const;

export function hasContract(id: string): boolean {
  return id.length > 0;
}
