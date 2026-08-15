import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ESCROW_CONTRACT, NETWORK } from "../config";

const server = new rpc.Server(NETWORK.rpcUrl);

export type LiveEvent = {
  id: string;
  ledger: number;
  createdAt: string;
  contractId: string;
  topics: string[];
  data: unknown;
};

export function toReadable(value: xdr.ScVal): string {
  try {
    return String(scValToNative(value));
  } catch {
    return value.toXDR("hex");
  }
}

export function parseRawEvent(raw: rpc.Api.EventResponse): LiveEvent {
  const topics = raw.topic.map(toReadable);
  const data = scValToNative(raw.value);
  return {
    id: raw.id,
    ledger: raw.ledger,
    createdAt: raw.ledgerClosedAt,
    contractId: String(raw.contractId ?? ""),
    topics,
    data,
  };
}

/**
 * Fetches the most recent contract events for the TrustPay escrow contract,
 * starting from a given ledger. Returns events newest-first.
 */
export async function fetchEscrowEvents(startLedger: number): Promise<{
  events: LiveEvent[];
  cursor: number;
}> {
  const response = await server.getEvents({
    startLedger: Math.max(1, startLedger),
    filters: [
      {
        type: "contract",
        contractIds: [ESCROW_CONTRACT],
      },
    ],
    limit: 30,
  });

  const events = response.events.map(parseRawEvent);
  const cursor =
    events.length > 0
      ? Math.max(...events.map((e) => e.ledger))
      : startLedger;

  return { events, cursor };
}
