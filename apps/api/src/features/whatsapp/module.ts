import type { ApiModule } from "../../module.js";
import { webhookErrors, webhookOperations } from "./contracts.js";
import { registerWhatsAppDispatchWorker } from "./dispatch-worker.js";
import { createWhatsAppGraphSender } from "./graph-client.js";
import {
  applyWhatsAppDeliveryStatuses,
  dispatchNextWhatsAppReply,
} from "./outbox.js";
import { registerWhatsAppWebhook } from "./routes.js";

export const whatsAppModule: ApiModule = {
  name: "whatsapp",
  tag: "WhatsApp webhook",
  requires: ["database", "whatsappWebhook"],
  operations: webhookOperations,
  errors: webhookErrors,
  activate: ({ database, whatsappWebhook }) => {
    const store = database!;
    const config = whatsappWebhook!;
    return {
      name: "whatsapp",
      register(app) {
        registerWhatsAppWebhook(app, config, async ({ messages, statuses }) => {
          await store.$transaction(async (transaction) => {
            if (messages.length > 0)
              await transaction.whatsAppInboundMessage.createMany({
                data: [...messages].sort((left, right) =>
                  left.messageId.localeCompare(right.messageId, "en"),
                ),
                skipDuplicates: true,
              });
            await applyWhatsAppDeliveryStatuses(
              transaction,
              config.phoneNumberId,
              statuses,
            );
          });
        });
        if (config.outbound) {
          const send = createWhatsAppGraphSender(
            config.phoneNumberId,
            config.outbound,
          );
          registerWhatsAppDispatchWorker(app, (signal) =>
            dispatchNextWhatsAppReply(
              store,
              config.phoneNumberId,
              send,
              signal,
            ),
          );
        }
      },
    };
  },
};
