CREATE TYPE "WhatsAppOutboundState" AS ENUM (
    'PENDING', 'SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNCERTAIN', 'EXPIRED'
);

CREATE TABLE "whatsapp_outbound_messages" (
    "id" UUID NOT NULL,
    "business_phone_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" "WhatsAppOutboundState" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempt_started_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_message_id" TEXT,
    "provider_error_code" INTEGER,
    "delivery_status_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_outbound_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_outbound_messages_attempts_nonnegative" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "whatsapp_outbound_messages_provider_key" ON "whatsapp_outbound_messages"("business_phone_id", "provider_message_id");
CREATE INDEX "whatsapp_outbound_messages_dispatch_idx" ON "whatsapp_outbound_messages"("business_phone_id", "state", "available_at");
