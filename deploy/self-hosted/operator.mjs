import { readFile } from 'node:fs/promises';
// Passwords arrive only over stdin / external mounted secret files, never argv or stdout.
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16384) throw new Error('invalid_input');
  }
  const { action, username, password } = JSON.parse(input);
  if (action === 'status') {
    for (const url of ['https://' + process.env.SYNC_HOST + '/v1/environment', 'https://' + process.env.AUTH_HOST + '/realms/lionpocket/.well-known/openid-configuration']) {
      const result = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!result.ok) throw new Error('operator_unavailable');
    }
    console.log(JSON.stringify({ healthy: true }));
    process.exit(0);
  }
  if (!['create', 'lookup', 'disable', 'check-admin'].includes(action) || (action !== 'check-admin' && !/^[a-zA-Z0-9._@-]{1,128}$/.test(username)))
    throw new Error('invalid_input');
  const root = 'http://keycloak:8080';
  const admin = (await readFile('/run/secrets/admin_password', 'utf8')).trim();
  const auth = await fetch(root + '/realms/master/protocol/openid-connect/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: 'lp-admin', password: admin }),
  });
  if (!auth.ok) throw new Error('admin_login_failed');
  const { access_token: token } = await auth.json();
  if (action === 'check-admin') {
    console.log(JSON.stringify({ authenticated: true }));
    process.exit(0);
  }
  const request = async (path, method = 'GET', body) => {
    const res = await fetch(root + '/admin/realms/lionpocket/' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(res.status === 409 ? 'user_exists' : 'user_operation_failed');
    return res;
  };
  if (action === 'create') {
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('password_too_short');
    await request('users', 'POST', { username, enabled: true, credentials: [{ type: 'password', value: password, temporary: false }] });
    console.log(JSON.stringify({ created: true }));
  } else {
    const users = await (await request('users?' + new URLSearchParams({ username, exact: 'true' }))).json();
    if (users.length !== 1 || !/^[0-9a-f-]{36}$/.test(users[0].id)) throw new Error('user_missing');
    const subject = users[0].id;
    if (action === 'disable') {
      await request('users/' + subject, 'PUT', { enabled: false });
      await request('users/' + subject + '/logout', 'POST');
    }
    console.log(JSON.stringify({ subject }));
  }
} catch (error) {
  const known = ['invalid_input', 'admin_login_failed', 'user_exists', 'user_operation_failed', 'password_too_short', 'user_missing'];
  console.error(known.includes(error.message) ? error.message : 'operator_unavailable');
  process.exitCode = 1;
}
