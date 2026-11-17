// Opens one screen socket to the deployed spike, sends "ping" every 20 s for the given minutes
// (each answered by the runtime's auto-response), then asks for the counters. If pings woke the
// object, `constructs` would rise with every ping. Usage: node scripts/hibernation.mjs <base> <minutes>
const [base, minutes = '3'] = process.argv.slice(2);
const screen = `hib-${Date.now().toString(36)}`;
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?screen=${screen}`);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const replies = [];
ws.addEventListener('message', (e) => replies.push(String(e.data)));
ws.addEventListener('close', (e) => { log('closed', e.code, e.reason); process.exit(1); });
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
log('open', screen);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = async () => {
  const n = replies.length;
  ws.send('stats');
  while (replies.length === n) await wait(50);
  return JSON.parse(replies.at(-1));
};
log('stats at start', JSON.stringify(await stats()));
const end = Date.now() + Number(minutes) * 60_000;
let pings = 0;
while (Date.now() < end) {
  await wait(20_000);
  const n = replies.length;
  const t = Date.now();
  ws.send('ping');
  while (replies.length === n) await wait(10);
  pings++;
  log(`ping ${pings} -> ${replies.at(-1)} in ${Date.now() - t} ms`);
}
log('stats at end', JSON.stringify(await stats()));
ws.close(1000);
