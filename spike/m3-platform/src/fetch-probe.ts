/**
 * Can a Worker's outbound fetch reach loopback, private, link-local or CGNAT addresses, by IP or
 * through a public hostname that resolves to one? Each target reports what came back.
 */
export const PROBE_TARGETS = [
  'http://127.0.0.1/',
  'http://localhost/',
  'http://[::1]/',
  'http://0.0.0.0/',
  'http://10.0.0.1/',
  'http://172.16.0.1/',
  'http://192.168.1.1/',
  'http://169.254.169.254/latest/meta-data/',
  'http://100.64.0.1/',
  'https://127.0.0.1/',
  // Public names whose DNS answers are private addresses (the DNS-rebinding shape).
  'http://localtest.me/',
  'http://127.0.0.1.nip.io/',
  'http://10.0.0.1.nip.io/',
  'http://192.168.1.1.nip.io/',
  'https://10.0.0.1.nip.io/',
  // Controls: a public IP and a public name.
  'http://1.1.1.1/',
  'https://example.com/',
];

export async function probe(url: string) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 140);
    return { url, status: res.status, server: res.headers.get('server'), cfRay: res.headers.has('cf-ray'), body, ms: Date.now() - started };
  } catch (e) {
    return { url, error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 200), ms: Date.now() - started };
  }
}
