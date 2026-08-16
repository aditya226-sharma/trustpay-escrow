import { describe, expect, it } from "vitest";
import { escrowProgress, fmtAmount, formatAddress, wholeToBaseUnits } from "../format";

describe("formatAddress", () => {
  it("truncates long addresses", () => {
    const addr = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(formatAddress(addr)).toBe("GAAAAA…AAAAAA");
  });

  it("leaves short strings untouched", () => {
    expect(formatAddress("abc")).toBe("abc");
    expect(formatAddress("")).toBe("");
  });
});

describe("fmtAmount", () => {
  it("converts base units (10^7) to whole tokens", () => {
    expect(fmtAmount(10_000_000n)).toBe("1");
    expect(fmtAmount(50_000_000n)).toBe("5");
  });

  it("handles fractional amounts", () => {
    expect(fmtAmount(1_250_000n)).toBe("0.125");
  });
});

describe("wholeToBaseUnits", () => {
  it("converts whole tokens to 7-decimal base units", () => {
    expect(wholeToBaseUnits(1000)).toBe(10_000_000_000n);
    expect(wholeToBaseUnits(1)).toBe(10_000_000n);
    expect(wholeToBaseUnits(0.5)).toBe(5_000_000n);
  });
});

describe("escrowProgress", () => {
  it("computes percentage progress", () => {
    expect(escrowProgress(1, 4)).toBe(25);
    expect(escrowProgress(4, 4)).toBe(100);
  });

  it("clamps out-of-range values", () => {
    expect(escrowProgress(9, 4)).toBe(100);
    expect(escrowProgress(-2, 4)).toBe(0);
    expect(escrowProgress(0, 0)).toBe(0);
  });
});
