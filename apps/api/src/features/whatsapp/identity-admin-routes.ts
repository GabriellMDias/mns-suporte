import type { FastifyReply, FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { AccessTokenVerifier } from "../../authentication.js";
import type { Database } from "../../database.js";
import {
  coreErrors,
  defineErrors,
  errorEnvelopeSchema,
  errorResponder,
} from "../../errors.js";
import type { ApiOperation, AppInstance } from "../../module.js";
import { currentTraceId } from "../../request-context.js";
import {
  listIdentityLinks,
  revokeIdentityLink,
} from "./identity-administration.js";
import { deliveryIdSchema } from "./outbound-contract.js";

export const identityAdminErrors = defineErrors({
  WHATSAPP_IDENTITY_ADMIN_FORBIDDEN: {
    status: 403,
    message: "You do not have permission to manage WhatsApp identity links.",
    category: "authorization",
    retryable: false,
  },
});

const root = "/admin/whatsapp/identity-links";
const errorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  500: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};
const errors = [
  "VALIDATION_FAILED",
  "AUTHENTICATION_REQUIRED",
  "WHATSAPP_IDENTITY_ADMIN_FORBIDDEN",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
] as const;
const respond = errorResponder({ ...coreErrors, ...identityAdminErrors });
const utc = Type.String({ format: "date-time" });
const listQuery = Type.Object({
  glpiUserId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  after: Type.Optional(deliveryIdSchema),
});
const linkParams = Type.Object({ linkId: deliveryIdSchema });
export const identityAdminOperations = [
  {
    method: "GET",
    url: root,
    operationId: "listWhatsAppIdentityLinks",
    authenticated: true,
    description:
      "List one GLPI user's WhatsApp identities with masked phone suffixes using the whatsapp:links:read scope.",
    schema: {
      querystring: listQuery,
      response: {
        ...errorResponses,
        200: Type.Object({
          items: Type.Array(
            Type.Object({
              id: deliveryIdSchema,
              phoneLastFour: Type.Union([
                Type.String({ pattern: "^[0-9]{4}$" }),
                Type.Null(),
              ]),
              verifiedAt: utc,
              expiresAt: utc,
              status: Type.Union([
                Type.Literal("active"),
                Type.Literal("expired"),
                Type.Literal("revoked"),
              ]),
            }),
            { maxItems: 20 },
          ),
          next: Type.Union([deliveryIdSchema, Type.Null()]),
        }),
      },
    },
    expectedErrors: errors,
  },
  {
    method: "POST",
    url: root + "/:linkId/revoke",
    operationId: "revokeWhatsAppIdentityLink",
    authenticated: true,
    description:
      "Revoke exactly one verified WhatsApp identity using the whatsapp:links:revoke scope. Repeating the same request preserves the original revocation.",
    schema: {
      params: linkParams,
      response: {
        ...errorResponses,
        404: errorEnvelopeSchema,
        200: Type.Object({ revokedAt: utc }),
      },
    },
    expectedErrors: [...errors, "RESOURCE_NOT_FOUND"],
  },
] as const satisfies readonly ApiOperation[];

function failure(
  request: FastifyRequest,
  reply: FastifyReply,
  code: Parameters<typeof respond>[0],
) {
  const result = respond(code, request.id, currentTraceId());
  return reply.code(result.status).send(result.body);
}

export function registerIdentityAdministration(
  app: AppInstance,
  store: Database,
  verifier: AccessTokenVerifier | undefined,
) {
  const [list, revoke] = identityAdminOperations;
  const authorize = async (
    request: FastifyRequest,
    reply: FastifyReply,
    scope: string,
  ) => {
    reply.header("Cache-Control", "no-store");
    if (!verifier) {
      failure(request, reply, "SERVICE_UNAVAILABLE");
      return null;
    }
    const actor = await verifier.verify(request.headers.authorization);
    if (!actor) failure(request, reply, "AUTHENTICATION_REQUIRED");
    else if (!actor.scopes.has(scope))
      failure(request, reply, "WHATSAPP_IDENTITY_ADMIN_FORBIDDEN");
    else return actor;
    return null;
  };
  app.get(list.url, { schema: list.schema }, async (request, reply) => {
    if (!(await authorize(request, reply, "whatsapp:links:read"))) return;
    return reply
      .code(200)
      .send(
        await listIdentityLinks(
          store,
          request.query.glpiUserId,
          request.query.after,
          new Date(),
        ),
      );
  });
  app.post(revoke.url, { schema: revoke.schema }, async (request, reply) => {
    const actor = await authorize(request, reply, "whatsapp:links:revoke");
    if (!actor) return;
    const link = await revokeIdentityLink(
      store,
      request.params.linkId,
      actor.id,
    );
    if (!link) return failure(request, reply, "RESOURCE_NOT_FOUND");
    if (link.changed)
      request.log.info(
        { linkId: request.params.linkId },
        "whatsapp_identity_revoked",
      );
    return reply.code(200).send({ revokedAt: link.revokedAt });
  });
}
