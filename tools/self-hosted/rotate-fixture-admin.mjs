// Disposable integration fixture only: create a real backup with admin B, then
// return the active IdP and file to A. No password/token is in argv or logs.
import { readFile } from 'node:fs/promises';
try {
  const current = (await readFile('/fixtures/KEYCLOAK_ADMIN_PASSWORD_FILE', 'utf8')).trim();
  const next = (await readFile('/fixtures/admin-next', 'utf8')).trim();
  const root = 'http://keycloak:8080';
  const auth = await fetch(root + '/realms/master/protocol/openid-connect/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: 'lp-admin', password: current }),
  });
  if (!auth.ok) throw new Error('fixture_admin_auth');
  const { access_token: token } = await auth.json();
  const options = { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: 'Bearer ' + token } };
  const found = await fetch(root + '/admin/realms/master/users?username=lp-admin&exact=true', options);
  if (!found.ok) throw new Error('fixture_admin_lookup');
  const users = await found.json();
  if (users.length !== 1) throw new Error('fixture_admin_lookup');
  const changed = await fetch(root + '/admin/realms/master/users/' + users[0].id + '/reset-password', {
    ...options, method: 'PUT', headers: { ...options.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'password', value: next, temporary: false }),
  });
  if (!changed.ok) throw new Error('fixture_admin_reset');
} catch {
  console.error('Disposable admin rotation fixture failed');
  process.exitCode = 1;
}
