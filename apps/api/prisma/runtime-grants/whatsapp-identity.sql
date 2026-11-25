GRANT SELECT, INSERT ON whatsapp_identity_events TO orion_runtime;
GRANT UPDATE (active, expires_at, attempts_left, glpi_user_id, code_digest) ON whatsapp_identity_events TO orion_runtime;
GRANT SELECT, INSERT ON whatsapp_verified_identities TO orion_runtime;
GRANT UPDATE (glpi_user_id, verified_at, expires_at) ON whatsapp_verified_identities TO orion_runtime;
