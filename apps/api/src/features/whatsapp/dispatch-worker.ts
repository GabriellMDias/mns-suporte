import type { AppInstance } from "../../module.js";

export function registerWhatsAppDispatchWorker(
  app: AppInstance,
  dispatch: (signal: AbortSignal) => Promise<boolean>,
  failureEvent:
    | "whatsapp_dispatch_unavailable"
    | "whatsapp_conversation_unavailable"
    | "whatsapp_ticket_submission_unavailable" = "whatsapp_dispatch_unavailable",
): void {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let failureReported = false;

  function schedule(delay: number) {
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      inFlight = dispatch(controller.signal).then(
        (processed) => {
          failureReported = false;
          schedule(processed ? 25 : 1000);
        },
        () => {
          if (!failureReported && !controller.signal.aborted)
            app.log.warn(failureEvent);
          failureReported = true;
          schedule(5000);
        },
      );
    }, delay);
    timer.unref();
  }

  app.addHook("onReady", (done) => {
    schedule(1000);
    done();
  });
  app.addHook("preClose", (done) => {
    controller.abort();
    clearTimeout(timer);
    done();
  });
  app.addHook("onClose", async () => {
    await inFlight;
  });
}
