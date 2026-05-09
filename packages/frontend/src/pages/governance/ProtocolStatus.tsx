import clsx from "clsx";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { qk, useGovernorIsPaused, useGovernorVersion } from "@/hooks/queries";

/**
 * Protocol status card — shows isPaused flag and version, plus
 * emergency pause and unpause buttons (guardian only on mainnet;
 * deployer = guardian on testnet).
 */
export function ProtocolStatus() {
  const { run, pending, connected } = useTx();
  const pausedQ = useGovernorIsPaused();
  const versionQ = useGovernorVersion();

  const isPaused = pausedQ.data ?? false;

  async function emergencyPause() {
    await run(
      "Emergency pause",
      (source) =>
        getClients().governor.emergencyPause(source, { sourceAccount: source }),
      { invalidate: [qk.governorIsPaused()] },
    );
  }

  async function unPause() {
    // Unpause via a proposal with action=UnpauseProtocol + approve + execute.
    // Note: propose() does NOT change isPaused — only execute() of an
    // UnpauseProtocol proposal would. No cache invalidation needed here.
    await run(
      "Propose UnpauseProtocol",
      (source) =>
        getClients().governor.propose(
          source,
          "UnpauseProtocol",
          source,
          new Uint8Array(0),
          { sourceAccount: source },
        ),
      {},
    );
  }

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Protocol status</CardTitle>
        <span
          className={clsx(
            "rounded px-2 py-0.5 text-xs font-medium",
            isPaused
              ? "bg-stella-short/20 text-stella-short"
              : "bg-stella-long/20 text-stella-long",
          )}
        >
          {pausedQ.isLoading ? "…" : isPaused ? "PAUSED" : "LIVE"}
        </span>
      </CardHeader>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-black/30 px-4 py-4 text-xs border border-white/5">
          <Stat label="Status" value={isPaused ? "Paused" : "Operating"} tone={isPaused ? "bad" : "ok"} />
          <Stat label="Version" value={versionQ.data !== undefined ? `v${versionQ.data}` : "—"} />
        </div>

        <p className="text-xs text-stella-muted">
          Emergency pause halts all trading immediately without a proposal.
          Only the guardian (deployer on testnet) can call this. Unpause
          requires a governance proposal.
        </p>

        <div className="flex gap-2">
          <Button
            variant="short"
            size="sm"
            className="flex-1"
            disabled={!connected || pending || isPaused}
            onClick={() => void emergencyPause()}
          >
            Emergency pause
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1"
            disabled={!connected || pending || !isPaused}
            onClick={() => void unPause()}
          >
            Propose unpause
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return (
    <div>
      <div className="text-stella-muted">{label}</div>
      <div
        className={clsx(
          "num mt-0.5 font-medium",
          tone === "ok" && "text-stella-long",
          tone === "bad" && "text-stella-short",
          !tone && "text-white",
        )}
      >
        {value}
      </div>
    </div>
  );
}
