import { describe, it, expect, beforeEach } from "vitest";
import { WriteQueue, Priority, WriteQueueTimeoutError } from "../ratelimit/queue.js";

describe("WriteQueue", () => {
  let queue: WriteQueue;

  beforeEach(() => {
    queue = new WriteQueue(5000);
  });

  it("executes a single write", async () => {
    const result = await queue.enqueue(() => 42);
    expect(result).toBe(42);
  });

  it("serializes concurrent writes", async () => {
    const order: number[] = [];
    const p1 = queue.enqueue(() => {
      order.push(1);
      return 1;
    });
    const p2 = queue.enqueue(() => {
      order.push(2);
      return 2;
    });
    const p3 = queue.enqueue(() => {
      order.push(3);
      return 3;
    });

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("propagates errors without stopping the queue", async () => {
    const p1 = queue.enqueue(() => {
      throw new Error("boom");
    });
    const p2 = queue.enqueue(() => "ok");

    await expect(p1).rejects.toThrow("boom");
    expect(await p2).toBe("ok");
  });

  it("respects priority order — HIGH before NORMAL before LOW", async () => {
    const order: string[] = [];
    // Create a slow first task to allow queuing
    const blocker = queue.enqueue(
      () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
    );

    // Queue up tasks at different priorities while blocker runs
    await new Promise((r) => setTimeout(r, 10));
    const low = queue.enqueue(() => { order.push("low"); }, Priority.LOW);
    const normal = queue.enqueue(() => { order.push("normal"); }, Priority.NORMAL);
    const high = queue.enqueue(() => { order.push("high"); }, Priority.HIGH);

    await Promise.all([blocker, low, normal, high]);
    expect(order).toEqual(["high", "normal", "low"]);
  });

  it("times out entries that wait too long", async () => {
    const shortQueue = new WriteQueue(50); // 50ms timeout

    // Block the queue with a task that takes longer than timeout
    const blocker = shortQueue.enqueue(
      () => new Promise((resolve) => setTimeout(resolve, 150)),
    );

    // Queue a second task — by the time blocker finishes, this has waited > 50ms
    const doomed = shortQueue.enqueue(() => "never");

    // Blocker itself will be timed out by Promise.race
    await expect(blocker).rejects.toThrow(WriteQueueTimeoutError);
    // The queued entry also times out (waited in queue too long)
    await expect(doomed).rejects.toThrow(WriteQueueTimeoutError);
  });

  it("tracks stats correctly", async () => {
    await queue.enqueue(() => 1);
    await queue.enqueue(() => 2);

    const stats = queue.stats;
    expect(stats.totalProcessed).toBe(2);
    expect(stats.depth).toBe(0);
    expect(stats.processing).toBe(false);
  });

  it("handles async write functions", async () => {
    const result = await queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "async-result";
    });
    expect(result).toBe("async-result");
  });
});
