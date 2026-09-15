import { expect, test } from "@playwright/test";
import { expectUnrestrictedDashboard, readDashboardSession } from "../../helpers/userOnboarding";
import { masterKey, rootPath, uniqueSuffix } from "../../helpers/traffic";

test.use({ storageState: { cookies: [], origins: [] } });

test("an admin-set password restricts access until changed and followed by a fresh login", async ({
  page,
  request,
}) => {
  const userId = `e2e-password-reset-${uniqueSuffix()}`;
  const email = `${userId}@test.local`;
  const temporaryPassword = "E2e-Temporary-Pass-2026!";
  const newPassword = "E2e-Replaced-Pass-2026!";
  const headers = { Authorization: `Bearer ${masterKey()}` };
  const created = await request.post(`${rootPath()}/user/new`, {
    headers,
    data: {
      user_id: userId,
      user_email: email,
      user_role: "internal_user",
      auto_create_key: false,
    },
  });
  expect(created.ok(), `Create user: HTTP ${created.status()}`).toBe(true);
  try {
    const updated = await request.post(`${rootPath()}/user/update`, {
      headers,
      data: { user_id: userId, password: temporaryPassword },
    });
    expect(updated.ok(), `Set temporary password: HTTP ${updated.status()}`).toBe(true);

    await page.goto(`${rootPath()}/ui/login`);
    await page.getByPlaceholder("Enter your username").fill(email);
    await page.getByPlaceholder("Enter your password").fill(temporaryPassword);
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Change Password", exact: true })).toBeVisible();
    const restricted = await readDashboardSession(page);
    expect(restricted.password_reset_required).toBe(true);
    const denied = await request.get(`${rootPath()}/user/info`, {
      headers: { Authorization: `Bearer ${restricted.key}` },
      params: { user_id: userId },
    });
    expect(denied.status()).toBe(403);
    expect(await denied.text()).toContain("password must be changed");

    await page.getByLabel("Current Password", { exact: true }).fill(temporaryPassword);
    await page.getByLabel("New Password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm New Password", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Change Password", exact: true }).click();
    await expect(page).toHaveURL(/\/ui\/login\/?(?:\?.*)?$/);
    const info = await request.get(`${rootPath()}/user/info`, {
      headers,
      params: { user_id: userId },
    });
    expect(info.ok()).toBe(true);
    expect((await info.json()).user_info.password_reset_required).toBe(false);

    const stillRestricted = await request.get(`${rootPath()}/user/info`, {
      headers: { Authorization: `Bearer ${restricted.key}` },
      params: { user_id: userId },
    });
    expect(stillRestricted.status()).toBe(403);
    await page.getByPlaceholder("Enter your username").fill(email);
    await page.getByPlaceholder("Enter your password").fill(newPassword);
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await expectUnrestrictedDashboard(page);
  } finally {
    const [cleanup] = await Promise.allSettled([
      request.post(`${rootPath()}/user/delete`, { headers, data: { user_ids: [userId] } }),
    ]);
    expect.soft(cleanup.status === "fulfilled" && cleanup.value.ok(), "Delete test user after the password-reset journey").toBe(true);
  }
});
