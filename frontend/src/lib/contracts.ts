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
import { ESCROW_CONTRACT, NETWORK, NETWORK_PASSPHRASE, TOKEN_SYMBOL } from "../config";
import { wholeToBaseUnits } from "./format";

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

// Soroban enums are returned as their u32 discriminant.
const STATUS_BY_CODE = ["Active", "Completed", "Refunded", "Disputed"];

export function parseEscrow(raw: unknown): EscrowData {
  // The contract serializes the Escrow struct as a Vec; in field order.
  if (Array.isArray(raw)) {
    const [
      client,
      contractor,
      arbitrator,
      token,
      amount,
      milestone_count,
      current_milestone,
      funded,
      status,
      created_at,
    ] = raw;
    return {
      client: String(client),
      contractor: String(contractor),
      arbitrator: String(arbitrator),
      token: String(token),
      amount: typeof amount === "bigint" ? amount : BigInt(Number(amount)),
      milestone_count: Number(milestone_count),
      current_milestone: Number(current_milestone),
      funded: Boolean(funded),
      status: STATUS_BY_CODE[Number(status)] ?? String(status),
      created_at: typeof created_at === "bigint" ? created_at : BigInt(Number(created_at)),
    };
  }
  const rec = raw as EscrowData;
  if (Array.isArray(rec.status)) {
    rec.status = STATUS_BY_CODE[Number(rec.status[0])] ?? String(rec.status[0]);
  } else if (typeof rec.status === "number") {
    rec.status = STATUS_BY_CODE[rec.status] ?? String(rec.status);
  }
  return rec;
}

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
    const status = await getTransactionStatus(hash);
    if (status === "SUCCESS") return true;
    if (status === "FAILED") return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for the transaction to confirm");
}

// The SDK's typed getTransaction() fails to decode some response variants on
// current testnet (\"Bad union switch\"). Querying the RPC over plain JSON
// avoids decoding the full result and just reads the status field.
async function getTransactionStatus(hash: string): Promise<string> {
  const res = await fetch(NETWORK.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: { hash },
    }),
  });
  const body = await res.json();
  const status: string = body?.result?.status ?? "NOT_FOUND";
  return status;
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
  const raw = scValToNative(sim.result.retval);
  if (!raw || typeof raw !== "object") {
    throw new Error(`Escrow #${id} was not found on the testnet.`);
  }
  return parseEscrow(raw);
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
      i128(wholeToBaseUnits(p.amount)),
      u32(p.milestoneCount),
    );
  }, onHash);
  const count = await getEscrowCount(publicKey);
  createdId = count;
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
  return TOKEN_SYMBOL;
}

export { server, horizon };
