// TrustPay frontend configuration.
//
// The Stellar network endpoints and contract addresses are configurable via
// environment variables (see `.env.example`). The defaults point at Stellar
// testnet, so the app works out of the box for the demo deployment.

export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

export const NETWORKS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASE,
  },
} as const;

export const NETWORK = NETWORKS.testnet;

export function env(name: string, fallback: string): string {
  const raw = import.meta.env[name];
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

export const ESCROW_CONTRACT = env(
  "VITE_ESCROW_CONTRACT",
  "CCN4BHFSAAIOU4WC2PYBSFZ5WQLID7CJ7OXO44KYOAYGTTMVCXXMB5SQ",
);

// TRST demo token (Stellar Asset Contract), issued on testnet by the
// TrustPay deployer. Swap for testnet USDC in production.
export const TOKEN_CONTRACT = env(
  "VITE_TOKEN_CONTRACT",
  "CDBM4XZH7KIEYJVXI73F32J4NJC4QA4XZQTD66WTMCQPSTMDYQF3WHVK",
);

// Display symbol for the token shown in the UI.
export const TOKEN_SYMBOL = env("VITE_TOKEN_SYMBOL", "TRST");

// A testnet contract used as the neutral arbitrator for demo escrows.
export const ARBITRATOR_CONTRACT = env(
  "VITE_ARBITRATOR_CONTRACT",
  "CDGMGUM3ZPUE5IXHYQZBQAECA5JTNGJMNTEKZB2BQFPBKAFSSEJNH7NW",
);
