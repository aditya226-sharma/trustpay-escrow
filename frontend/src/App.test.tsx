import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";
import FreighterApi from "@stellar/freighter-api";

vi.mock("@stellar/freighter-api", () => ({
  default: {
    isConnected: vi.fn().mockResolvedValue({ isConnected: false }),
    getAddress: vi.fn(),
  },
}));

vi.mock("./lib/contracts", () => ({
  getEscrowCount: vi.fn(),
  getEscrow: vi.fn(),
  createEscrow: vi.fn(),
  fundEscrow: vi.fn(),
  approveMilestone: vi.fn(),
  raiseDispute: vi.fn(),
  resolveDispute: vi.fn(),
  mutualRefund: vi.fn(),
  STATUS_LABELS: {},
  server: {},
  horizon: {},
}));

vi.mock("../../lib/events", () => ({
  fetchEscrowEvents: vi.fn().mockResolvedValue({ events: [], cursor: 0 }),
}));

describe("App", () => {
  it("renders the connect prompt when no wallet is detected", async () => {
    vi.mocked(FreighterApi.isConnected).mockResolvedValue({
      isConnected: false,
    });
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: /connect your freighter wallet/i }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /connect freighter/i }).length,
    ).toBeGreaterThan(0);
  });
});
