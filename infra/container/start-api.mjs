import console from "node:console";
import { databaseUrl } from "./database.mjs";

try {
  process.env.ORION_DATABASE_URL = databaseUrl("orion_runtime");
  delete process.env.ORION_MIGRATION_DATABASE_URL;
  if (process.env.ORION_ENV === "production") {
    const { parseServerConfig, whatsappWebhookFrom, whatsappConversationFrom } =
      await import("../dist/config.js");
    const settings = parseServerConfig(process.env);
    if (
      !whatsappWebhookFrom(settings)?.outbound ||
      !whatsappConversationFrom(settings)
    )
      throw new Error("Incomplete production integration settings");
  }
  await import("../dist/main.js");
} catch {
  console.error(
    JSON.stringify({
      level: "error",
      event: "deployment_configuration_failed",
    }),
  );
  process.exitCode = 1;
}
