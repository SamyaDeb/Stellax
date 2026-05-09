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
  RwaIssuerConfig,
} from "@stellax/sdk";
import type { GovernorProposal, AccountHealth } from "@stellax/sdk";
import type { PortfolioHealth } from "@stellax/sdk";
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
  vaultTokenBalance: (user: string, token: string) => ["vault-token-balance", user, token] as const,
  vaultTotal: () => ["vault-total"] as const,
  fundingRate: (marketId: number) => ["funding", marketId] as const,
  accountHealth: (user: string) => ["account-health", user] as const,
  portfolioHealth: (user: string) => ["portfolio-health", user] as const,
  fundingVelocity: (marketId: number) => ["funding-velocity", marketId] as const,
  // Legacy aliases kept so invalidate arrays in callers continue to compile.
  // They resolve to the same underlying query key as accountHealth.
  accountEquity: (user: string) => ["account-health", user] as const,
  freeCollateral: (user: string) => ["account-health", user] as const,
  maintenance: (user: string) => ["account-health", user] as const,
  impliedVol: (asset: string) => ["iv", asset] as const,
  userStrategies: (user: string) => ["user-strategies", user] as const,
  strategy: (id: string) => ["strategy", id] as const,
  currentEpoch: () => ["epoch-current"] as const,
  userShares: (user: string) => ["shares", user] as const,
  vaultNav: () => ["vault-nav"] as const,
  bridgeDeposit: (id: string) => ["bridge-deposit", id] as const,
  bridgeValidators: () => ["bridge-validators"] as const,
  marginMode: (user: string) => ["margin-mode", user] as const,
  insuranceFund: () => ["insurance-fund"] as const,
  insuranceTarget: () => ["insurance-target"] as const,
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
  // Staking
  stakingConfig: () => ["staking-config"] as const,
  stakingUser: (user: string) => ["staking-user", user] as const,
  stakingCurrentEpoch: () => ["staking-current-epoch"] as const,
  stakingTotalStaked: () => ["staking-total-staked"] as const,
  stakingEpochPool: (epoch: number) => ["staking-epoch", epoch] as const,
  // RWA issuers (Phase M)
  rwaConfig: (contractId: string) => ["rwa-config", contractId] as const,
  rwaBalance: (contractId: string, user: string) => ["rwa-balance", contractId, user] as const,
  rwaYield: (contractId: string, user: string) => ["rwa-yield", contractId, user] as const,
  // On-chain unrealized PnL per position (includes funding payments).
  unrealizedPnl: (positionId: bigint | string) => ["unrealized-pnl", positionId.toString()] as const,
  // Sub-account USDC balances (Phase S).
  subBalance: (user: string, subId: number) => ["sub-balance", user, subId] as const,
} as const;

// Poll intervals (ms)
const P = {
  price: 5_000,
  oi: 10_000,
  positions: 10_000,
  balance: 10_000,
  /** Fast interval used only for vault balances so deposits feel instant. */
  vaultBalance: 4_000,
  aggregate: 15_000,
} as const;

/* ────── Markets & prices ────── */

export function useMarkets(): UseQueryResult<Market[]> {
  return useQuery({
    queryKey: qk.markets(),
    queryFn: () => getClients().perpEngine.listMarkets(),
    staleTime: 30_000,
  });
}

export function usePrice(asset: string | null): UseQueryResult<PriceData> {
  return useQuery({
    queryKey: qk.price(asset ?? ""),
    queryFn: () => getClients().oracle.getPrice(asset as string),
    enabled: asset !== null && hasContract(config.contracts.oracle),
    refetchInterval: P.price,
    refetchOnMount: "always",
    retry: 1,
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

export function useAccountHealth(user: string | null): UseQueryResult<AccountHealth> {
  return useQuery({
    queryKey: qk.accountHealth(user ?? ""),
    queryFn: () => getClients().risk.getAccountHealth(user as string),
    enabled: user !== null && hasContract(config.contracts.risk),
    refetchInterval: P.balance,
    refetchOnMount: "always",
  });
}

export function useAccountEquity(user: string | null): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.accountHealth(user ?? ""),
    queryFn: () => getClients().risk.getAccountHealth(user as string),
    enabled: user !== null && hasContract(config.contracts.risk),
    refetchInterval: P.balance,
    refetchOnMount: "always",
    select: (h) => h.equity,
  });
}

export function useFreeCollateral(user: string | null): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.accountHealth(user ?? ""),
    queryFn: () => getClients().risk.getAccountHealth(user as string),
    enabled: user !== null && hasContract(config.contracts.risk),
    refetchInterval: P.balance,
    refetchOnMount: "always",
    select: (h) => h.freeCollateral,
  });
}

export function useMaintenanceMargin(
  user: string | null,
): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.accountHealth(user ?? ""),
    queryFn: () => getClients().risk.getAccountHealth(user as string),
    enabled: user !== null && hasContract(config.contracts.risk),
    refetchInterval: P.balance,
    refetchOnMount: "always",
    select: (h) => h.totalMarginRequired,
  });
}

/** Phase C — portfolio-margin health (cross-margin across perps + options). */
export function usePortfolioHealth(
  user: string | null,
): UseQueryResult<PortfolioHealth> {
  return useQuery({
    queryKey: qk.portfolioHealth(user ?? ""),
    queryFn: () => getClients().risk.getPortfolioHealth(user as string),
    enabled: user !== null && hasContract(config.contracts.risk),
    refetchInterval: P.balance,
    refetchOnMount: "always",
  });
}

/** Phase D — funding velocity (bps per hour). */
export function useFundingVelocity(
  marketId: number | null,
): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.fundingVelocity(marketId ?? -1),
    queryFn: () => getClients().funding.getFundingVelocity(marketId as number),
    enabled: marketId !== null && hasContract(config.contracts.funding),
    refetchInterval: P.aggregate,
  });
}

export function useVaultBalance(
  user: string | null,
): UseQueryResult<VaultBalance> {
  return useQuery({
    queryKey: qk.vaultBalance(user ?? ""),
    // Use the raw token balance (get_balance) instead of the oracle-priced
    // getTotalCollateralValue / getFreeCollateralValue composite. The oracle
    // methods return 0 when the oracle has no fresh USDC price, producing a
    // permanent $0.00 display even after a successful deposit. Raw balance
    // has no oracle dependency and always reflects what the user deposited.
    // "locked" is omitted here (requires oracle); use useFreeCollateral /
    // usePortfolioHealth for margin-locked breakdown.
    queryFn: async (): Promise<VaultBalance> => {
      const balance = await getClients().vault.getBalance(
        user as string,
        config.contracts.usdcSac,
      );
      return { free: balance, locked: 0n };
    },
    enabled: user !== null && hasContract(config.contracts.vault),
    refetchInterval: P.vaultBalance,
    refetchOnMount: "always",
  });
}

export function useVaultTokenBalance(
  user: string | null,
  token: string,
): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.vaultTokenBalance(user ?? "", token),
    queryFn: () => getClients().vault.getBalance(user as string, token),
    enabled: user !== null && hasContract(config.contracts.vault) && hasContract(token),
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

/* ────── RWA issuer tokens ────── */

export function useRwaIssuerConfig(
  contractId: string,
): UseQueryResult<RwaIssuerConfig> {
  return useQuery({
    queryKey: qk.rwaConfig(contractId),
    queryFn: () => getClients().rwaIssuer(contractId).getConfig(),
    enabled: hasContract(contractId),
    refetchInterval: P.aggregate,
    refetchOnMount: "always",
  });
}

export function useRwaBalance(
  contractId: string,
  user: string | null,
): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.rwaBalance(contractId, user ?? ""),
    queryFn: () => getClients().rwaIssuer(contractId).balance(user as string),
    enabled: user !== null && hasContract(contractId),
    refetchInterval: P.balance,
    refetchOnMount: "always",
  });
}

export function useRwaCumulativeYield(
  contractId: string,
  user: string | null,
): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.rwaYield(contractId, user ?? ""),
    queryFn: () => getClients().rwaIssuer(contractId).cumulativeYield(user as string),
    enabled: user !== null && hasContract(contractId),
    refetchInterval: P.balance,
    refetchOnMount: "always",
  });
}

export function useInsuranceFund(): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.insuranceFund(),
    queryFn: () => getClients().risk.getInsuranceFundBalance(),
    enabled: hasContract(config.contracts.risk),
    refetchInterval: P.aggregate,
  });
}

/**
 * Phase P — fetch the configured insurance auto-growth band (soft / hard
 * caps). Returns `null` if governance has not yet wired the band, in which
 * case the legacy fixed split is still in effect.
 */
export function useInsuranceTarget(): UseQueryResult<{
  softCap: bigint;
  hardCap: bigint;
} | null> {
  return useQuery({
    queryKey: qk.insuranceTarget(),
    queryFn: () => getClients().treasury.getInsuranceTarget(),
    enabled: hasContract(config.contracts.treasury),
    refetchInterval: P.aggregate * 4, // changes only via governance
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
    enabled: hasContract(config.contracts.bridge),
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
    staleTime: 300_000,
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

/* ────── Staking ────── */

import type {
  StakingConfig,
  StakeEntry,
  EpochRewardPool,
} from "@stellax/sdk";
export function useStakingConfig(): UseQueryResult<StakingConfig> {
  return useQuery({
    queryKey: qk.stakingConfig(),
    queryFn: () => getClients().staking.getConfig(),
    enabled: hasContract(config.contracts.staking),
    staleTime: 60_000,
  });
}

export function useStakingUser(user: string | null): UseQueryResult<StakeEntry> {
  return useQuery({
    queryKey: qk.stakingUser(user ?? ""),
    queryFn: () => getClients().staking.getStake(user!),
    enabled: hasContract(config.contracts.staking) && !!user,
    refetchInterval: P.aggregate,
    refetchOnMount: "always",
  });
}

export function useStakingCurrentEpoch(): UseQueryResult<number> {
  return useQuery({
    queryKey: qk.stakingCurrentEpoch(),
    queryFn: () => getClients().staking.currentEpoch(),
    enabled: hasContract(config.contracts.staking),
    refetchInterval: P.aggregate,
  });
}

export function useStakingTotal(): UseQueryResult<bigint> {
  return useQuery({
    queryKey: qk.stakingTotalStaked(),
    queryFn: () => getClients().staking.totalStaked(),
    enabled: hasContract(config.contracts.staking),
    refetchInterval: P.aggregate,
  });
}

export function useStakingEpochPool(
  epoch: number | null,
): UseQueryResult<EpochRewardPool> {
  return useQuery({
    queryKey: qk.stakingEpochPool(epoch ?? -1),
    queryFn: () => getClients().staking.getEpochReward(epoch!),
    enabled: hasContract(config.contracts.staking) && epoch !== null && epoch >= 0,
    staleTime: 30_000,
  });
}
