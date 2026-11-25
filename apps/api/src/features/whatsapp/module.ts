import type { ApiModule } from "../../module.js";
import { createGlpiClient } from "../../integrations/glpi/client.js";
import {
  createVerificationMailer,
  VerificationMailUnconfirmedError,
} from "../../integrations/mail/verification.js";
import { webhookErrors, webhookOperations } from "./contracts.js";
import { createClosureWorker } from "./closure-worker.js";
import { createConversationProcessor } from "./conversation-processor.js";
import { registerWhatsAppDispatchWorker } from "./dispatch-worker.js";
import { createWhatsAppGraphSender } from "./graph-client.js";
import { createWhatsAppMediaReader } from "./graph-media.js";
import { protectIdentityCode } from "./identity-code.js";
import { createPostgresIdentityRepository } from "./identity-repository.js";
import { createIdentityVerification } from "./identity-service.js";
import {
  applyWhatsAppDeliveryStatuses,
  dispatchNextWhatsAppReply,
} from "./outbox.js";
import { registerWhatsAppWebhook } from "./routes.js";
import { createTicketSubmissionWorker } from "./ticket-submission-worker.js";

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
          const glpi = createGlpiClient(whatsappConversation.glpi);
          const sendCode = createVerificationMailer(
            whatsappConversation.identity.smtp,
          );
          const identity = createIdentityVerification(
            createPostgresIdentityRepository(store),
            whatsappConversation.identity,
            (email) => glpi.findActiveUserByEmail(email),
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
          const conversationOptions = {
            businessPhoneId: config.phoneNumberId,
            supportContact: whatsappConversation.supportContact,
          };
          registerWhatsAppDispatchWorker(
            app,
            createConversationProcessor(
              store,
              {
                ...conversationOptions,
                readOwnedTickets: glpi.readOwnedTickets,
              },
              identity,
            ),
            "whatsapp_conversation_unavailable",
          );
          registerWhatsAppDispatchWorker(
            app,
            createTicketSubmissionWorker(
              store,
              conversationOptions,
              glpi,
              createWhatsAppMediaReader(config.phoneNumberId, config.outbound),
            ),
            "whatsapp_ticket_submission_unavailable",
          );
          registerWhatsAppDispatchWorker(
            app,
            createClosureWorker(
              store,
              {
                businessPhoneId: config.phoneNumberId,
                templateConfigured: !!config.outbound.closureTemplateName,
              },
              glpi.readOwnedTickets,
            ),
            "whatsapp_closure_unavailable",
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
