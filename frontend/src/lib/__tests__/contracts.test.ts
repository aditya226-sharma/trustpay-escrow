import { describe, expect, it } from "vitest";
import { parseEscrow } from "../contracts";

// The Soroban struct returned by get_escrow is a Vec (array) in field order,
// and the Status enum arrives as its u32 discriminant. parseEscrow normalises
// this into the shape the UI renders.
describe("parseEscrow", () => {
  it("maps a raw struct array to EscrowData", () => {
    const raw = [
      "GBDCLIENT",
      "GBDCONTRACTOR",
      "CBQARBITRATOR",
      "CDBTOKEN",
      1_000_000_000n,
      3,
      1,
      true,
      0,
      123456789n,
    ];
    expect(parseEscrow(raw)).toEqual({
      client: "GBDCLIENT",
      contractor: "GBDCONTRACTOR",
      arbitrator: "CBQARBITRATOR",
      token: "CDBTOKEN",
      amount: 1_000_000_000n,
      milestone_count: 3,
      current_milestone: 1,
      funded: true,
      status: "Active",
      created_at: 123456789n,
    });
  });

  it("maps the status enum discriminant to a label", () => {
    const base = (status: number) =>
      ["GBDC", "GBDC", "CBQ", "CDB", 100n, 2, 0, true, status, 1n];
    expect(parseEscrow(base(0)).status).toBe("Active");
    expect(parseEscrow(base(1)).status).toBe("Completed");
    expect(parseEscrow(base(2)).status).toBe("Refunded");
    expect(parseEscrow(base(3)).status).toBe("Disputed");
  });

  it("handles the SDK object shape with an enum array", () => {
    expect(
      parseEscrow({
        client: "GBDC",
        contractor: "GBDC",
        arbitrator: "CBQ",
        token: "CDB",
        amount: 100n,
        milestone_count: 2,
        current_milestone: 0,
        funded: true,
        status: ["Completed"],
        created_at: 1n,
      }).status,
    ).toBe("Completed");
  });

  it("passes an already-object-shaped record through", () => {
    expect(parseEscrow({ status: "Active", amount: 5n })).toEqual({
      status: "Active",
      amount: 5n,
    });
  });
});
