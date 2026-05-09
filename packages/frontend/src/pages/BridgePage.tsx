import { BridgeLockForm } from "./bridge/BridgeLockForm";
import { BridgeStatus } from "./bridge/BridgeStatus";
import { ValidatorList } from "./bridge/ValidatorList";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";

export function BridgePage() {
  return (
    <div className="mx-auto max-w-[1350px] space-y-8 px-4 py-8">
      <header className="mb-8 text-center text-balance flex flex-col items-center">
        <h1 className="text-3xl font-semibold text-white tracking-tight mb-2">Bridge</h1>
        <p className="text-base text-stella-muted max-w-2xl">
          Cross-chain transfers via Axelar GMP. Lock on Stellar, mint on
          the destination EVM chain; inbound deposits are released here
          after validator attestations.
        </p>
      </header>

      <WalletRequiredBanner />

      <div className="grid gap-6 lg:grid-cols-2">
        <BridgeLockForm />
        <BridgeStatus />
      </div>

      <ValidatorList />
    </div>
  );
}
