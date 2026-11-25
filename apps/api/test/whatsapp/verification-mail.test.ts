import { createServer, type Socket } from "node:net";
import { expect, it } from "vitest";
import { createVerificationMailer } from "../../src/integrations/mail/verification.js";

it("requires STARTTLS before SMTP authentication or sending a code", async () => {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 synthetic.example ESMTP\r\n");
    let pending = "";
    socket.on("data", (data: string) => {
      pending += data;
      const lines = pending.split("\r\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const command = line.split(" ")[0];
        commands.push(command);
        if (command === "EHLO") socket.write("250 synthetic.example\r\n");
        else socket.write("454 TLS unavailable\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing local fixture port");
    const sendCode = createVerificationMailer({
      host: "127.0.0.1",
      port: address.port,
      user: "synthetic-user",
      password: "synthetic-password",
      from: "support@company.example",
    });
    await expect(
      sendCode("employee@company.example", "MNS-ABCDEFGH"),
    ).rejects.toThrow("Verification email delivery could not be confirmed");
    expect(commands).toContain("STARTTLS");
    expect(commands).not.toContain("AUTH");
    expect(commands).not.toContain("MAIL");
    expect(commands).not.toContain("DATA");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
