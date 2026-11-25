# MNS Suporte Human Actions

[Implementation plan](implementation-plan.md) · [Secrets policy](../security/secrets-management.md)

The entries below cover access held outside this workspace. Implementation, technical decisions, GitHub configuration and generating application-owned secrets are tracked in the implementation plan. Supply externally issued credentials in the designated secret store or ignored local configuration.

## PH-07

- [ ] **Authorize access to the MNS Meta Business account and support number.**

**Status** Pending for live testing and cutover. **Owner** MNS Meta Business account administrator.

The Meta MCP can access the supplied pilot sender. On 2026-11-25, Meta accepted one direct test message through that connection. The sender account subscription was present. The Meta business administrator can grant access to the relevant app and assets or provision the pilot runtime's scoped service token and Meta app secret in the secret store. If the live sender belongs to a separate portfolio, grant equivalent access there. The confirmed [closure template](../../apps/api/README.md#whatsapp-closure-notices) was submitted on 2026-11-25 and entered Meta review as Utility. Affects PJ-17 and PJ-18.

## PH-08

- [ ] **Grant scoped access to the company GLPI environments.**

**Status** Pending for live testing and cutover. **Owner** MNS GLPI administrator.

The workspace has only the legacy integration copy. Issue a dedicated test service credential with directory lookup, ticket creation, ticket and requester-relation read access, and permission to create and verify ticket attachments. Grant equivalent restricted production access for deployment. Supply the endpoint and credential securely. Affects PJ-17 and PJ-18.

## PH-09

- [ ] **Authorize an approved corporate mail sender.**

**Status** Pending for live testing. **Owner** MNS mail administrator.

Grant relay access or provide a service credential and verified From address for employee verification email. The workspace has no delegated corporate mail service. Affects PJ-17.

## PH-10

- [ ] **Grant access to the company hosting and ingress.**

**Status** Pending for external pilot and cutover. **Owner** MNS infrastructure administrator.

An MNS infrastructure administrator must grant deployment access, access to a company HTTPS endpoint for the Meta webhook, and permissions for the secret store, encrypted off-host backup destination, host scheduler and log collector. These systems require company credentials that are unavailable in the workspace. Affects PJ-17 and PJ-18. The implementation and checks are tracked in the [deployment and recovery runbook](../runbooks/v1-deployment.md).

## PH-11

- [ ] **Grant GitHub plan eligibility for branch protection on the private repository.**

**Status** Blocked. **Owner** GitHub account or organization administrator.

On 2026-11-25, GitHub returned HTTP 403 for branch protection and rulesets on the private project and required a plan that supports those controls. Enable a plan that supports protection on this private repository, or grant access to an eligible private organization. CI and the pull-request workflow are available under the current plan. Affects PJ-01.
