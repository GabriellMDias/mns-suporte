import type { ApiModule } from "../../module.js";
import { createGlpiClient } from "../../integrations/glpi/client.js";
import {
  createVerificationMailer,
  VerificationMailUnconfirmedError,
} from "../../integrations/mail/verification.js";
import { webhookErrors, webhookOperations } from "./contracts.js";
import { createConversationProcessor } from "./conversation-processor.js";
import { registerWhatsAppDispatchWorker } from "./dispatch-worker.js";
import { createWhatsAppGraphSender } from "./graph-client.js";
import { protectIdentityCode } from "./identity-code.js";
import { createPostgresIdentityRepository } from "./identity-repository.js";
import { createIdentityVerification } from "./identity-service.js";
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
  activate: ({ database, whatsappWebhook, whatsappConversation }) => {
    const store = database!;
    const config = whatsappWebhook!;
    return {
      name: "whatsapp",
      register(app) {
        registerWhatsAppWebhook(app, config, async ({ messages, statuses }) => {
          await store.$transaction(async (transaction) => {
            if (messages.length > 0)
              await transaction.whatsAppInboundMessage.createMany({
                data: [...messages]
                  .sort((left, right) =>
                    left.messageId.localeCompare(right.messageId, "en"),
                  )
                  .map((message) => ({
                    ...message,
                    content:
                      message.content.type === "text"
                        ? protectIdentityCode(
                            message.content.body,
                            message,
                            config.verificationCodeSecret,
                          )
                        : message.content,
                  })),
                skipDuplicates: true,
              });
            await applyWhatsAppDeliveryStatuses(
              transaction,
              config.phoneNumberId,
              statuses,
            );
          });
        });
        if (whatsappConversation && config.outbound) {
          const directory = createGlpiClient(whatsappConversation.glpi);
          const sendCode = createVerificationMailer(
            whatsappConversation.identity.smtp,
          );
          const identity = createIdentityVerification(
            createPostgresIdentityRepository(store),
            whatsappConversation.identity,
            (email) => directory.findActiveUserByEmail(email),
            async (recipient, code) => {
              try {
                await sendCode(recipient, code);
              } catch (error) {
                if (!(error instanceof VerificationMailUnconfirmedError))
                  throw error;
                app.log.warn("whatsapp_verification_mail_unconfirmed");
              }
            },
          );
          registerWhatsAppDispatchWorker(
            app,
            createConversationProcessor(
              store,
              {
                businessPhoneId: config.phoneNumberId,
                supportContact: whatsappConversation.supportContact,
              },
              identity,
            ),
            "whatsapp_conversation_unavailable",
          );
        }
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
