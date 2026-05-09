import { ProtocolStatus } from "./governance/ProtocolStatus";
import { NewProposalForm } from "./governance/NewProposalForm";
import { ProposalLookup } from "./governance/ProposalLookup";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";

/**
 * Governance page — create proposals, approve, execute, and monitor
 * protocol pause status. Covers the full governor e2e test flow:
 *   propose() → approve() → execute() → isPaused()
 */
export function GovernancePage() {
  return (
    <div className="mx-auto max-w-[1350px] space-y-8 px-4 py-8">
      <header className="mb-8 text-center text-balance flex flex-col items-center">
        <h1 className="text-3xl font-semibold text-white tracking-tight mb-2">Governance</h1>
        <p className="text-base text-stella-muted max-w-2xl">
          Multisig governance with timelock. Propose actions, collect approvals,
          then execute. Guardian can emergency-pause without a proposal.
        </p>
      </header>

      <WalletRequiredBanner />

      <div className="grid gap-6 lg:grid-cols-[400px_1fr]">
        <div className="space-y-4">
          <ProtocolStatus />
          <NewProposalForm />
        </div>
        <ProposalLookup />
      </div>
    </div>
  );
}
