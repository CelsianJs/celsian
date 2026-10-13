// @celsian/core -- SSE framing and connection ownership regressions
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSSEHub, createSSEStream } from "../src/sse.js";

afterEach(() => vi.useRealTimers());

function bodyOf(response: Response): ReadableStream<Uint8Array> {
  const body = response.body;
  if (!body) throw new Error("Expected an SSE response body");
  return body;
}

describe("SSE framing", () => {
  it.each(["\n", "\r\n", "\r"])("prefixes every data line separated by %j", async (newline) => {
    const channel = createSSEStream(new Request("http://localhost/events"), { pingInterval: 0 });
    const reader = bodyOf(channel.response).getReader();
    try {
      channel.send({
        event: "update",
        id: "42",
        data: `safe${newline}${newline}event: forged${newline}data: injected`,
      });
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(
        "event: update\nid: 42\ndata: safe\ndata: \ndata: event: forged\ndata: data: injected\n\n",
      );
    } finally {
      await reader.cancel();
      channel.close();
    }
  });
});

describe("SSE connection ownership", () => {
  it("does not retain a pre-aborted subscriber or allocate a surviving ping timer", async () => {
    vi.useFakeTimers();
    const hub = createSSEHub();
    const baselineTimers = vi.getTimerCount();
    const controller = new AbortController();
    controller.abort();
    const onClose = vi.fn();
    const channel = hub.subscribe(new Request("http://localhost/events", { signal: controller.signal }), {
      onClose,
    });
    try {
      expect(channel.open).toBe(false);
      expect(hub.size).toBe(0);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(baselineTimers);
      channel.sendData("ignored");
      expect(await bodyOf(channel.response).getReader().read()).toEqual({ done: true, value: undefined });
    } finally {
      hub.closeAll();
    }
  });

  it.each([0, 30_000])("releases a cancelled response immediately with ping interval %i", async (pingInterval) => {
    vi.useFakeTimers();
    const hub = createSSEHub();
    const baselineTimers = vi.getTimerCount();
    const onClose = vi.fn();
    const request = new Request("http://localhost/events");
    const removeListener = vi.spyOn(request.signal, "removeEventListener");
    const channel = hub.subscribe(request, { onClose, pingInterval });
    try {
      await bodyOf(channel.response).cancel();
      await Promise.resolve();
      expect(channel.open).toBe(false);
      expect(hub.size).toBe(0);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(baselineTimers);
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      channel.close();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      hub.closeAll();
    }
  });

  it("detaches the abort listener and closes once after explicit close then abort", async () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/events", { signal: controller.signal });
    const removeListener = vi.spyOn(request.signal, "removeEventListener");
    const onClose = vi.fn();
    const channel = createSSEStream(request, { pingInterval: 0, onClose });
    channel.close();
    controller.abort();
    await bodyOf(channel.response).cancel();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("releases a subscriber when its request aborts after a send", async () => {
    vi.useFakeTimers();
    const hub = createSSEHub();
    const baselineTimers = vi.getTimerCount();
    const controller = new AbortController();
    const onClose = vi.fn();
    const channel = hub.subscribe(new Request("http://localhost/events", { signal: controller.signal }), {
      onClose,
    });
    const reader = bodyOf(channel.response).getReader();
    try {
      channel.sendData("before close");
      controller.abort();
      expect(channel.open).toBe(false);
      expect(hub.size).toBe(0);
      expect(vi.getTimerCount()).toBe(baselineTimers);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: before close\n\n");
      expect((await reader.read()).done).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await reader.cancel();
      hub.closeAll();
    }
  });
});
