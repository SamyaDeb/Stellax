import { BridgeLockForm } from "./bridge/BridgeLockForm";
import { BridgeStatus } from "./bridge/BridgeStatus";
import { ValidatorList } from "./bridge/ValidatorList";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";

export function BridgePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Bridge</h1>
        <p className="text-sm text-stella-muted">
          Cross-chain transfers via Axelar GMP. Lock on Stellar, mint on
          the destination EVM chain; inbound deposits are released here
          after validator attestations.
        </p>
      </header>

      <WalletRequiredBanner />

      <div className="grid gap-4 lg:grid-cols-2">
        <BridgeLockForm />
        <BridgeStatus />
      </div>

      <ValidatorList />
    </div>
  );
}
