import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepAliveTimer } from "../src/keepalive";

describe("KeepAliveTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires after every full quiet interval", () => {
    const send = vi.fn();
    const timer = new KeepAliveTimer(25000, send);
    timer.start();
    vi.advanceTimersByTime(24999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(25000);
    expect(send).toHaveBeenCalledTimes(2);
    timer.stop();
  });

  it("restarts the countdown on send activity", () => {
    const send = vi.fn();
    const timer = new KeepAliveTimer(25000, send);
    timer.start();
    vi.advanceTimersByTime(20000);
    timer.notifyActivity();
    vi.advanceTimersByTime(20000);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it("is disabled by 0 and null", () => {
    for (const interval of [0, null]) {
      const send = vi.fn();
      const timer = new KeepAliveTimer(interval, send);
      timer.start();
      vi.advanceTimersByTime(100000);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("stops cleanly", () => {
    const send = vi.fn();
    const timer = new KeepAliveTimer(25000, send);
    timer.start();
    timer.stop();
    vi.advanceTimersByTime(100000);
    expect(send).not.toHaveBeenCalled();
  });
});
