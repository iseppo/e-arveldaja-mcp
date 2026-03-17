import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Cache } from "./cache.js";

describe("Cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves values", () => {
    const cache = new Cache(300);
    cache.set("key1", { data: "hello" });
    expect(cache.get("key1")).toEqual({ data: "hello" });
  });

  it("returns undefined for missing keys", () => {
    const cache = new Cache(300);
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const cache = new Cache(10); // 10 second TTL
    cache.set("key1", "value");
    expect(cache.get("key1")).toBe("value");

    vi.advanceTimersByTime(11_000);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("respects custom TTL per entry", () => {
    const cache = new Cache(300);
    cache.set("short", "value", 5); // 5 seconds
    cache.set("long", "value", 600); // 600 seconds

    vi.advanceTimersByTime(6_000);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("value");
  });

  it("evicts oldest entry when at capacity", () => {
    const cache = new Cache(300, 3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // should evict "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("d")).toBe(4);
  });

  it("LRU: get moves entry to end, avoiding eviction", () => {
    const cache = new Cache(300, 3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    cache.get("a"); // touch "a", making "b" the oldest
    cache.set("d", 4); // should evict "b" (oldest untouched)

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("invalidates all entries", () => {
    const cache = new Cache(300);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.invalidate();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("invalidates by pattern", () => {
    const cache = new Cache(300);
    cache.set("connection:0:/clients:list", 1);
    cache.set("connection:0:/journals:list", 2);
    cache.set("connection:1:/clients:list", 3);

    cache.invalidate("connection:0:");

    expect(cache.get("connection:0:/clients:list")).toBeUndefined();
    expect(cache.get("connection:0:/journals:list")).toBeUndefined();
    expect(cache.get("connection:1:/clients:list")).toBe(3);
  });
});
