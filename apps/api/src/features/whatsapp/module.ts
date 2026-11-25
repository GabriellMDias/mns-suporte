import type { ApiModule } from "../../module.js";
import { webhookErrors, webhookOperations } from "./contracts.js";
import { registerWhatsAppWebhook } from "./routes.js";

export const whatsAppModule: ApiModule = {
  name: "whatsapp",
  tag: "WhatsApp webhook",
  requires: ["database", "whatsappWebhook"],
  operations: webhookOperations,
  errors: webhookErrors,
  activate: ({ database, whatsappWebhook }) => ({
    name: "whatsapp",
    register: (app) => {
      registerWhatsAppWebhook(app, whatsappWebhook!, async (messages) => {
        await database!.whatsAppInboundMessage.createMany({
          data: [...messages].sort((left, right) =>
            left.messageId.localeCompare(right.messageId, "en"),
          ),
          skipDuplicates: true,
        });
      });
    },
  }),
};
