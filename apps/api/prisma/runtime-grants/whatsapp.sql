-- Webhook ingestion may append messages and keep the first accepted delivery.
GRANT INSERT ON whatsapp_inbound_messages TO orion_runtime;
