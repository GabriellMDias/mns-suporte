import { createTransport } from "nodemailer";
import type { VerificationSmtpConfig } from "../../config.js";

export function createVerificationMailer(config: VerificationSmtpConfig) {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.password },
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 4000,
    greetingTimeout: 4000,
    socketTimeout: 6000,
  });

  return async (recipient: string, code: string): Promise<void> => {
    try {
      const result = await transport.sendMail({
        from: config.from,
        to: recipient,
        subject: "Código de verificação do MNS Suporte",
        text:
          "Seu código para verificar o WhatsApp no MNS Suporte é " +
          code +
          ". Responda com o código completo no WhatsApp. Ele vale por 10 minutos. Se você não pediu este código, ignore este e-mail.",
        signal: AbortSignal.timeout(8000),
      });
      if (result.accepted.length !== 1)
        throw new Error("SMTP recipient was not accepted");
    } catch {
      // Nodemailer diagnostics can contain credentials, addresses and server text.
      throw new Error("Verification email delivery could not be confirmed");
    }
  };
}
