GRANT SELECT, INSERT ON whatsapp_closure_preferences TO orion_runtime;
GRANT UPDATE (glpi_user_id, grant_id, recipient, granted_at, revoked_at) ON whatsapp_closure_preferences TO orion_runtime;
GRANT UPDATE (closure_consent_id, closure_check_at, notice_cursor) ON whatsapp_ticket_submissions TO orion_runtime;
