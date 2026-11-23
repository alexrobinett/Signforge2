// The person, against `wrangler dev`, so a real MCP client's OAuth flow can be completed from a
// terminal (RESULTS.md, "Real clients"). It signs in by email code (read from the spike's /dev/otp)
// with a cookie jar, as a browser would.
//
//   node scripts/person.mjs setup <cms-origin>
//     Signs in owner@spike.test and creates Northside Market (owner) and Hearth Café (made an
//     editor with `wrangler d1 execute`, printed for you to run).
//   node scripts/person.mjs consent <cms-origin> <authorize-url> <org name> <scope>... [--deliver]
//     Opens the client's authorize URL signed in, picks the org and scopes on the consent page,
//     Allows, and GETs the redirect to the client's callback (--deliver), which hands the code to a
//     client listening on a loopback port, or writes it to $CALLBACK_FILE for a client that asks for
//     it to be pasted. The code is never printed.
const [command, cms, ...rest] = process.argv.slice(2);
const EMAIL = 'owner@spike.test';
const jar = new Map();

async function request(url, init = {}) {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}
const post = (path, body) =>
  request(`${cms}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: cms }, body: JSON.stringify(body) });

async function signIn(oauthQuery) {
  await post('/api/auth/email-otp/send-verification-otp', { email: EMAIL, type: 'sign-in' });
  const { otp } = await (await fetch(`${cms}/dev/otp?email=${encodeURIComponent(EMAIL)}`)).json();
  const res = await post('/api/auth/sign-in/email-otp', { email: EMAIL, otp, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
  if (res.status !== 200) throw new Error(`sign-in: ${res.status} ${await res.text()}`);
  return res.json();
}

if (command === 'setup') {
  await signIn();
  for (const [name, slug] of [
    ['Northside Market', 'northside'],
    ['Hearth Café', 'hearth'],
  ]) {
    const res = await post('/api/auth/organization/create', { name, slug });
    console.log(name, res.status, (await res.json()).id ?? '');
  }
  console.log(
    `Now: wrangler d1 execute DB --local --command "UPDATE member SET role = 'editor' WHERE organizationId = (SELECT id FROM organization WHERE slug = 'hearth')"`,
  );
} else if (command === 'consent') {
  const deliver = rest.includes('--deliver');
  const [authorizeUrl, orgName, ...scopes] = rest.filter((a) => a !== '--deliver');
  // Signed out, the authorize endpoint sends the browser to /sign-in with its signed query.
  // Node's fetch always sends `sec-fetch-mode: cors`, so the plugin answers with JSON naming the
  // redirect rather than a 302, as it does for the CMS's own fetches.
  const first = await request(authorizeUrl);
  const toSignIn = new URL(first.headers.get('location') ?? (await first.json()).url, authorizeUrl);
  console.log('authorize →', first.status, toSignIn.pathname);
  const signedIn = await signIn(toSignIn.search.slice(1));
  const consentUrl = new URL(signedIn.url, cms);
  console.log('signed in →', consentUrl.pathname);
  const page = await (await request(consentUrl.href)).text();
  console.log('consent page:', page.match(/<h1>(.*?)<\/h1>/)[1].replace(/<[^>]+>/g, ''), '|', page.match(/<p>(.*?)<\/p>/)[1]);
  const oauthQuery = page.match(/name="oauth_query" value="([^"]*)"/)[1].replace(/&#38;/g, '&');
  const org = page.match(new RegExp(`value="([^"]+)" required> ${orgName} `))[1];
  const form = new URLSearchParams({ oauth_query: oauthQuery, org, accept: 'true' });
  for (const s of scopes) form.append('scope', s);
  const decided = await request(`${cms}/consent`, { method: 'POST', body: form, headers: { origin: cms } });
  const callback = decided.headers.get('location');
  console.log('allowed →', callback.replace(/code=[^&]+/, 'code=[redacted]'));
  if (deliver) {
    const res = await fetch(callback);
    console.log('delivered to the client:', res.status);
  } else {
    (await import('node:fs')).writeFileSync(process.env.CALLBACK_FILE, callback, { mode: 0o600 });
    console.log('callback written to $CALLBACK_FILE');
  }
} else {
  console.error('usage: person.mjs setup <cms> | consent <cms> <authorize-url> <org> <scope>... [--deliver]');
  process.exit(2);
}
