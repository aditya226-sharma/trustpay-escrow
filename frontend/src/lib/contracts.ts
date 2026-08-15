import {
  Contract,
  Horizon,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import FreighterApi from "@stellar/freighter-api";
import { ESCROW_CONTRACT, NETWORK, NETWORK_PASSPHRASE } from "../config";

const server = new rpc.Server(NETWORK.rpcUrl);
const horizon = new Horizon.Server(NETWORK.horizonUrl);

export type EscrowData = {
  client: string;
  contractor: string;
  arbitrator: string;
  token: string;
  amount: bigint;
  milestone_count: number;
  current_milestone: number;
  funded: boolean;
  status: string;
  created_at: bigint;
};

export const STATUS_LABELS: Record<string, string> = {
  Active: "Active",
  Completed: "Completed",
  Refunded: "Refunded",
  Disputed: "Disputed",
};

const escrow = new Contract(ESCROW_CONTRACT);

function escrowCall(method: string, ...args: xdr.ScVal[]) {
  return escrow.call(method, ...args);
}

async function getSource(publicKey: string) {
  try {
    return await server.getAccount(publicKey);
  } catch (err) {
    throw new Error(
      "Your account could not be found on the testnet. Fund it with XLM at the Stellar testnet friendbot first.",
    );
  }
}

async function simulate(readonlyTx: Transaction) {
  const sim = await server.simulateTransaction(readonlyTx);
  if ("error" in sim && sim.error) {
    throw new Error(`Contract simulation failed: ${sim.error}`);
  }
  return sim as rpc.Api.SimulateTransactionSuccessResponse;
}

/** Signs a (already simulated and assembled) transaction with Freighter. */
async function signAndSend(tx: Transaction): Promise<Transaction> {
  const { signedTxXdr } = await FreighterApi.signTransaction(tx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE) as Transaction;
  const sendResponse = await server.sendTransaction(signedTx);
  if (sendResponse.status === "ERROR") {
    throw new Error(`Transaction rejected: ${sendResponse.errorResult?.result?.toString() ?? "unknown error"}`);
  }
  return signedTx;
}

/** Polls until the submitted transaction is confirmed on-chain. */
export async function waitForConfirmation(hash: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const result = await server.getTransaction(hash);
    if (result.status === "SUCCESS") return true;
    if (result.status === "FAILED") return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for the transaction to confirm");
}

async function runAction(
  publicKey: string,
  buildOperation: () => xdr.Operation,
  onHash: (hash: string) => void,
): Promise<void> {
  const source = await getSource(publicKey);
  const tx = new TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(buildOperation())
    .setTimeout(30)
    .build();

  const sim = await simulate(tx);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  const signedTx = await signAndSend(assembled);
  onHash(signedTx.hash().toString("hex"));
  const ok = await waitForConfirmation(signedTx.hash().toString("hex"));
  if (!ok) throw new Error("Transaction failed on-chain");
}

function u64(value: number | bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "u64" });
}

function u32(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

function i128(value: number | bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

function address(addr: string): xdr.ScVal {
  return nativeToScVal(addr, { type: "address" });
}

/** Reads the number of escrows created on the contract. */
export async function getEscrowCount(publicKey: string): Promise<number> {
  const source = await getSource(publicKey);
  const tx = new TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(escrowCall("get_count"))
    .setTimeout(30)
    .build();
  const sim = await simulate(tx);
  if (!sim.result?.retval) throw new Error("No result returned");
  return Number(scValToNative(sim.result.retval));
}

/** Reads a single escrow's full state. */
export async function getEscrow(publicKey: string, id: number): Promise<EscrowData> {
  const source = await getSource(publicKey);
  const tx = new TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(escrowCall("get_escrow", u64(id)))
    .setTimeout(30)
    .build();
  const sim = await simulate(tx);
  if (!sim.result?.retval) throw new Error("No result returned");
  const raw = scValToNative(sim.result.retval) as unknown as EscrowData;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Escrow #${id} was not found on the testnet.`);
  }
  return raw;
}

export type CreateParams = {
  client: string;
  contractor: string;
  arbitrator: string;
  token: string;
  amount: number;
  milestoneCount: number;
};

export async function createEscrow(
  publicKey: string,
  p: CreateParams,
  onHash: (hash: string) => void,
): Promise<number> {
  let createdId = -1;
  await runAction(publicKey, () => {
    createdId = -1;
    return escrowCall(
      "create",
      address(p.client),
      address(p.contractor),
      address(p.arbitrator),
      address(p.token),
      i128(p.amount),
      u32(p.milestoneCount),
    );
  }, onHash);
  const count = await getEscrowCount(publicKey);
  createdId = count - 1;
  return createdId;
}

export async function fundEscrow(publicKey: string, id: number, onHash: (hash: string) => void): Promise<void> {
  await runAction(publicKey, () => escrowCall("fund", u64(id)), onHash);
}

export async function approveMilestone(publicKey: string, id: number, onHash: (hash: string) => void): Promise<void> {
  await runAction(publicKey, () => escrowCall("approve_milestone", u64(id)), onHash);
}

export async function raiseDispute(publicKey: string, id: number, by: string, onHash: (hash: string) => void): Promise<void> {
  await runAction(publicKey, () => escrowCall("raise_dispute", u64(id), address(by)), onHash);
}

export async function resolveDispute(publicKey: string, id: number, onHash: (hash: string) => void): Promise<void> {
  await runAction(publicKey, () => escrowCall("resolve_dispute", u64(id)), onHash);
}

export async function mutualRefund(publicKey: string, id: number, onHash: (hash: string) => void): Promise<void> {
  await runAction(publicKey, () => escrowCall("mutual_refund", u64(id)), onHash);
}

export function tokenName(): string {
  return "USDC";
}

export { server, horizon };
