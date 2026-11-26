import { expect, test } from "@playwright/test";
import { expectNoStoredUserData } from "./storage.js";

test("lets IT review and revoke only one WhatsApp link", async ({ page }) => {
  const first = "35f555ee-cf1d-4fcf-b00f-268312235c62";
  const second = "dcd073ca-2188-4b80-828a-5e9210830021";
  let revoked: string | undefined;
  let reads = 0;
  await page.route("**/admin/whatsapp/identity-links**", async (request) => {
    const url = new URL(request.request().url());
    expect(request.request().headers().authorization).toBe(
      "Bearer synthetic-operator",
    );
    if (request.request().method() === "POST") {
      revoked = url.pathname.split("/").at(-2);
      await request.fulfill({
        json: { revokedAt: "2026-11-26T12:00:00.000Z" },
      });
      return;
    }
    expect(url.searchParams.get("glpiUserId")).toBe("37");
    reads += 1;
    await request.fulfill({
      json: {
        items: [
          { id: first, phoneLastFour: "0100" },
          { id: second, phoneLastFour: "0200" },
        ].map((item) => ({
          ...item,
          verifiedAt: "2026-11-25T12:00:00.000Z",
          expiresAt: "2026-12-25T12:00:00.000Z",
          status: item.id === revoked ? "revoked" : "active",
        })),
        next: null,
      },
    });
  });
  await page.goto(process.env.ORION_E2E_WEB_URL + "/ti/vinculos");
  await page.getByLabel("Token de acesso da TI").fill("synthetic-operator");
  await page.getByRole("button", { name: "Usar token" }).click();
  await page.getByLabel("ID do usuário no GLPI").fill("37");
  await page.getByRole("button", { name: "Consultar" }).click();
  await expect(page.getByRole("row", { name: /Final 0100/ })).toContainText(
    "Ativo",
  );
  await expect(page.getByRole("row", { name: /Final 0200/ })).toContainText(
    "Ativo",
  );
  await page.getByRole("button", { name: "Revogar vínculo 0100" }).click();
  expect(revoked).toBeUndefined();
  await page.getByRole("button", { name: "Confirmar revogação" }).click();
  await expect(page.getByRole("row", { name: /Final 0100/ })).toContainText(
    "Revogado",
  );
  await expect(page.getByRole("row", { name: /Final 0200/ })).toContainText(
    "Ativo",
  );
  expect(revoked).toBe(first);
  expect(reads).toBe(2);
  await page.getByRole("button", { name: "Encerrar acesso" }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expectNoStoredUserData(page);
});
