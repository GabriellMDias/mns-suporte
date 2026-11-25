import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WhatsAppOutboundConfig } from "../../config.js";

const maxBytes = 10_000_000;
const mediaIdSchema = Type.String({ pattern: "^[0-9]{1,32}$" });
const metadataSchema = Type.Object({
  id: mediaIdSchema,
  url: Type.String({ maxLength: 4096 }),
  mime_type: Type.String({ maxLength: 255 }),
  file_size: Type.Union([
    Type.Integer(),
    Type.String({ pattern: "^[0-9]{1,16}$" }),
  ]),
  sha256: Type.Optional(Type.String({ maxLength: 64 })),
});
const extensions = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["application/pdf", "pdf"],
  ["audio/ogg", "ogg"],
  ["audio/mpeg", "mp3"],
  ["audio/aac", "aac"],
  ["audio/mp4", "m4a"],
  ["audio/amr", "amr"],
]);

type MediaResult =
  | { kind: "downloaded"; file: Blob; extension: string }
  | { kind: "unavailable" | "unsupported" };

function normalizedMime(value: string | null): string | undefined {
  return value?.split(";")[0].trim().toLowerCase();
}

async function readDownload(
  response: Response,
  mime: string,
  size: number,
  checksum: string | undefined,
): Promise<Blob | undefined> {
  if (!response.body) return undefined;
  if (normalizedMime(response.headers.get("content-type")) !== mime) {
    await response.body.cancel();
    return undefined;
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.length > size) {
        await reader.cancel();
        return undefined;
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== size) return undefined;
  if (checksum !== undefined) {
    const digest = createHash("sha256").update(bytes).digest();
    if (
      checksum.toLowerCase() !== digest.toString("hex") &&
      checksum !== digest.toString("base64")
    )
      return undefined;
  }
  return new Blob([bytes], { type: mime });
}

export function createWhatsAppMediaReader(
  phoneNumberId: string,
  config: WhatsAppOutboundConfig,
  fetchMedia = fetch,
) {
  return async (mediaId: string, signal: AbortSignal): Promise<MediaResult> => {
    if (!Value.Check(mediaIdSchema, mediaId)) return { kind: "unsupported" };
    const metadataUrl = new URL(
      `https://graph.facebook.com/${config.graphVersion}/${mediaId}`,
    );
    metadataUrl.searchParams.set("phone_number_id", phoneNumberId);
    const init = {
      headers: { authorization: "Bearer " + config.accessToken },
      redirect: "error" as const,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    };
    try {
      const metadata = await fetchMedia(metadataUrl, init);
      if (!metadata.ok) {
        await metadata.body?.cancel();
        return {
          kind: metadata.status === 404 ? "unsupported" : "unavailable",
        };
      }
      const value: unknown = await metadata.json();
      if (!Value.Check(metadataSchema, value) || value.id !== mediaId)
        return { kind: "unavailable" };
      const mime = normalizedMime(value.mime_type) ?? "";
      const extension = extensions.get(mime);
      const size = Number(value.file_size);
      if (!extension || size < 1 || size > maxBytes)
        return { kind: "unsupported" };

      const url = URL.parse(value.url);
      if (
        !url ||
        url.origin !== "https://lookaside.fbsbx.com" ||
        url.pathname !== "/whatsapp_business/attachments/" ||
        url.username ||
        url.password
      )
        return { kind: "unavailable" };
      const download = await fetchMedia(url, init);
      if (!download.ok) {
        await download.body?.cancel();
        return { kind: "unavailable" };
      }
      const file = await readDownload(download, mime, size, value.sha256);
      return file
        ? { kind: "downloaded", file, extension }
        : { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  };
}
