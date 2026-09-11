import { retryOnBusy } from "@server/db/retry";
import { describe, expect, it } from "vitest";

function codedError(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe("retryOnBusy", () => {
  it("retries SQLITE_BUSY and succeeds once the operation stops failing", async () => {
    let calls = 0;
    const result = await retryOnBusy(async () => {
      calls++;
      if (calls < 3) throw codedError("SQLITE_BUSY");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries TRANSACTION_ACTIVE the same way", async () => {
    let calls = 0;
    const result = await retryOnBusy(async () => {
      calls++;
      if (calls < 2) throw codedError("TRANSACTION_ACTIVE");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("gives up and surfaces the error after the attempt cap rather than looping forever", async () => {
    let calls = 0;
    await expect(
      retryOnBusy(async () => {
        calls++;
        throw codedError("SQLITE_BUSY");
      }),
    ).rejects.toThrow("SQLITE_BUSY");
    expect(calls).toBe(3);
  });

  it("does not retry an error that is neither SQLITE_BUSY nor TRANSACTION_ACTIVE", async () => {
    let calls = 0;
    await expect(
      retryOnBusy(async () => {
        calls++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("detects the error by its code, not by matching the message text", async () => {
    // The message deliberately does not mention SQLITE_BUSY or TRANSACTION_ACTIVE.
    let calls = 0;
    const result = await retryOnBusy(async () => {
      calls++;
      if (calls < 2) throw codedError("SQLITE_BUSY", "database is locked");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry a plain Error whose message happens to contain the word", async () => {
    // Guards against a substring-matching implementation: no `code` property at all.
    let calls = 0;
    await expect(
      retryOnBusy(async () => {
        calls++;
        throw new Error("SQLITE_BUSY: database is locked");
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
