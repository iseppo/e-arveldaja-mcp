import { describe, it, expect, vi, beforeEach } from "vitest";
import { log, setLogger } from "./logger.js";

describe("logger", () => {
  it("defaults to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log("info", "test message");
    expect(spy).toHaveBeenCalledWith("test message\n");
    spy.mockRestore();
  });

  it("uses custom logger after setLogger", () => {
    const messages: Array<{ level: string; message: string }> = [];
    setLogger((level, message) => { messages.push({ level, message }); });
    log("warning", "custom test");
    expect(messages).toEqual([{ level: "warning", message: "custom test" }]);
    // Reset to default
    setLogger((_level, message) => { process.stderr.write(`${message}\n`); });
  });
});
