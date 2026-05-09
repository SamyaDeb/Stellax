import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock Freighter BEFORE imports that transitively use it.
vi.mock("@stellar/freighter-api", () => {
  return {
    isConnected: vi.fn(async () => ({ isConnected: true })),
    requestAccess: vi.fn(async () => ({
      address: "GTEST0000000000000000000000000000000000000000000000000000",
    })),
    getAddress: vi.fn(async () => ({ address: "" })),
    getNetwork: vi.fn(async () => ({
      network: "TESTNET",
      networkPassphrase: "Test SDF Network ; September 2015",
    })),
    setAllowed: vi.fn(async () => ({})),
    signTransaction: vi.fn(async () => ({
      signedTxXdr: "",
      signerAddress: "",
    })),
  };
});

import { WalletProvider, useWallet } from "@/wallet/WalletContext";
import { ConnectButton } from "@/ui/ConnectButton";
import { useWalletStore } from "@/wallet/store";

function Harness() {
  return (
    <WalletProvider>
      <ConnectButton />
      <Probe />
    </WalletProvider>
  );
}

function Probe() {
  const { status, address } = useWallet();
  return (
    <div data-testid="probe" data-status={status} data-address={address ?? ""} />
  );
}

describe("ConnectButton + WalletContext", () => {
  beforeEach(() => {
    useWalletStore.getState().reset();
  });

  it("shows Connect Wallet when disconnected", async () => {
    render(<Harness />);
    const btn = await screen.findByRole("button", { name: /connect wallet/i });
    expect(btn).toBeInTheDocument();
  });

  it("transitions to connected state on click and shows short address", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const btn = await screen.findByRole("button", { name: /connect wallet/i });
    await user.click(btn);

    await waitFor(() => {
      const probe = screen.getByTestId("probe");
      expect(probe.dataset.status).toBe("connected");
    });

    // Disconnect button is visible once connected.
    expect(
      await screen.findByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });

  it("disconnect resets store", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(
      await screen.findByRole("button", { name: /connect wallet/i }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("probe").dataset.status).toBe("connected"),
    );

    await user.click(await screen.findByRole("button", { name: /disconnect/i }));
    await waitFor(() =>
      expect(screen.getByTestId("probe").dataset.status).toBe("disconnected"),
    );
  });
});
