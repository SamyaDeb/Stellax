/**
 * TanStack Query hooks for StellaX read paths.
 *
 * All queries share the singleton executor from `stellar/clients`.
 * Poll intervals follow the plan: prices 5s, positions 10s, aggregates 15s.
 *
 * Query keys are exported as constants so `useTx` can invalidate them.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  Market,
  OpenInterest,
  Position,
  PriceData,
  VaultBalance,
  VaultEpoch,
  OptionContract,
} from "@stellax/sdk";
import type { GovernorProposal } from "@stellax/sdk";
import { getClients } from "@/stellar/clients";
import { config, hasContract } from "@/config";

export const qk = {
  markets: () => ["markets"] as const,
  price: (asset: string) => ["price", asset] as const,
  position: (id: string) => ["position", id] as const,
  userPositions: (user: string) => ["positions", user] as const,
  openInterest: (marketId: number) => ["oi", marketId] as const,
  markPrice: (marketId: number) => ["mark", marketId] as const,
  vaultBalance: (user: string) => ["vault-balance", user] as const,
  vaultTotal: () => ["vault-total"] as const,
  fundingRate: (marketId: number) => ["funding", marketId] as const,
  accountEquity: (user: string) => ["equity", user] as const,
  freeCollateral: (user: string) => ["free-coll", user] as const,
  maintenance: (user: string) => ["maint", user] as const,
  optionsList: (user: string, role: "writer" | "holder") =>
    ["options", role, user] as const,
  option: (id: string) => ["option", id] as const,
  optionsMarkets: () => ["options-markets"] as const,
  impliedVol: (asset: string) => ["iv", asset] as const,
  currentEpoch: () => ["epoch-current"] as const,
  userShares: (user: string) => ["shares", user] as const,
  vaultNav: () => ["vault-nav"] as const,
  bridgeDeposit: (id: string) => ["bridge-deposit", id] as const,
  bridgeValidators: () => ["bridge-validators"] as const,
  marginMode: (user: string) => ["margin-mode", user] as const,
  insuranceFund: () => ["insurance-fund"] as const,
  // Governor
  governorIsPaused: () => ["gov-paused"] as const,
  governorVersion: () => ["gov-version"] as const,
  proposal: (id: string) => ["proposal", id] as const,
  proposalApprovals: (id: string) => ["proposal-approvals", id] as const,
  // Treasury
  treasuryPendingFees: (token: string) => ["treasury-pending", token] as const,
  treasuryBalance: (token: string) => ["treasury-balance", token] as const,
  treasuryStaker: (token: string) => ["treasury-staker", token] as const,
  treasuryInsuranceSent: (token: string) => ["treasury-insurance", token] as const,
} as const;

// Poll intervals (ms)
const P = {
  price: 5_000,
  oi: 10_000,
  positions: 10_000,
  balance: 10_000,
  aggregate: 15_000,
} as const;

/* ────── Markets & prices ────── */

export function useMarkets(): UseQueryResult<Market[]> {
  return useQuery({
    queryKey: qk.markets(),
    queryFn: () => getClients().perpEngine.listMarkets(),
    staleTime: Infinity,
  });
}

export function usePrice(asset: string | null): UseQueryResult<PriceData> {
  return useQuery({
    queryKey: qk.price(asset ?? ""),
    queryFn: () => getClients().oracle.getPrice(asset as string),
    enabled: asset !== null && hasContract(config.contracts.oracle),
    refetchInterval: P.price,
    refetchOnMount: "always",
  });
}

export function useMarkPrice(marketId: number | null): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.markPrice(marketId ?? -1),
    queryFn: () => getClients().perpEngine.getMarkPrice(marketId as number),
    enabled: marketId !== null && hasContract(config.contracts.perpEngine),
    refetchInterval: P.price,
    refetchOnMount: "always",
  });
}

export function useOpenInterest(
  marketId: number | null,
): UseQueryResult<OpenInterest> {
  return useQuery({
    queryKey: qk.openInterest(marketId ?? -1),
    queryFn: () => getClients().perpEngine.getOpenInterest(marketId as number),
    enabled: marketId !== null,
    refetchInterval: P.oi,
  });
}

export function useFundingRate(
  marketId: number | null,
): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.fundingRate(marketId ?? -1),
    queryFn: () =>
      getClients().funding.getCurrentFundingRate(marketId as number),
    enabled: marketId !== null && hasContract(config.contracts.funding),
    refetchInterval: P.aggregate,
    refetchOnMount: "always",
  });
}

/* ────── User: positions & account ────── */

export function useUserPositions(user: string | null): UseQueryResult<Position[]> {
  return useQuery({
    queryKey: qk.userPositions(user ?? ""),
    queryFn: () => getClients().perpEngine.getUserPositions(user as string),
    enabled: user !== null,
    refetchInterval: P.positions,
    refetchOnMount: "always",
  });
}

export function useAccountEquity(user: string | null): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.accountEquity(user ?? ""),
    queryFn: () => getClients().risk.getAccountEquity(user as string),
    enabled: user !== null && hasContract(config.contracts.risk),
    refetchInterval: P.balance,
    refetchOnMount: "always",
  });
}

export function useFreeCollateral(user: string | null): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.freeCollateral(user ?? ""),
    queryFn: () => getClients().risk.getFreeCollateral(user as string),
    enabled: user !== null && hasContract(config.contracts.risk),
    refetchInterval: P.balance,
    refetchOnMount: "always",
  });
}

export function useMaintenanceMargin(
  user: string | null,
): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.maintenance(user ?? ""),
    queryFn: () => getClients().risk.getMaintenanceMargin(user as string),
    enabled: user !== null && hasContract(config.contracts.risk),
    refetchInterval: P.balance,
  });
}

export function useVaultBalance(
  user: string | null,
): UseQueryResult<VaultBalance> {
  return useQuery({
    queryKey: qk.vaultBalance(user ?? ""),
    queryFn: () =>
      getClients().vault.getVaultBalance(
        user as string,
        config.contracts.usdcSac,
      ),
    enabled: user !== null && hasContract(config.contracts.vault),
    refetchInterval: P.balance,
    refetchOnMount: "always",
  });
}

export function useVaultTotal(): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.vaultTotal(),
    queryFn: () => getClients().vault.getTotalDeposits(),
    enabled: hasContract(config.contracts.vault),
    refetchInterval: P.aggregate,
  });
}

export function useInsuranceFund(): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.insuranceFund(),
    queryFn: () => getClients().risk.getInsuranceFundBalance(),
    refetchInterval: P.aggregate,
  });
}

/* ────── Options ────── */

export function useOptionsMarkets(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: qk.optionsMarkets(),
    queryFn: () => getClients().options.listMarkets(),
    staleTime: Infinity,
  });
}

export function useImpliedVol(asset: string | null): UseQueryResult<number> {
  return useQuery({
    queryKey: qk.impliedVol(asset ?? ""),
    queryFn: () => getClients().options.getImpliedVol(asset as string),
    enabled: asset !== null && hasContract(config.contracts.options),
    refetchInterval: P.aggregate,
  });
}

export function useUserOptions(
  user: string | null,
  role: "writer" | "holder",
): UseQueryResult<bigint[]> {
  return useQuery({
    queryKey: qk.optionsList(user ?? "", role),
    queryFn: () =>
      role === "writer"
        ? getClients().options.getUserOptionsAsWriter(user as string)
        : getClients().options.getUserOptionsAsHolder(user as string),
    enabled: user !== null,
    refetchInterval: P.aggregate,
    refetchOnMount: "always",
  });
}

export function useOption(optionId: bigint | null): UseQueryResult<OptionContract> {
  return useQuery({
    queryKey: qk.option(optionId?.toString() ?? ""),
    queryFn: () => getClients().options.getOption(optionId as bigint),
    enabled: optionId !== null && hasContract(config.contracts.options),
    refetchInterval: P.aggregate,
  });
}

/* ────── Structured vaults ────── */

export function useCurrentEpoch(): UseQueryResult<VaultEpoch> {
  return useQuery({
    queryKey: qk.currentEpoch(),
    queryFn: () => getClients().structured.getCurrentEpoch(),
    enabled: hasContract(config.contracts.structured),
    refetchInterval: P.aggregate,
    refetchOnMount: "always",
  });
}

export function useUserShares(user: string | null): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.userShares(user ?? ""),
    queryFn: () => getClients().structured.getUserShares(user as string),
    enabled: user !== null && hasContract(config.contracts.structured),
    refetchInterval: P.balance,
    refetchOnMount: "always",
  });
}

export function useVaultNav(): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.vaultNav(),
    queryFn: () => getClients().structured.getNav(),
    enabled: hasContract(config.contracts.structured),
    refetchInterval: P.aggregate,
  });
}

/* ────── Bridge ────── */

export function useBridgeValidators(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: qk.bridgeValidators(),
    queryFn: () => getClients().bridge.listValidators(),
    staleTime: 300_000,
  });
}

export function useBridgeDeposit(id: bigint | null) {
  return useQuery({
    queryKey: qk.bridgeDeposit(id?.toString() ?? ""),
    queryFn: () => getClients().bridge.getDeposit(id as bigint),
    enabled: id !== null && hasContract(config.contracts.bridge),
    refetchInterval: P.aggregate,
  });
}

/* ────── Governor ────── */

export function useGovernorIsPaused(): UseQueryResult<boolean> {
  return useQuery({
    queryKey: qk.governorIsPaused(),
    queryFn: () => getClients().governor.isPaused(),
    enabled: hasContract(config.contracts.governor),
    refetchInterval: P.aggregate,
    refetchOnMount: "always",
  });
}

export function useGovernorVersion(): UseQueryResult<number> {
  return useQuery({
    queryKey: qk.governorVersion(),
    queryFn: () => getClients().governor.version(),
    enabled: hasContract(config.contracts.governor),
    staleTime: Infinity,
  });
}

export function useProposal(id: bigint | null): UseQueryResult<GovernorProposal> {
  return useQuery({
    queryKey: qk.proposal(id?.toString() ?? ""),
    queryFn: () => getClients().governor.getProposal(id as bigint),
    enabled: id !== null && hasContract(config.contracts.governor),
    refetchInterval: P.aggregate,
  });
}

export function useProposalApprovals(id: bigint | null): UseQueryResult<number> {
  return useQuery({
    queryKey: qk.proposalApprovals(id?.toString() ?? ""),
    queryFn: () => getClients().governor.getApprovalCount(id as bigint),
    enabled: id !== null && hasContract(config.contracts.governor),
    refetchInterval: P.aggregate,
    refetchOnMount: "always",
  });
}

/* ────── Treasury ────── */

export function useTreasuryPendingFees(token: string): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.treasuryPendingFees(token),
    queryFn: () => getClients().treasury.getPendingFees(token),
    enabled: hasContract(config.contracts.treasury) && token.length > 0,
    refetchInterval: P.aggregate,
    refetchOnMount: "always",
  });
}

export function useTreasuryBalance(token: string): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.treasuryBalance(token),
    queryFn: () => getClients().treasury.getTreasuryBalance(token),
    enabled: hasContract(config.contracts.treasury) && token.length > 0,
    refetchInterval: P.aggregate,
    refetchOnMount: "always",
  });
}

export function useTreasuryStaker(token: string): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.treasuryStaker(token),
    queryFn: () => getClients().treasury.getStakerBalance(token),
    enabled: hasContract(config.contracts.treasury) && token.length > 0,
    refetchInterval: P.aggregate,
  });
}

export function useTreasuryInsuranceSent(token: string): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.treasuryInsuranceSent(token),
    queryFn: () => getClients().treasury.getInsuranceSent(token),
    enabled: hasContract(config.contracts.treasury) && token.length > 0,
    refetchInterval: P.aggregate,
  });
}
