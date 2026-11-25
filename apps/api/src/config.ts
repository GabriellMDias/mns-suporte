import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { normalizeEmail } from "./email-address.js";

// This is the only application module that interprets environment values.
export const serverConfigSchema = Type.Object(
  {
    environment: Type.Union([
      Type.Literal("development"),
      Type.Literal("test"),
      Type.Literal("production"),
    ]),
    releaseId: Type.String({ pattern: "^[A-Za-z0-9._-]{1,128}$" }),
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 0, maximum: 65535 }),
    logLevel: Type.Union([
      Type.Literal("fatal"),
      Type.Literal("error"),
      Type.Literal("warn"),
      Type.Literal("info"),
      Type.Literal("debug"),
      Type.Literal("trace"),
    ]),
    shutdownTimeoutMs: Type.Integer({ minimum: 100, maximum: 30000 }),
    otlpEndpoint: Type.Optional(Type.String({ format: "uri" })),
    traceSampleRatio: Type.Number({ minimum: 0, maximum: 1 }),
    databaseUrl: Type.Optional(Type.String({ minLength: 1 })),
    tokenIssuer: Type.Optional(Type.String({ minLength: 1 })),
    tokenAudience: Type.Optional(Type.String({ minLength: 1 })),
    tokenJwksUrl: Type.Optional(Type.String({ minLength: 1 })),
    whatsappAppSecret: Type.Optional(Type.String({ pattern: "^\\S{16,512}$" })),
    whatsappVerifyToken: Type.Optional(
      Type.String({ pattern: "^\\S{16,512}$" }),
    ),
    whatsappPhoneNumberId: Type.Optional(
      Type.String({ pattern: "^[0-9]{1,20}$" }),
    ),
    whatsappAccessToken: Type.Optional(
      Type.String({ pattern: "^\\S{16,2048}$" }),
    ),
    whatsappGraphApiVersion: Type.String({ pattern: "^v[1-9][0-9]{0,2}\\.0$" }),
    glpiApiUrl: Type.Optional(Type.String({ pattern: "^\\S{1,2048}$" })),
    glpiAppToken: Type.Optional(Type.String({ pattern: "^[!-~]{16,512}$" })),
    glpiUserToken: Type.Optional(Type.String({ pattern: "^[!-~]{16,512}$" })),
    identityCodeSecret: Type.Optional(
      Type.String({ pattern: "^[a-f0-9]{64}$" }),
    ),
    identityAllowedEmailDomains: Type.Optional(
      Type.String({ minLength: 1, maxLength: 2048 }),
    ),
    identitySmtpHost: Type.Optional(
      Type.String({ pattern: "^[A-Za-z0-9.-]{1,253}$" }),
    ),
    identitySmtpPort: Type.Integer({ minimum: 1, maximum: 65535 }),
    identitySmtpUser: Type.Optional(Type.String({ pattern: "^[ -~]{1,512}$" })),
    identitySmtpPassword: Type.Optional(
      Type.String({ pattern: "^[ -~]{1,512}$" }),
    ),
    identitySmtpFrom: Type.Optional(
      Type.String({ minLength: 1, maxLength: 254 }),
    ),
  },
  { additionalProperties: false },
);

export type ServerConfig = Readonly<Static<typeof serverConfigSchema>>;
export type ClientConfig = Readonly<Record<string, never>>;
export type GlpiConfig = Readonly<{
  apiUrl: string;
  appToken: string;
  userToken: string;
}>;
export type WhatsAppOutboundConfig = Readonly<{
  accessToken: string;
  graphVersion: string;
}>;
export type VerificationSmtpConfig = Readonly<{
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}>;
export type IdentityVerificationConfig = Readonly<{
  codeSecret: string;
  allowedEmailDomains: readonly string[];
  smtp: VerificationSmtpConfig;
}>;
export type WhatsAppWebhookConfig = Readonly<{
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
  outbound?: WhatsAppOutboundConfig;
  verificationCodeSecret?: string;
}>;

type ConfigMetadata = {
  key: keyof ServerConfig;
  name: string;
  type: string;
  required: boolean;
  default: string;
  visibility: "server";
  classification: "PUBLIC" | "INTERNAL" | "RESTRICTED";
  secret: boolean;
  purpose: string;
};

export const configReference = Object.freeze([
  {
    key: "environment",
    name: "ORION_ENV",
    type: "development | test | production",
    required: true,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Runtime environment.",
  },
  {
    key: "releaseId",
    name: "ORION_RELEASE_ID",
    type: "artifact identifier, 1..128 ASCII letters/digits/._-",
    required: false,
    default: "local",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose:
      "Actual artifact revision for correlated logs and traces; local for unversioned development.",
  },
  {
    key: "host",
    name: "ORION_API_HOST",
    type: "nonempty string",
    required: false,
    default: "127.0.0.1",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Listen address; loopback by default.",
  },
  {
    key: "port",
    name: "ORION_API_PORT",
    type: "integer 0..65535",
    required: false,
    default: "3000",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Listen port; zero selects an ephemeral port.",
  },
  {
    key: "logLevel",
    name: "ORION_LOG_LEVEL",
    type: "Pino level",
    required: false,
    default: "info",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Structured log threshold.",
  },
  {
    key: "shutdownTimeoutMs",
    name: "ORION_SHUTDOWN_TIMEOUT_MS",
    type: "integer 100..30000",
    required: false,
    default: "5000",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Total graceful shutdown deadline.",
  },
  {
    key: "otlpEndpoint",
    name: "ORION_OTLP_ENDPOINT",
    type: "http(s) URL",
    required: false,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Optional OTLP HTTP collector base URL.",
  },
  {
    key: "traceSampleRatio",
    name: "ORION_TRACE_SAMPLE_RATIO",
    type: "number 0..1",
    required: false,
    default: "1",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Trace sampling probability.",
  },
  {
    key: "databaseUrl",
    name: "ORION_DATABASE_URL",
    type: "PostgreSQL URL",
    required: false,
    default: "",
    visibility: "server",
    classification: "RESTRICTED",
    secret: true,
    purpose:
      "Runtime PostgreSQL credential; enables the database for modules that require it and adds it to readiness.",
  },
  {
    key: "tokenIssuer",
    name: "ORION_TOKEN_ISSUER",
    type: "issuer URL",
    required: false,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose:
      "Expected access-token issuer; configure with audience and JWKS URL to enable bearer authentication.",
  },
  {
    key: "tokenAudience",
    name: "ORION_TOKEN_AUDIENCE",
    type: "nonempty string",
    required: false,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Expected API access-token audience.",
  },
  {
    key: "tokenJwksUrl",
    name: "ORION_TOKEN_JWKS_URL",
    type: "http(s) URL",
    required: false,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Trusted issuer public-key endpoint.",
  },
  {
    key: "whatsappAppSecret",
    name: "WHATSAPP_APP_SECRET",
    type: "secret string",
    required: false,
    default: "",
    visibility: "server",
    classification: "RESTRICTED",
    secret: true,
    purpose: "Meta app secret used to verify incoming webhook signatures.",
  },
  {
    key: "whatsappVerifyToken",
    name: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    type: "secret string",
    required: false,
    default: "",
    visibility: "server",
    classification: "RESTRICTED",
    secret: true,
    purpose: "Application-generated secret used to verify the Meta callback.",
  },
  {
    key: "whatsappPhoneNumberId",
    name: "WHATSAPP_PHONE_NUMBER_ID",
    type: "Meta asset identifier",
    required: false,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Meta business phone number ID accepted by the webhook.",
  },
  {
    key: "whatsappAccessToken",
    name: "WHATSAPP_ACCESS_TOKEN",
    type: "secret string",
    required: false,
    default: "",
    visibility: "server",
    classification: "RESTRICTED",
    secret: true,
    purpose: "Meta system user token that enables WhatsApp outbound dispatch.",
  },
  {
    key: "whatsappGraphApiVersion",
    name: "WHATSAPP_GRAPH_API_VERSION",
    type: "Graph API version",
    required: false,
    default: "v27.0",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Graph API version used by WhatsApp outbound dispatch.",
  },
  {
    key: "glpiApiUrl",
    name: "GLPI_API_URL",
    type: "HTTPS URL",
    required: false,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Base URL of the GLPI REST v1 API, including its API path.",
  },
  {
    key: "glpiAppToken",
    name: "GLPI_APP_TOKEN",
    type: "secret string",
    required: false,
    default: "",
    visibility: "server",
    classification: "RESTRICTED",
    secret: true,
    purpose: "Application token for the configured GLPI API client.",
  },
  {
    key: "glpiUserToken",
    name: "GLPI_USER_TOKEN",
    type: "secret string",
    required: false,
    default: "",
    visibility: "server",
    classification: "RESTRICTED",
    secret: true,
    purpose: "User token for the scoped GLPI service account.",
  },
  {
    key: "identityCodeSecret",
    name: "IDENTITY_CODE_SECRET",
    type: "secret string",
    required: false,
    default: "",
    visibility: "server",
    classification: "RESTRICTED",
    secret: true,
    purpose: "32-byte hex key for verification code and mailbox digests.",
  },
  {
    key: "identityAllowedEmailDomains",
    name: "IDENTITY_ALLOWED_EMAIL_DOMAINS",
    type: "comma-separated domain names",
    required: false,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose:
      "Exact corporate email domains eligible for employee verification.",
  },
  {
    key: "identitySmtpHost",
    name: "IDENTITY_SMTP_HOST",
    type: "SMTP hostname",
    required: false,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "SMTP submission server used for employee verification email.",
  },
  {
    key: "identitySmtpPort",
    name: "IDENTITY_SMTP_PORT",
    type: "integer 1..65535",
    required: false,
    default: "587",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose:
      "SMTP submission port. Port 465 uses implicit TLS. Other ports require STARTTLS.",
  },
  {
    key: "identitySmtpUser",
    name: "IDENTITY_SMTP_USER",
    type: "nonempty string",
    required: false,
    default: "",
    visibility: "server",
    classification: "RESTRICTED",
    secret: true,
    purpose: "SMTP service credential username for employee verification mail.",
  },
  {
    key: "identitySmtpPassword",
    name: "IDENTITY_SMTP_PASSWORD",
    type: "secret string",
    required: false,
    default: "",
    visibility: "server",
    classification: "RESTRICTED",
    secret: true,
    purpose: "SMTP service credential password for employee verification mail.",
  },
  {
    key: "identitySmtpFrom",
    name: "IDENTITY_SMTP_FROM",
    type: "email address",
    required: false,
    default: "",
    visibility: "server",
    classification: "INTERNAL",
    secret: false,
    purpose: "Authorized From mailbox for employee verification email.",
  },
] as const satisfies readonly ConfigMetadata[]);

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (value.trim() === "") return Number.NaN;
  return Number(value);
}

function readAllowedEmailDomains(value: string): string[] {
  return [
    ...new Set(value.split(",").map((domain) => domain.trim().toLowerCase())),
  ];
}

export function parseServerConfig(
  env: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const candidate = {
    environment: env.ORION_ENV,
    releaseId: env.ORION_RELEASE_ID ?? "local",
    host: env.ORION_API_HOST ?? "127.0.0.1",
    port: numberFromEnv(env.ORION_API_PORT, 3000),
    logLevel: env.ORION_LOG_LEVEL ?? "info",
    shutdownTimeoutMs: numberFromEnv(env.ORION_SHUTDOWN_TIMEOUT_MS, 5000),
    ...(env.ORION_OTLP_ENDPOINT === undefined
      ? {}
      : { otlpEndpoint: env.ORION_OTLP_ENDPOINT }),
    traceSampleRatio: numberFromEnv(env.ORION_TRACE_SAMPLE_RATIO, 1),
    ...(env.ORION_DATABASE_URL === undefined
      ? {}
      : { databaseUrl: env.ORION_DATABASE_URL }),
    ...(env.ORION_TOKEN_ISSUER === undefined
      ? {}
      : { tokenIssuer: env.ORION_TOKEN_ISSUER }),
    ...(env.ORION_TOKEN_AUDIENCE === undefined
      ? {}
      : { tokenAudience: env.ORION_TOKEN_AUDIENCE }),
    ...(env.ORION_TOKEN_JWKS_URL === undefined
      ? {}
      : { tokenJwksUrl: env.ORION_TOKEN_JWKS_URL }),
    ...(env.WHATSAPP_APP_SECRET === undefined
      ? {}
      : { whatsappAppSecret: env.WHATSAPP_APP_SECRET }),
    ...(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN === undefined
      ? {}
      : { whatsappVerifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN }),
    ...(env.WHATSAPP_PHONE_NUMBER_ID === undefined
      ? {}
      : { whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }),
    ...(env.WHATSAPP_ACCESS_TOKEN === undefined
      ? {}
      : { whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN }),
    whatsappGraphApiVersion: env.WHATSAPP_GRAPH_API_VERSION ?? "v27.0",
    ...(env.GLPI_API_URL === undefined ? {} : { glpiApiUrl: env.GLPI_API_URL }),
    ...(env.GLPI_APP_TOKEN === undefined
      ? {}
      : { glpiAppToken: env.GLPI_APP_TOKEN }),
    ...(env.GLPI_USER_TOKEN === undefined
      ? {}
      : { glpiUserToken: env.GLPI_USER_TOKEN }),
    ...(env.IDENTITY_CODE_SECRET === undefined
      ? {}
      : { identityCodeSecret: env.IDENTITY_CODE_SECRET }),
    ...(env.IDENTITY_ALLOWED_EMAIL_DOMAINS === undefined
      ? {}
      : { identityAllowedEmailDomains: env.IDENTITY_ALLOWED_EMAIL_DOMAINS }),
    ...(env.IDENTITY_SMTP_HOST === undefined
      ? {}
      : { identitySmtpHost: env.IDENTITY_SMTP_HOST }),
    ...(env.IDENTITY_SMTP_USER === undefined
      ? {}
      : { identitySmtpUser: env.IDENTITY_SMTP_USER }),
    ...(env.IDENTITY_SMTP_PASSWORD === undefined
      ? {}
      : { identitySmtpPassword: env.IDENTITY_SMTP_PASSWORD }),
    ...(env.IDENTITY_SMTP_FROM === undefined
      ? {}
      : { identitySmtpFrom: env.IDENTITY_SMTP_FROM }),
    identitySmtpPort: numberFromEnv(env.IDENTITY_SMTP_PORT, 587),
  };
  if (!Value.Check(serverConfigSchema, candidate)) {
    throw new Error("Invalid API configuration");
  }
  if (candidate.otlpEndpoint !== undefined) {
    let endpoint: URL;
    try {
      endpoint = new URL(candidate.otlpEndpoint);
    } catch {
      throw new Error("Invalid API configuration: /otlpEndpoint");
    }
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error("Invalid API configuration: /otlpEndpoint");
    }
  }
  const authValues = [
    candidate.tokenIssuer,
    candidate.tokenAudience,
    candidate.tokenJwksUrl,
  ];
  // Access-token verification is all-or-none; module requirements are
  // enforced when modules activate.
  if (authValues.some(Boolean) && authValues.some((value) => !value))
    throw new Error(
      "Invalid API configuration: incomplete access-token verification",
    );
  for (const value of [
    candidate.databaseUrl,
    candidate.tokenIssuer,
    candidate.tokenJwksUrl,
  ]) {
    if (!value) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Invalid API configuration: URL");
    }
    const protocols =
      value === candidate.databaseUrl
        ? ["postgres:", "postgresql:"]
        : ["http:", "https:"];
    if (!protocols.includes(parsed.protocol))
      throw new Error("Invalid API configuration: URL protocol");
    if (value !== candidate.databaseUrl && parsed.protocol !== "https:") {
      if (
        candidate.environment === "production" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      )
        throw new Error("Invalid API configuration: token URL must use HTTPS");
    }
    if (
      !parsed.hostname ||
      (value !== candidate.databaseUrl &&
        (parsed.username || parsed.password || parsed.search || parsed.hash))
    )
      throw new Error("Invalid API configuration: URL components");
  }
  if (
    candidate.tokenAudience !== undefined &&
    candidate.tokenAudience.trim() === ""
  )
    throw new Error("Invalid API configuration: token audience");
  const whatsapp = [
    candidate.whatsappAppSecret,
    candidate.whatsappVerifyToken,
    candidate.whatsappPhoneNumberId,
  ];
  if (
    (whatsapp.some(Boolean) || candidate.whatsappAccessToken) &&
    whatsapp.some((value) => !value)
  )
    throw new Error("Invalid API configuration: incomplete WhatsApp webhook");
  const glpi = [
    candidate.glpiApiUrl,
    candidate.glpiAppToken,
    candidate.glpiUserToken,
  ];
  if (glpi.some(Boolean) && glpi.some((value) => !value))
    throw new Error("Invalid API configuration: incomplete GLPI integration");
  if (candidate.glpiApiUrl) {
    let apiUrl: URL;
    try {
      apiUrl = new URL(candidate.glpiApiUrl);
    } catch {
      throw new Error("Invalid API configuration: GLPI URL");
    }
    const developmentLoopback =
      apiUrl.protocol === "http:" &&
      candidate.environment !== "production" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname);
    if (
      (!developmentLoopback && apiUrl.protocol !== "https:") ||
      !apiUrl.hostname ||
      apiUrl.username ||
      apiUrl.password ||
      apiUrl.search ||
      apiUrl.hash
    )
      throw new Error("Invalid API configuration: GLPI URL");
  }
  const identity = [
    candidate.identityCodeSecret,
    candidate.identityAllowedEmailDomains,
    candidate.identitySmtpHost,
    candidate.identitySmtpUser,
    candidate.identitySmtpPassword,
    candidate.identitySmtpFrom,
  ];
  if (
    (identity.some(Boolean) || env.IDENTITY_SMTP_PORT !== undefined) &&
    (identity.some((value) => !value?.trim()) || glpi.some((value) => !value))
  )
    throw new Error(
      "Invalid API configuration: incomplete employee verification",
    );
  if (
    candidate.identityAllowedEmailDomains &&
    readAllowedEmailDomains(candidate.identityAllowedEmailDomains).some(
      (domain) => !normalizeEmail("validation@" + domain),
    )
  )
    throw new Error("Invalid API configuration: employee email domains");
  if (candidate.identitySmtpFrom && !normalizeEmail(candidate.identitySmtpFrom))
    throw new Error("Invalid API configuration: verification sender");
  return Object.freeze(candidate);
}

export function whatsappWebhookFrom(
  config: ServerConfig,
): WhatsAppWebhookConfig | undefined {
  const { whatsappAppSecret, whatsappVerifyToken, whatsappPhoneNumberId } =
    config;
  if (whatsappAppSecret && whatsappVerifyToken && whatsappPhoneNumberId)
    return Object.freeze({
      appSecret: whatsappAppSecret,
      verifyToken: whatsappVerifyToken,
      phoneNumberId: whatsappPhoneNumberId,
      ...(config.identityCodeSecret
        ? { verificationCodeSecret: config.identityCodeSecret }
        : {}),
      ...(config.whatsappAccessToken
        ? {
            outbound: Object.freeze({
              accessToken: config.whatsappAccessToken,
              graphVersion: config.whatsappGraphApiVersion,
            }),
          }
        : {}),
    });
  return undefined;
}

export function glpiConfigFrom(config: ServerConfig): GlpiConfig | undefined {
  const { glpiApiUrl, glpiAppToken, glpiUserToken } = config;
  if (glpiApiUrl && glpiAppToken && glpiUserToken)
    return Object.freeze({
      apiUrl: glpiApiUrl,
      appToken: glpiAppToken,
      userToken: glpiUserToken,
    });
  return undefined;
}

export function identityVerificationFrom(
  config: ServerConfig,
): IdentityVerificationConfig | undefined {
  const {
    identityCodeSecret,
    identityAllowedEmailDomains,
    identitySmtpHost,
    identitySmtpPort,
    identitySmtpUser,
    identitySmtpPassword,
    identitySmtpFrom,
  } = config;
  if (
    identityCodeSecret &&
    identityAllowedEmailDomains &&
    identitySmtpHost &&
    identitySmtpUser &&
    identitySmtpPassword &&
    identitySmtpFrom
  )
    return Object.freeze({
      codeSecret: identityCodeSecret,
      allowedEmailDomains: Object.freeze(
        readAllowedEmailDomains(identityAllowedEmailDomains),
      ),
      smtp: Object.freeze({
        host: identitySmtpHost,
        port: identitySmtpPort,
        user: identitySmtpUser,
        password: identitySmtpPassword,
        from: normalizeEmail(identitySmtpFrom)!,
      }),
    });
  return undefined;
}

// No browser-consumable API configuration exists. This projection
// prevents server settings from leaking into a future client configuration.
export function clientConfigFrom(config: ServerConfig): ClientConfig {
  void config;
  return Object.freeze({});
}
