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
  "CDZRHIQPRVWMQP4M55LBTZMJGLC4ICWXE2QCDEUU6BVFOHS33ISJKSK4",
);

// Testnet USDC (Stellar Asset Contract).
export const TOKEN_CONTRACT = env(
  "VITE_TOKEN_CONTRACT",
  "CDLDVFKHEZ2RVB3NG4UQA4VPD3TSHV6XMHXMHP2BSGCJ2IIWVTOHGDSG",
);

// A testnet contract used as the neutral arbitrator for demo escrows.
export const ARBITRATOR_CONTRACT = env(
  "VITE_ARBITRATOR_CONTRACT",
  "CBAJP5WF5EYNY35NYFDIYJBSFQMOC4H5LS6DIDF6ZZDMFKSNGLLCM5AE",
);
