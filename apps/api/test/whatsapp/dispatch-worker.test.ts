import { once } from "node:events";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { registerWhatsAppDispatchWorker } from "../../src/features/whatsapp/dispatch-worker.js";

it("stops polling and cancels a live send before closing", async () => {
  const { app } = createApp(pino({ level: "silent" }));
  const dispatch = vi.fn(async (signal: AbortSignal) => {
    await once(signal, "abort");
    return true;
  });
  registerWhatsAppDispatchWorker(app, dispatch);
  try {
    await app.ready();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
  } finally {
    await app.close();
  }
  expect(dispatch.mock.calls[0]?.[0].aborted).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
