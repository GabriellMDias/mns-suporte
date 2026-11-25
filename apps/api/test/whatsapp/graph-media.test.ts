import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createWhatsAppMediaReader } from "../../src/features/whatsapp/graph-media.js";

const signal = new AbortController().signal;
const config = { accessToken: "synthetic-access-token", graphVersion: "v27.0" };
const mediaId = "100001";
const phoneId = "12345";
const bytes = new Uint8Array([1, 2, 3]);
const metadata = {
  id: mediaId,
  url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=100001",
  mime_type: "application/pdf",
  file_size: "3",
  sha256: createHash("sha256").update(bytes).digest("base64"),
};

it("requests phone-scoped metadata and validates the downloaded length and digest", async () => {
  const fetchMedia = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(
      new Response(bytes, { headers: { "content-type": "application/pdf" } }),
    );
  const read = createWhatsAppMediaReader(phoneId, config, fetchMedia);
  const result = await read(mediaId, signal);
  expect(result.kind).toBe("downloaded");
  if (result.kind !== "downloaded")
    throw new Error("Expected a downloaded file");
  expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(bytes);
  expect(result.extension).toBe("pdf");
  expect(fetchMedia.mock.calls.map(([url]) => String(url))).toEqual([
    "https://graph.facebook.com/v27.0/100001?phone_number_id=12345",
    metadata.url,
  ]);
  expect(
    fetchMedia.mock.calls.every(([, request]) => request?.redirect === "error"),
  ).toBe(true);
});

it("declines unsupported metadata before downloading and rejects incorrect binary data", async () => {
  const fetchMedia = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ ...metadata, file_size: 10_000_001 }),
    )
    .mockResolvedValueOnce(
      Response.json({ ...metadata, url: "https://download.example/document" }),
    )
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 4]), {
        headers: { "content-type": "application/pdf" },
      }),
    );
  const read = createWhatsAppMediaReader(phoneId, config, fetchMedia);
  expect(await read(mediaId, signal)).toEqual({ kind: "unsupported" });
  expect(await read(mediaId, signal)).toEqual({ kind: "unavailable" });
  expect(fetchMedia).toHaveBeenCalledTimes(2);
  expect(await read(mediaId, signal)).toEqual({ kind: "unavailable" });
  expect(fetchMedia).toHaveBeenCalledTimes(4);
});
