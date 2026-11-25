CREATE TYPE "WhatsAppConversationAction" AS ENUM ('REQUEST_CODE', 'CONFIRM_CODE');

ALTER TABLE "whatsapp_inbound_messages"
    ADD COLUMN "conversation_processed_at" TIMESTAMPTZ(3),
    ADD COLUMN "conversation_action" "WhatsAppConversationAction",
    ADD COLUMN "conversation_claim_id" UUID,
    ADD COLUMN "conversation_claim_until" TIMESTAMPTZ(3),
    ADD CONSTRAINT "whatsapp_inbound_messages_conversation_claim" CHECK (
        ("conversation_claim_id" IS NULL AND "conversation_claim_until" IS NULL)
        OR ("conversation_claim_id" IS NOT NULL AND "conversation_claim_until" IS NOT NULL
            AND "conversation_action" IS NOT NULL AND "conversation_processed_at" IS NULL)
    );

CREATE INDEX "whatsapp_inbound_messages_conversation_idx" ON "whatsapp_inbound_messages"
    ("business_phone_id", "conversation_processed_at", "received_at", "occurred_at", "message_id");

CREATE TABLE "whatsapp_conversations" (
    "scope_key" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("scope_key")
);
