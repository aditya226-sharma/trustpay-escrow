import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWallet, detectWallet } from "../wallet";
import FreighterApi from "@stellar/freighter-api";

vi.mock("@stellar/freighter-api", () => ({
  default: {
    isConnected: vi.fn(),
    getAddress: vi.fn(),
  },
}));

const mocked = FreighterApi as unknown as {
  isConnected: ReturnType<typeof vi.fn>;
  getAddress: ReturnType<typeof vi.fn>;
};

describe("wallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connectWallet returns the public key when connected", async () => {
    mocked.isConnected.mockResolvedValue({ isConnected: true });
    mocked.getAddress.mockResolvedValue({ address: "GABC…" });
    await expect(connectWallet()).resolves.toBe("GABC…");
  });

  it("connectWallet surfaces a helpful message when Freighter is not connected", async () => {
    mocked.isConnected.mockResolvedValue({ isConnected: false });
    await expect(connectWallet()).rejects.toThrow(
      "Freighter is not connected",
    );
  });

  it("connectWallet maps missing-extension errors", async () => {
    mocked.isConnected.mockRejectedValue(
      new Error("Freighter not installed"),
    );
    await expect(connectWallet()).rejects.toThrow(/install it from the Chrome Web Store/);
  });

  it("detectWallet reports disconnected when Freighter rejects", async () => {
    mocked.isConnected.mockRejectedValue(new Error("nope"));
    await expect(detectWallet()).resolves.toEqual({ status: "disconnected" });
  });
});
