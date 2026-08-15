import FreighterApi from "@stellar/freighter-api";

export type WalletState =
  | { status: "loading" }
  | { status: "disconnected" }
  | { status: "connected"; publicKey: string };

/**
 * Tries to connect to the Freighter browser extension. Throws a user-friendly
 * error if Freighter is missing or the user rejects the request.
 */
export async function connectWallet(): Promise<string> {
  let connected: boolean;
  try {
    const res = await FreighterApi.isConnected();
    connected = res.isConnected;
  } catch {
    throw new Error(
      "Freighter is not installed or is locked. Please install it from the Chrome Web Store.",
    );
  }
  if (!connected) {
    throw new Error("Freighter is not connected. Open the extension and unlock it.");
  }
  try {
    const res = await FreighterApi.getAddress();
    return res.address;
  } catch {
    throw new Error("Freighter could not provide your address. Please unlock the extension.");
  }
}

/** Restores an already-connected wallet (used on page load). */
export async function detectWallet(): Promise<WalletState> {
  try {
    const res = await FreighterApi.isConnected();
    if (!res.isConnected) return { status: "disconnected" };
    const addr = await FreighterApi.getAddress();
    return { status: "connected", publicKey: addr.address };
  } catch {
    return { status: "disconnected" };
  }
}
