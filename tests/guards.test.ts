/**
 * The interpolation guards.
 *
 * These matter more than their size suggests. `AS OF SYSTEM TIME` does not
 * accept a bind parameter and neither does the managed MCP server's SQL tool,
 * so two places in this codebase build SQL by string concatenation. Everything
 * standing between that and an injection hole is the three functions tested
 * here, which is why they are tested against attacks rather than typos.
 */
import { describe, it, expect } from "vitest";
import { assertHlc, toVector } from "../src/lib/db";
import { uuidLiteral, vectorLiteral } from "../src/lib/mcp";

describe("assertHlc", () => {
  it("accepts the shapes CockroachDB actually returns", () => {
    expect(() => assertHlc("1755300000000000000.0000000000")).not.toThrow();
    expect(() => assertHlc("1755300000000000000")).not.toThrow();
  });

  it("rejects anything that could carry SQL with it", () => {
    for (const attack of [
      "1755300000 OR 1=1",
      "1755300000; DROP TABLE memory",
      "1755300000 -- comment",
      "now()",
      "",
      "-1755300000",
      "1755e10",
    ]) {
      expect(() => assertHlc(attack), attack).toThrow(/non-numeric HLC/);
    }
  });
});

describe("uuidLiteral", () => {
  it("accepts a UUID and casts it explicitly", () => {
    expect(uuidLiteral("00000000-0000-0000-0000-0000000000aa")).toBe(
      "'00000000-0000-0000-0000-0000000000aa'::UUID",
    );
  });

  it("rejects a quoted-string escape", () => {
    expect(() => uuidLiteral("' OR '1'='1")).toThrow(/not a UUID/);
    // A valid UUID with a payload appended must not pass on a prefix match.
    expect(() =>
      uuidLiteral("00000000-0000-0000-0000-0000000000aa' OR '1'='1"),
    ).toThrow(/not a UUID/);
  });
});

describe("vectorLiteral", () => {
  it("renders a vector literal", () => {
    expect(vectorLiteral([0.1, -0.2, 3])).toBe("'[0.1,-0.2,3]'::VECTOR");
  });

  it("rejects non-finite values rather than emitting NaN into SQL", () => {
    expect(() => vectorLiteral([1, NaN])).toThrow(/non-finite/);
    expect(() => vectorLiteral([Infinity])).toThrow(/non-finite/);
  });
});

describe("toVector", () => {
  it("matches the format CockroachDB's VECTOR type parses", () => {
    expect(toVector([1, 2, 3])).toBe("[1,2,3]");
  });
});
