import json, sys, urllib.request, websocket
secs = float(sys.argv[1]) if len(sys.argv) > 1 else 10
tabs = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json'))
page = next(t for t in tabs if t.get('type') == 'page')
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=secs + 30)
js = """new Promise(r => { const t = []; const end = performance.now() + %d;
 function f(ts) { t.push(ts); if (ts < end) requestAnimationFrame(f); else r(JSON.stringify({w: screen.width, h: screen.height, dpr: devicePixelRatio, t})); }
 requestAnimationFrame(f); })""" % int(secs * 1000)
ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': js, 'awaitPromise': True, 'returnByValue': True}}))
while True:
    m = json.loads(ws.recv())
    if m.get('id') == 1: break
v = json.loads(m['result']['result']['value'])
t = v['t']; d = sorted(b - a for a, b in zip(t, t[1:]))
n = len(d); mean = sum(d) / n
print(f"screen {v['w']}x{v['h']} dpr {v['dpr']}  frames {n}  fps {1000/mean:.2f}  median {d[n//2]:.3f} ms  p1 {d[n//100]:.3f}  p99 {d[n*99//100]:.3f}  max {d[-1]:.3f}  >25ms {sum(x > 25 for x in d)}")
