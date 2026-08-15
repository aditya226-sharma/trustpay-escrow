import { describe, expect, it } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { parseRawEvent, toReadable } from "../events";

function makeRawEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "0000000000000001-0",
    type: "contract",
    ledger: 123456,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    pagingToken: "1-0",
    inSuccessfulContractCall: true,
    txHash: "aaaa",
    contractId: "CDZRHIQPRVWMQP4M55LBTZMJGLC4ICWXE2QCDEUU6BVFOHS33ISJKSK4",
    topic: [],
    value: xdr.ScVal.scvVoid(),
    ...overrides,
  };
}

describe("parseRawEvent", () => {
  it("decodes ScVal topics into readable values", () => {
    const raw = makeRawEvent({
      topic: [xdr.ScVal.scvSymbol("Created")],
    });

    const parsed = parseRawEvent(raw as never);
    expect(parsed.topics[0]).toBe("Created");
    expect(parsed.ledger).toBe(123456);
    expect(parsed.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(parsed.contractId).toContain("CDZR");
  });

  it("renders non-symbol topics (addresses) as strings", () => {
    const addressScVal = nativeToScVal(
      "GCCN4TV5WGFNCQQIWD6KDOMUONRSOFRS46F2DYZ7JU5PLQ7FXER3O5MA",
      { type: "address" },
    );

    const parsed = parseRawEvent(makeRawEvent({ topic: [addressScVal] }) as never);
    expect(parsed.topics[0]).toMatch(/^[GC]/);
  });
});

describe("toReadable", () => {
  it("falls back to raw XDR hex when a value cannot be decoded", () => {
    const weird = {
      switch: () => 999,
      toXDR: () => "deadbeef",
    } as unknown as xdr.ScVal;
    expect(toReadable(weird)).toBe("deadbeef");
  });
});
