# MNS Suporte

MNS Suporte is the MNS internal IT support channel for opening, consulting, and following GLPI tickets from WhatsApp. The [product scope](docs/project/product-scope.md) defines the guided V1 workflow and the boundary for future AI assistance.

## Current state

This repository was initialized on 2026-11-25 from Orion commit `6fe8aa850d9fc3d8e78584c6f4af27d524e3ac75`. It contains the foundation's architecture, policies, accepted ADRs, tooling, validation gate, CI, generated references, and internal [Living Documentation Portal](apps/web/README.md#living-documentation-portal), and the neutral web shell. The API verifies official Meta WhatsApp webhooks, persists inbound messages and dispatches queued replies with delivery tracking. The GLPI adapter supports exact active-user lookup, guarded ticket creation, verified document upload and requester-scoped ticket consultation. The guided WhatsApp menu verifies employees, provides the IT contact and stores resumable ticket drafts. The complete portal remains available in local development; production builds exclude it and its generated assets by default. Product help and public API documentation require separately approved sources and application-owned presentation under [the documentation policy](docs/architecture/living-documentation.md#documentation-audiences-and-publication). The employee identity service verifies corporate mailbox control through short-lived codes. A durable worker submits confirmed drafts to GLPI. Opted-in employees can receive WhatsApp notices for ticket closure. The product plan tracks the live pilot and cutover.

The [project plan](docs/project/implementation-plan.md) and [project human actions](docs/project/human-actions.md) own this repository's current work and external prerequisites. The [project manifest](.orion/project.json) records the project identity, the immutable initialization commit, and the Orion baseline currently integrated. [Project derivation](docs/project-derivation.md) explains how to inspect provenance and adopt newer Orion revisions through reviewed merges.

## Start here

| Task                                                                 | Entry point                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find the policy for a change                                         | [Documentation task index](docs/README.md)                                                                                                                                                        |
| Understand contributor and agent obligations                         | [Global instructions](AGENTS.md), [contributing workflow](docs/contributing.md), [agent tool compatibility](docs/architecture/agent-instructions.md)                                              |
| Understand architecture and code placement                           | [Principles](docs/architecture/principles.md), [repository structure](docs/architecture/repository-structure.md)                                                                                  |
| Add a product capability                                             | [API modules](apps/api/README.md#modules), [web modules](apps/web/README.md#modules), [Orion's reference implementation](docs/project-derivation.md#orions-reference-implementation)              |
| Find a selected technology or its rationale                          | [Technology map](docs/architecture/technology-decisions.md), [ADR index](docs/adr/README.md)                                                                                                      |
| Determine available verification                                     | [Validation](docs/validation.md)                                                                                                                                                                  |
| Reproduce the local workflow                                         | [Development setup](docs/setup.md)                                                                                                                                                                |
| Explore local guides, architecture, API routes, data, and components | [Portal setup](docs/setup.md#living-documentation-portal), [living documentation architecture](docs/architecture/living-documentation.md), [AI-readable references](docs/README.md#apis-and-data) |
| Find outstanding work or external access requirements                | The plan and human actions linked from [Current state](#current-state)                                                                                                                            |
| Inspect provenance or adopt a newer Orion revision                   | [Project derivation](docs/project-derivation.md)                                                                                                                                                  |
| Create an operational procedure                                      | [Runbooks](docs/runbooks/README.md)                                                                                                                                                               |

Accepted architecture and implemented capability are different states. Consult the [technology map](docs/architecture/technology-decisions.md) for selected directions and deliberately deferred choices, and [validation availability](docs/validation.md) for current checks. With Node.js 24.13.0 and pnpm 11.25.0, follow the canonical [development setup](docs/setup.md) for installation, local environment loading, execution, and the full gate.

Directory trees in architecture documents describe intended responsibilities, not proof that those directories exist. The physical repository takes precedence over illustrations. English is the canonical repository language; product localization is separate.

## License

MNS Suporte is maintained for internal use. Material inherited from Orion remains available under the [Apache License 2.0](LICENSE).
