import { describe, expect, it } from "vitest";
import { describeError } from "../workers/lib/describe-error";

describe("describeError", () => {
  it("falls back to String for a circular object", () => {
    const err: { self?: unknown } = {};
    err.self = err;
    expect(describeError(err)).toBe("[object Object]");
  });

  it("falls back to String for an object containing BigInt", () => {
    expect(describeError({ value: 1n })).toBe("[object Object]");
    expect(describeError(1n)).toBe("1");
  });

  it.each([
    { value: undefined, expected: "undefined" },
    { value: null, expected: "null" },
    { value: "original error", expected: "original error" },
    { value: { message: "original error" }, expected: '{"message":"original error"}' },
  ])("formats $expected without throwing", ({ value, expected }) => {
    expect(describeError(value)).toBe(expected);
  });

  it("falls back to String when JSON.stringify returns undefined for a function", () => {
    const err = () => "original error";
    expect(describeError(err)).toBe(String(err));
  });

  it("preserves the name, message and stack of an Error", () => {
    const err = new Error("original error");
    err.stack = "Error: original error\n    at example.ts:1:1";
    expect(describeError(err)).toBe(`Error: original error\n${err.stack}`);
  });

  it("preserves an Error subclass and its cause without a stack", () => {
    class MailError extends Error {
      override name = "MailError";
    }
    const cause = new TypeError("invalid address");
    cause.stack = undefined;
    const err = new MailError("delivery failed", { cause });
    err.stack = undefined;
    expect(describeError(err)).toBe(
      "MailError: delivery failed (cause: TypeError: invalid address)",
    );
  });

  it("keeps stack traces bounded", () => {
    const err = new Error("original error");
    err.stack = "x".repeat(1000);
    expect(describeError(err)).toBe(`Error: original error\n${"x".repeat(800)}`);
  });

  it("preserves the outer Error when its cause cannot be serialized", () => {
    const err = new Error("delivery failed", { cause: { value: 1n } });
    err.stack = undefined;
    expect(describeError(err)).toBe("Error: delivery failed (cause: [object Object])");
  });

  it("falls back to String when toJSON throws", () => {
    const err = {
      toJSON() {
        throw new Error("serialization failed");
      },
      toString() {
        return "original error";
      },
    };
    expect(describeError(err)).toBe("original error");
  });

  it("returns a fixed string when serialization and String both throw", () => {
    const err = {
      toJSON() {
        throw new Error("serialization failed");
      },
      [Symbol.toPrimitive]() {
        throw new Error("coercion failed");
      },
    };
    expect(describeError(err)).toBe("[Unformattable error]");
  });

  it.each(["name", "message", "cause", "stack"])(
    "does not throw when an Error's %s getter throws",
    (property) => {
      const err = new Error("original error");
      Object.defineProperty(err, property, {
        get() {
          throw new Error("property access failed");
        },
      });
      expect(describeError(err)).toBe(
        property === "name" || property === "message"
          ? "[Unformattable error]"
          : "Error: original error",
      );
    },
  );

  it("does not throw when instanceof encounters a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(describeError(proxy)).toBe("[Unformattable error]");
  });
});
