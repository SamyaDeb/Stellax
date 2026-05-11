import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { shortAddress } from "@/ui/format";
import { useBridgeValidators } from "@/hooks/queries";

/**
 * Known testnet validator set from the deployment config.
 * Shown as a fallback when the on-chain indexer is unavailable.
 * The deployer address acts as the sole validator on testnet.
 */
const KNOWN_TESTNET_VALIDATORS: { address: string; label: string }[] = [
  {
    address: "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG",
    label: "StellaX deployer",
  },
];

/**
 * Static list of the bridge's validator set. Read-only; admin updates
 * happen via governance.
 */
export function ValidatorList() {
  const q = useBridgeValidators();
  const onChainVals = q.data ?? [];

  // Use on-chain list when available; fall back to known testnet validators.
  const vals = onChainVals.length > 0 ? onChainVals : null;
  const fallback = onChainVals.length === 0 && !q.isLoading;

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Validator set</CardTitle>
        <span className="text-xs text-stella-muted">
          {vals !== null ? `${vals.length} active` : fallback ? "testnet" : "…"}
        </span>
      </CardHeader>
      <div className="p-4 space-y-3">
        {q.isLoading ? (
          <p className="text-sm text-stella-muted">Loading…</p>
        ) : vals !== null ? (
          <ul className="space-y-1.5">
            {vals.map((addr) => (
              <li
                key={addr}
                className="flex items-center justify-between rounded-xl bg-black/30 px-4 py-2.5 text-sm border border-white/5"
              >
                <span className="text-stella-muted">Validator</span>
                <span className="num text-white">{shortAddress(addr)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <p className="text-[11px] text-stella-muted">
              Full enumeration requires an off-chain indexer. Showing the
              deployment-config validator set for testnet.
            </p>
            <ul className="space-y-1.5">
              {KNOWN_TESTNET_VALIDATORS.map(({ address, label }) => (
                <li
                  key={address}
                  className="flex items-center justify-between rounded-xl bg-black/30 px-4 py-2.5 text-sm border border-white/5"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-stella-muted">{label}</span>
                    <span className="rounded bg-stella-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-stella-accent">
                      deployment config
                    </span>
                  </span>
                  <span className="num text-white">{shortAddress(address)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}
