// Opens a page in the Pi kiosk's Chromium through DevTools (tunnelled to localhost:9333), waits
// for window.__lna, prints it and closes the tab. Usage: node scripts/pi-lna.mjs <url>
const [url] = process.argv.slice(2);
const target = await (await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  pending.get(m.id)?.(m);
});
const call = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
let result;
for (let i = 0; i < 40 && !result; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const r = await call('Runtime.evaluate', { expression: 'JSON.stringify(window.__lna ?? null)', returnByValue: true });
  result = JSON.parse(r.result?.result?.value ?? 'null');
}
const ua = await call('Runtime.evaluate', { expression: 'navigator.userAgent + " | " + location.origin', returnByValue: true });
console.log(JSON.stringify({ page: ua.result.result.value, result }, null, 2));
await fetch(`http://127.0.0.1:9333/json/close/${target.id}`);
ws.close();
