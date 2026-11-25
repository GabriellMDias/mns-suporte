ALTER TYPE "WhatsAppConversationAction" ADD VALUE 'QUERY_TICKETS';

ALTER TABLE "whatsapp_inbound_messages"
    ADD COLUMN "conversation_requester_id" BIGINT,
    ADD CONSTRAINT "whatsapp_inbound_messages_requester_claim" CHECK (
        "conversation_requester_id" IS NULL
        OR ("conversation_requester_id" > 0 AND "conversation_claim_id" IS NOT NULL)
    );
