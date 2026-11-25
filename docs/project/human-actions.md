# MNS Suporte Human Actions

[Implementation plan](implementation-plan.md) · [Secrets policy](../security/secrets-management.md)

The entries below cover access held outside this workspace. Implementation, technical decisions, GitHub configuration and generating application-owned secrets are tracked in the implementation plan. Supply externally issued credentials in the designated secret store or ignored local configuration.

## PH-07

- [ ] **Authorize access to the MNS Meta Business account and support number.**

**Status** Pending for live testing and cutover. **Owner** MNS Meta Business account administrator.

The current workspace has no delegated Meta Business session for the company. Grant appropriate roles on the MNS Meta business portfolio and WhatsApp account, or complete the account and number verification that requires access to the organization and its phone. Enable access to a test number before production. The team can then configure webhook subscriptions and submit the closure template. Verify with a signed test webhook, a test reply and later template approval. Affects PJ-15, PJ-17 and PJ-18.

## PH-08

- [ ] **Grant scoped access to the company GLPI environments.**

**Status** Pending for live testing and cutover. **Owner** MNS GLPI administrator.

The workspace has only the legacy integration copy. Issue a dedicated test service credential with directory lookup and scoped ticket and attachment permissions, and grant equivalent restricted production access for deployment. Supply the endpoint and credential securely. Verify by creating, consulting and attaching media to a synthetic ticket in test GLPI. The adapter is validated with local fixtures. This access affects the live pilot and cutover under PJ-17 and PJ-18.

## PH-09

- [ ] **Authorize an approved corporate mail sender.**

**Status** Pending for live testing. **Owner** MNS mail administrator.

Grant relay access or provide a service credential and verified From address for employee verification email. The workspace has no delegated corporate mail service. Verify delivery of a synthetic challenge to an approved test mailbox. Local employee verification has a synthetic transport. The real relay is required for the external pilot under PJ-17.

## PH-10

- [ ] **Grant access to the company hosting and ingress.**

**Status** Pending for external pilot and cutover. **Owner** MNS infrastructure administrator.

Grant deployment access and permissions for a company HTTPS endpoint, database and secret storage. The local Docker environment supports development and verification. The external webhook and production deployment require access to company infrastructure. Verify reachability over TLS, restricted database access and backup restore before moving the corporate number. Affects PJ-16 and PJ-18.

## PH-11

- [ ] **Grant GitHub plan eligibility for branch protection on the private repository.**

**Status** Blocked. **Owner** GitHub account or organization administrator.

On 2026-11-25, GitHub returned HTTP 403 for branch protection and rulesets on the private project and required a plan that supports those controls. Keep the repository private. Use an eligible organization or grant the existing owner the required plan when available. Verify by requiring the `Orion required gate` check through GitHub CLI and reading back the effective rule. CI and the pull-request workflow are available under the current plan. Affects PJ-01.
