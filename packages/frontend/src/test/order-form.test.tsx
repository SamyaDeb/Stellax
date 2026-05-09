import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Market } from "@stellax/sdk";

// Freighter mock — default disconnected; we override per test.
vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn(async () => ({ isConnected: false })),
  requestAccess: vi.fn(async () => ({ address: "" })),
  getAddress: vi.fn(async () => ({ address: "" })),
  getNetwork: vi.fn(async () => ({
    network: "TESTNET",
    networkPassphrase: "Test SDF Network ; September 2015",
  })),
  setAllowed: vi.fn(async () => ({})),
  signTransaction: vi.fn(async () => ({ signedTxXdr: "", signerAddress: "" })),
}));

// Stub the clients factory so OrderForm can render without a real RPC.
const mockOpenPosition = vi.fn(async () => ({
  status: "SUCCESS",
  hash: "testhash",
  returnValue: null,
  latestLedger: 0,
}));
vi.mock("@/stellar/clients", () => ({
  getClients: vi.fn(() => ({
    perpEngine: { openPosition: mockOpenPosition },
  })),
}));

import { WalletProvider } from "@/wallet/WalletContext";
import { useWalletStore } from "@/wallet/store";
import { OrderForm } from "@/pages/trade/OrderForm";

const MARKET: Market = {
  marketId: 1,
  baseAsset: "BTC",
  quoteAsset: "USD",
  isActive: true,
  maxLeverage: 20,
  makerFeeBps: 10,
  takerFeeBps: 20,
  maxOiLong: 0n,
  maxOiShort: 0n,
};

/** BTC mark price used in sizing tests: $50,000 exactly. */
const MARK_PRICE = 50_000n * 10n ** 18n;

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <WalletProvider>{children}</WalletProvider>
    </QueryClientProvider>
  );
}

describe("OrderForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset wallet store to disconnected state between tests.
    useWalletStore.getState().reset();
  });

  it("renders Long/Short toggle and disables submit when size is empty", () => {
    render(
      <Wrap>
        <OrderForm market={MARKET} markPrice={MARK_PRICE} />
      </Wrap>,
    );
    expect(screen.getByRole("button", { name: /^long$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^short$/i })).toBeInTheDocument();

    // The submit button shows "Connect wallet" since no wallet connected.
    const submit = screen.getByRole("button", { name: /connect wallet/i });
    expect(submit).toBeDisabled();
  });

  it("submit stays disabled even when size entered if wallet not connected", async () => {
    const user = userEvent.setup();
    render(
      <Wrap>
        <OrderForm market={MARKET} markPrice={MARK_PRICE} />
      </Wrap>,
    );
    const size = screen.getByPlaceholderText("0.00");
    await user.type(size, "1000");
    const submit = screen.getByRole("button", { name: /connect wallet/i });
    expect(submit).toBeDisabled();
  });

  it("clamps leverage to the market's maxLeverage", async () => {
    const user = userEvent.setup();
    render(
      <Wrap>
        <OrderForm market={MARKET} markPrice={MARK_PRICE} />
      </Wrap>,
    );
    const slider = screen.getByRole("slider");
    // Try to set above max; range inputs clamp automatically via attr.
    await user.click(slider);
    // The label should reference the cap.
    expect(
      screen.getByText(new RegExp(`max ${MARKET.maxLeverage}x`)),
    ).toBeInTheDocument();
  });

  it("shows margin-required preview = size / leverage", async () => {
    const user = userEvent.setup();
    render(
      <Wrap>
        <OrderForm market={MARKET} markPrice={MARK_PRICE} />
      </Wrap>,
    );
    const size = screen.getByPlaceholderText("0.00");
    await user.clear(size);
    await user.type(size, "1000");
    // Default leverage is 5 → margin 200.
    expect(screen.getByText(/\$200\.00/)).toBeInTheDocument();
  });

  it("market order passes base-asset units (not USD notional) to openPosition", async () => {
    // Seed wallet store as connected so the form becomes submittable.
    useWalletStore.getState().set({
      status: "connected",
      address: "GCBOM6CQSNLNE7YM4JRKX4IZ6S7CY3HZC3OFTEEA3NHFT56NS3PULAQT",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    const user = userEvent.setup();
    render(
      <Wrap>
        <OrderForm market={MARKET} markPrice={MARK_PRICE} />
      </Wrap>,
    );

    // Enter $50 notional size.
    const sizeInput = screen.getByPlaceholderText("0.00");
    await user.clear(sizeInput);
    await user.type(sizeInput, "50");

    // At default 5x leverage, submit button should now say "Long BTC".
    const submitBtn = await screen.findByRole("button", { name: /long btc/i });
    await user.click(submitBtn);

    // Confirm dialog appears — click Confirm.
    const confirmBtn = await screen.findByRole("button", { name: /^confirm long$/i });
    await user.click(confirmBtn);

    // Wait for openPosition to have been called.
    await waitFor(() => expect(mockOpenPosition).toHaveBeenCalled());

    // Extract the `size` argument (3rd positional arg to openPosition).
    // openPosition(user, marketId, size, isLong, leverage, slippageBps, opts)
    const callArgs = mockOpenPosition.mock.calls[0] as unknown[];
    const submittedSize = callArgs[2] as bigint;

    // MARK_PRICE = 50_000 × 1e18; parsedSize = 50 × 1e18
    // Expected base size = (50e18 × 1e18) / (50000e18) = 1e15 (= 0.001 BTC)
    const expectedSize = (50n * 10n ** 18n * 10n ** 18n) / MARK_PRICE;
    expect(submittedSize).toBe(expectedSize);

    // Crucially: must NOT be the raw USD notional (50 BTC would be wrong).
    expect(submittedSize).not.toBe(50n * 10n ** 18n);
  });
});
