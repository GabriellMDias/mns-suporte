import { expect, it, vi } from "vitest";
import { createWhatsAppGraphSender } from "../../src/features/whatsapp/graph-client.js";
import { isOutboundPayload } from "../../src/features/whatsapp/outbound-contract.js";

const outboundConfig = {
  accessToken: "synthetic-access-value",
  graphVersion: "v27.0",
};
const phoneId = "10001";
const intent = "0bb2b64e-6a45-42a6-8f09-591eacc2de4f";
const signal = new AbortController().signal;
const payload = {
  recipient: { kind: "phone", value: "5511990000100" },
  content: { type: "text", body: "Escolha uma opção." },
} as const;

function parseRequestBody(options: RequestInit | undefined): unknown {
  const body = options?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(body);
}

it("sends text to a phone and interactive replies to a business-scoped ID", async () => {
  const fetchMessage = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(Response.json({ messages: [{ id: "wamid.synthetic" }] })),
    );
  const send = createWhatsAppGraphSender(phoneId, outboundConfig, fetchMessage);
  expect(await send(intent, payload, signal)).toEqual({
    kind: "accepted",
    messageId: "wamid.synthetic",
  });
  const [url, options] = fetchMessage.mock.calls[0];
  expect(url).toBe("https://graph.facebook.com/v27.0/10001/messages");
  expect(options).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: { authorization: "Bearer synthetic-access-value" },
  });
  expect(parseRequestBody(options)).toEqual({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: payload.recipient.value,
    biz_opaque_callback_data: intent,
    type: "text",
    text: { body: payload.content.body, preview_url: false },
  });

  const buttons = [
    { id: "tickets", title: "Meus chamados" },
    { id: "open", title: "Abrir chamado" },
  ];
  await send(
    intent,
    {
      recipient: { kind: "business_id", value: "BR.synthetic" },
      content: { type: "buttons", body: "Menu de suporte", buttons },
    },
    signal,
  );
  expect(parseRequestBody(fetchMessage.mock.calls[1][1])).toEqual({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    recipient: "BR.synthetic",
    biz_opaque_callback_data: intent,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Menu de suporte" },
      action: { buttons: buttons.map((reply) => ({ type: "reply", reply })) },
    },
  });
});

it("retries only an explicit throttle and preserves ambiguous outcomes", async () => {
  const fetchMessage = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 130429 } },
        { status: 429, headers: { "retry-after": "8" } },
      ),
    )
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 131047, message: "restricted detail" } },
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ error: { code: 130429 } }, { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json({ status: "unexpected" }))
    .mockResolvedValueOnce(
      Response.json({ error: { code: 130429 } }, { status: 408 }),
    )
    .mockRejectedValueOnce(new Error("synthetic disconnected socket"));
  const send = createWhatsAppGraphSender(phoneId, outboundConfig, fetchMessage);
  expect(await send(intent, payload, signal)).toEqual({
    kind: "throttled",
    code: 130429,
    retryAfterMs: 8000,
  });
  expect(await send(intent, payload, signal)).toEqual({
    kind: "rejected",
    code: 131047,
  });
  for (let trial = 0; trial < 4; trial++)
    expect(await send(intent, payload, signal)).toEqual({ kind: "uncertain" });
});

it("uses the approved positional utility template when a closure is sent outside the window", async () => {
  const fetchMessage = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(Response.json({ messages: [{ id: "wamid.closure" }] })),
    );
  const closure = {
    ...payload,
    recipient: { kind: "business_id", value: "BR.synthetic" },
    requiredGlpiUserId: 37,
    closure: {
      ticketId: 123,
      consentId: "c740e27e-a93b-4da4-a9a3-29e267b1dc04",
    },
  } as const;
  expect(isOutboundPayload({ ...closure, requiredGlpiUserId: undefined })).toBe(
    false,
  );
  const withoutTemplate = createWhatsAppGraphSender(
    phoneId,
    outboundConfig,
    fetchMessage,
  );
  expect(await withoutTemplate(intent, closure, signal)).toEqual({
    kind: "expired",
  });
  expect(fetchMessage).not.toHaveBeenCalled();
  const send = createWhatsAppGraphSender(
    phoneId,
    { ...outboundConfig, closureTemplateName: "mns_chamado_encerrado_v1" },
    fetchMessage,
  );
  await send(intent, closure, signal, new Date(Date.now() + 60_000));
  await send(intent, closure, signal, new Date(Date.now() - 60_000));
  expect(parseRequestBody(fetchMessage.mock.calls[0][1])).toMatchObject({
    type: "text",
    recipient: "BR.synthetic",
  });
  expect(parseRequestBody(fetchMessage.mock.calls[1][1])).toEqual({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    recipient: "BR.synthetic",
    biz_opaque_callback_data: intent,
    type: "template",
    template: {
      name: "mns_chamado_encerrado_v1",
      language: { code: "pt_BR" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "123" }] },
      ],
    },
  });
});

it("rejects malformed destinations and invalid interactive replies before they can queue", () => {
  expect(isOutboundPayload(payload)).toBe(true);
  expect(
    isOutboundPayload({
      ...payload,
      recipient: { kind: "phone", value: "not-a-phone" },
    }),
  ).toBe(false);
  expect(
    isOutboundPayload({ ...payload, content: { type: "text", body: "   " } }),
  ).toBe(false);
  const duplicateButton = { id: "open", title: "Abrir" };
  expect(
    isOutboundPayload({
      ...payload,
      content: {
        type: "buttons",
        body: "Menu",
        buttons: [duplicateButton, duplicateButton],
      },
    }),
  ).toBe(false);
});
