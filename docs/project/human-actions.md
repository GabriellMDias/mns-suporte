# MNS Suporte Human Actions

[Implementation plan](implementation-plan.md) · [Secrets policy](../security/secrets-management.md)

The entries below cover access held outside this workspace. Implementation, technical decisions, GitHub configuration and generating application-owned secrets are tracked in the implementation plan. Supply externally issued credentials in the designated secret store or ignored local configuration.

## PH-07

- [ ] **Grant access to the Meta assets required for cutover.**

**Status** Pending for company cutover. **Owner** MNS Meta Business account administrator.

The authorized temporary callback passed Meta verification. The MCP reported `messages` and the pilot account subscription to the intended app. A single approved recipient received a test message, and its delivery callback and reply reached the local receiver. The authorized participant completed guided intake through review after a worker restart. If the cutover sender belongs to a separate portfolio, grant equivalent access there. On 2026-11-25, the MCP confirmed the [Portuguese utility closure template](../../apps/api/README.md#whatsapp-closure-notices) was still pending Meta review. Affects PJ-18.

## PH-08

- [x] **Authorize the synthetic GLPI ticket and its status transitions.**

**Status** Completed for the production GLPI pilot. **Owner** MNS GLPI administrator and approved requester.

The administrator supplied the applicable business rules and authorized a synthetic ticket and its configured notifications. The requester opted in to WhatsApp closure notices. The pilot verified the attachment and closure. Meta confirmed delivery of the closure notice. Affects PJ-17.

## PH-09

- [x] **Enter the received verification code in the local pilot form.**

**Status** Completed for the pilot mailbox. **Owner** Approved mailbox owner.

The authorized mailbox matched an active GLPI user. The mailbox owner received the code through the configured SMTP relay and validated it in the temporary loopback-only form. The application persisted the verified identity for the approved WhatsApp conversation. Affects PJ-17.

## PH-10

- [ ] **Grant access to the company hosting and ingress.**

**Status** Pending for company cutover. **Owner** MNS infrastructure administrator.

The local pilot uses a temporary HTTPS endpoint. The company cutover requires deployment access and permissions for the persistent HTTPS endpoint, secret store, encrypted off-host backup destination, host scheduler and log collector. Affects PJ-18. The implementation and checks are tracked in the [deployment and recovery runbook](../runbooks/v1-deployment.md).

## PH-11

- [x] **Enable GitHub branch protection eligibility.**

**Status** Completed. **Owner** GitHub repository administrator.

The owner made the repository public on 2026-11-26. The active ruleset now enforces the CI gate on the default branch. See PJ-01 in the [implementation plan](implementation-plan.md#v1-work).

## PH-12

- [ ] **Grant IT operator access in the corporate token issuer.**

**Status** Pending for company deployment. **Owner** Corporate identity administrator.

Provide the approved issuer, API audience and JWKS endpoint. Grant the read and revocation scopes to the appropriate IT staff. The service can continue to use its independently authenticated WhatsApp webhook while operator access is unavailable. Affects the enablement of PJ-20 in PJ-18.
