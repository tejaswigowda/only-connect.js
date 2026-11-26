// Single-machine measurements of how Firefox and Chromium differ for the
// things only-connect has tuned: ICE gathering profile and SCTP backpressure.
// Prints JSON. Nothing here changes a default; it exists so that a change, if
// one is ever made, has a recorded measurement behind it.
//
//   node test/measure.mjs            # both browsers
//   BROWSER=firefox node test/measure.mjs
import { chromium, firefox } from 'playwright';
import os from 'node:os';

const wanted = process.env.BROWSER ? [process.env.BROWSER] : ['chromium', 'firefox'];
const profiles = {
  chromium: { mdnsOn: { args: [] }, mdnsOff: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } },
  firefox: {
    mdnsOn: { firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': true } },
    mdnsOff: { firefoxUserPrefs: {
      'media.peerconnection.ice.obfuscate_host_addresses': false,
      'media.peerconnection.ice.default_address_only': false,
    } },
  },
};

// Runs in the page.
async function measure({ rounds, stunUrl, bulkBytes }) {
  const now = () => performance.now();
  const typeOf = (line) => /\btyp (\w+)/.exec(line)?.[1] || 'unknown';
  const mdns = (line) => /\.local /.test(line);

  async function gather(iceServers) {
    const pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel('x');
    const t0 = now();
    const out = { first: null, done: null, types: {}, mdns: 0 };
    pc.onicecandidate = (event) => {
      // Firefox reports end-of-candidates as a candidate with an empty line.
      if (!event.candidate?.candidate) return;
      out.first ??= now() - t0;
      const type = typeOf(event.candidate.candidate);
      out.types[type] = (out.types[type] || 0) + 1;
      if (mdns(event.candidate.candidate)) out.mdns++;
    };
    const complete = new Promise((resolve) => {
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
    });
    await pc.setLocalDescription(await pc.createOffer());
    await Promise.race([complete, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    out.done = pc.iceGatheringState === 'complete' ? now() - t0 : null;
    pc.close();
    return out;
  }

  async function link(iceServers) {
    const a = new RTCPeerConnection({ iceServers });
    const b = new RTCPeerConnection({ iceServers });
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const channel = a.createDataChannel('bulk');
    const remote = new Promise((resolve) => { b.ondatachannel = (e) => resolve(e.channel); });
    const t0 = now();
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no connection in 8 s')), 8000);
      a.onconnectionstatechange = () => { if (a.connectionState === 'connected') { clearTimeout(timer); resolve(); } };
    });
    const far = await remote;
    if (channel.readyState !== 'open') await new Promise((resolve) => { channel.onopen = resolve; });
    return { a, b, channel, remote: far, connectMs: now() - t0 };
  }

  const result = { gather: {}, connect: {}, bulk: null };
  for (const [name, servers] of [['noStun', []], ['stun', [{ urls: stunUrl }]]]) {
    const runs = [];
    for (let i = 0; i < rounds; i++) runs.push(await gather(servers));
    result.gather[name] = runs;
  }
  const connects = [];
  for (let i = 0; i < rounds; i++) {
    try {
      const pair = await link([]);
      connects.push(Math.round(pair.connectMs));
      pair.a.close(); pair.b.close();
    } catch (cause) { connects.push(cause.message); }
  }
  result.connect.noStunMs = connects;
  if (connects.every((value) => typeof value === 'string')) return result;

  // Backpressure: the same loop drop uses — 16 KiB chunks, pause above the
  // high-water mark, resume at the low-water mark. The sweep is measurement
  // only; it does not change any default.
  async function bulk(HIGH, LOW) {
    const CHUNK = 16 * 1024;
    let pair;
    try { pair = await link([]); } catch (cause) { return `link failed: ${cause.message}`; }
    const { channel, remote } = pair;
    channel.bufferedAmountLowThreshold = LOW;
    let received = 0;
    remote.binaryType = 'arraybuffer';
    const done = new Promise((resolve) => {
      remote.onmessage = (e) => { received += e.data.byteLength; if (received >= bulkBytes) resolve(); };
    });
    const chunk = new Uint8Array(CHUNK);
    let maxBuffered = 0;
    let lowEvents = 0;
    let stalls = 0;
    channel.onbufferedamountlow = () => { lowEvents++; };
    const t0 = now();
    try {
      for (let sent = 0; sent < bulkBytes; sent += CHUNK) {
        if (channel.bufferedAmount > HIGH) {
          stalls++;
          await new Promise((resolve) => {
            const check = () => {
              if (channel.bufferedAmount <= LOW) { channel.removeEventListener('bufferedamountlow', check); resolve(); }
            };
            channel.addEventListener('bufferedamountlow', check);
            check();
          });
        }
        channel.send(chunk);
        maxBuffered = Math.max(maxBuffered, channel.bufferedAmount);
      }
      await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error(`stalled at ${received} bytes`)), 60_000))]);
    } catch (cause) { return `bulk failed: ${cause.message}`; }
    const seconds = (now() - t0) / 1000;
    const out = {
      highMiB: HIGH / 1048576, lowMiB: LOW / 1048576,
      mibPerSecond: Number((bulkBytes / 1048576 / seconds).toFixed(1)),
      maxBufferedKiB: Math.round(maxBuffered / 1024),
      highWaterStalls: stalls,
      lowEvents,
      maxMessageSize: pair.a.sctp?.maxMessageSize ?? null,
    };
    pair.a.close(); pair.b.close();
    return out;
  }
  result.bulk = [];
  for (const [high, low] of [[1, 0.25], [4, 1], [16, 4]]) {
    result.bulk.push(await bulk(high * 1048576, low * 1048576));
  }

  // An unreachable STUN server (TEST-NET-3): does gathering still end, and
  // does a connection still form while the STUN query is outstanding?
  const dead = [{ urls: 'stun:203.0.113.1:3478' }];
  result.deadStunGather = await gather(dead);
  try { const pair = await link(dead); result.deadStunConnectMs = Math.round(pair.connectMs); pair.a.close(); pair.b.close(); }
  catch (cause) { result.deadStunConnectMs = cause.message; }
  return result;
}

const summary = (values) => {
  const sorted = values.filter((v) => v != null).sort((x, y) => x - y);
  return sorted.length
    ? { median: Math.round(sorted[sorted.length >> 1]), max: Math.round(sorted.at(-1)), n: sorted.length, missing: values.length - sorted.length }
    : { missing: values.length };
};
const types = (runs) => runs.reduce((all, run) => {
  for (const [k, v] of Object.entries(run.types)) all[k] = Math.max(all[k] || 0, v);
  return all;
}, {});

const report = {
  host: {
    cpu: os.cpus()[0].model, cores: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`, arch: os.arch(),
  },
  browsers: {},
};
for (const name of wanted) {
  const engine = name === 'firefox' ? firefox : chromium;
  for (const [mode, options] of Object.entries(profiles[name])) {
    const browser = await engine.launch(options);
    const page = await browser.newPage();
    await page.goto('about:blank');
    const raw = await page.evaluate(measure, { rounds: 5, stunUrl: 'stun:stun.cloudflare.com:3478', bulkBytes: 64 * 1024 * 1024 });
    report.browsers[`${name} ${browser.version()} / mDNS ${mode === 'mdnsOn' ? 'obfuscation on (default)' : 'obfuscation off'}`] = {
      gatherNoStun: {
        firstCandidateMs: summary(raw.gather.noStun.map((r) => r.first)),
        completeMs: summary(raw.gather.noStun.map((r) => r.done)),
        types: types(raw.gather.noStun),
        mdnsCandidates: Math.max(...raw.gather.noStun.map((r) => r.mdns)),
      },
      gatherStun: {
        firstCandidateMs: summary(raw.gather.stun.map((r) => r.first)),
        completeMs: summary(raw.gather.stun.map((r) => r.done)),
        types: types(raw.gather.stun),
      },
      connectMs: raw.connect.noStunMs,
      bulk: raw.bulk || 'skipped: no connection',
      deadStun: raw.deadStunGather ? { firstCandidateMs: Math.round(raw.deadStunGather.first), completeMs: raw.deadStunGather.done == null ? 'not complete in 15 s' : Math.round(raw.deadStunGather.done), connectMs: raw.deadStunConnectMs } : undefined,
    };
    await browser.close();
  }
}
console.log(JSON.stringify(report, null, 2));
