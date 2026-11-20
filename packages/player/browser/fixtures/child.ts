/**
 * What a hostile template puts in a frame it adds: script that opens a peer connection to the ICE
 * servers in `servers` (space-separated) in the frame's own realm, gathers for 800 ms and posts what
 * it found `up` frames up, to the template. Plain text, so the fixture template can write it into a
 * frame and a test into the template's markup. No `"` or `&`, so it fits in an attribute as is.
 */
export const childScript = (servers: string, up: number): string =>
  `(async () => {
    const found = [];
    const pc = new RTCPeerConnection({ iceServers: ${JSON.stringify(servers).replaceAll('"', "'")}.split(' ').map((urls) => ({ urls, username: 'sf', credential: 'sf' })) });
    pc.onicecandidate = (e) => { if (e.candidate) found.push(e.candidate.candidate); };
    pc.createDataChannel('leak');
    await pc.setLocalDescription();
    await new Promise((r) => setTimeout(r, 800));
    pc.close();
    let to = window;
    for (let i = 0; i < ${up}; i++) to = to.parent;
    to.postMessage({ sfChild: found.join(' | ') }, '*');
  })()`;

export const childPage = (servers: string, up: number): string => `<script>${childScript(servers, up)}</script>`;

/** `html` as the value of a double-quoted attribute. */
export const attribute = (html: string): string => html.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
