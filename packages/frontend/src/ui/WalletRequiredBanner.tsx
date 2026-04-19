import { useWallet } from "@/wallet";
import { Button } from "./Button";

/**
 * Renders a non-blocking info banner when the user has not connected a wallet.
 * Place at the top of any page that has wallet-gated actions.
 */
export function WalletRequiredBanner() {
  const { status, connect } = useWallet();

  if (status === "connected") return null;

  return (
    <div className="flex items-center justify-between rounded-md border border-stella-surface bg-stella-surface/40 px-4 py-3 text-sm">
      <span className="text-stella-muted">
        Connect your Freighter wallet to use this page.
      </span>
      <Button
        variant="primary"
        size="sm"
        disabled={status === "connecting"}
        onClick={() => void connect()}
      >
        {status === "connecting" ? "Connecting…" : "Connect Wallet"}
      </Button>
    </div>
  );
}
