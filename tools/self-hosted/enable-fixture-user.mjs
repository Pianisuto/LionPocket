// Synthetic clean-install fixture only. Production lpctl does not gain activation privileges.
import { readFile } from "node:fs/promises";
try {
  const root = "http://keycloak:8080";
  const password = (
    await readFile("/fixtures/KEYCLOAK_ADMIN_PASSWORD_FILE", "utf8")
  ).trim();
  const login = await fetch(
    root + "/realms/master/protocol/openid-connect/token",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({
        client_id: "admin-cli",
        grant_type: "password",
        username: "lp-admin",
        password,
      }),
    },
  );
  if (!login.ok) throw new Error("fixture_admin_failed");
  const { access_token } = await login.json();
  const options = {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: "Bearer " + access_token,
      "content-type": "application/json",
    },
  };
  const res = await fetch(
    root + "/admin/realms/lionpocket/users?username=fixture-alice&exact=true",
    options,
  );
  if (!res.ok) throw new Error("fixture_user_missing");
  const users = await res.json();
  if (users.length !== 1) throw new Error("fixture_user_missing");
  const update = await fetch(
    root + "/admin/realms/lionpocket/users/" + users[0].id,
    { ...options, method: "PUT", body: JSON.stringify({ enabled: true }) },
  );
  if (!update.ok) throw new Error("fixture_user_update_failed");
} catch {
  console.error("Disposable account fixture failed");
  process.exitCode = 1;
}
