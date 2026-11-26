// Network harness: forces each condition and asserts the outcome.
// Runs two real browsers pages against a local mock Nostr relay.
//   BROWSER=firefox node test/harness.mjs
import { build } from 'esbuild';
import { chromium, firefox } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockRelay } from './mock-relay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserName = process.env.BROWSER || 'chromium';
const results = [];
const check = (name, value, detail = '') => {
  results.push({ name, value });
  console.log(`${value ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const trystero = await build({
  stdin: { contents: "export { joinRoom } from '@trystero-p2p/nostr';", resolveDir: root, loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'error',
});
const files = {
  '/': ['text/html', '<!doctype html><title>only-connect harness</title>'],
  '/only-connect.js': ['text/javascript', await readFile(path.join(root, 'only-connect.js'))],
  '/trystero.js': ['text/javascript', trystero.outputFiles[0].contents],
};
const server = http.createServer((req, res) => {
  const file = files[new URL(req.url, 'http://x').pathname];
  if (!file) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': file[0], 'Cache-Control': 'no-store' }).end(file[1]);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://localhost:${server.address().port}`;
const relay = await startMockRelay();

const engine = browserName === 'firefox' ? firefox : chromium;
const browser = await engine.launch(browserName === 'chromium'
  ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }
  : { firefoxUserPrefs: {
    'media.peerconnection.ice.obfuscate_host_addresses': false,
    'media.peerconnection.ice.default_address_only': false,
  } });

// The default browser profile, with mDNS host-candidate obfuscation left on.
// Same-LAN pairs depend on resolving each other's .local names, which a
// network that blocks multicast DNS breaks while everything else looks normal.
const defaultBrowser = await engine.launch();

// Joins a room in a fresh page. Returns the page; events accumulate on window.
async function join({ secret, expiresAt, config = {}, protocolVersion, deny = false, blackhole = false, relays, useDefaultBrowser = false }) {
  const context = await (useDefaultBrowser ? defaultBrowser : browser).newContext();
  const page = await context.newPage();
  page.on('pageerror', (cause) => check('no page error', false, cause.message));
  await page.goto(origin);
  const outcome = await page.evaluate(async (args) => {
    if (args.blackhole) {
      // Simulates a path that exists on paper and carries nothing: every remote
      // candidate points at a documentation address nobody answers.
      const rewrite = (text) => text.replace(/(a=candidate:\S+ \d+ \S+ \d+ )\S+( \d+ typ)/g, '$1192.0.2.1$2');
      const setRemote = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function (description, ...rest) {
        return setRemote.call(this, { type: description.type, sdp: rewrite(description.sdp) }, ...rest);
      };
      const addCandidate = RTCPeerConnection.prototype.addIceCandidate;
      RTCPeerConnection.prototype.addIceCandidate = function (candidate, ...rest) {
        return addCandidate.call(this, candidate?.candidate
          ? { ...candidate.toJSON?.() ?? candidate, candidate: rewrite(`a=${candidate.candidate}`).slice(2) }
          : candidate, ...rest);
      };
    }
    const oc = await import('/only-connect.js');
    const library = await import('/trystero.js');
    window.__events = [];
    window.__t0 = performance.now();
    try {
      const conn = await oc.connect({
        library,
        secret: Uint8Array.from(args.secret),
        expiresAt: args.expiresAt,
        appId: 'only-connect-harness',
        topicLabel: 'only-connect-harness/v1/topic',
        sdpLabel: 'only-connect-harness/v1/sdp',
        config: args.config,
        ...(args.protocolVersion ? { protocolVersion: args.protocolVersion } : {}),
        ...(args.deny ? { admit: () => false } : {}),
      });
      window.__conn = conn;
      const record = (type) => conn.on(type, (event) => window.__events.push({
        type, code: event.code, diagnosis: event.detail?.diagnosis, peerId: event.peerId, tier: event.tier,
        data: event.data, at: Math.round(performance.now() - window.__t0),
      }));
      ['peer', 'peer-left', 'tier', 'error', 'message'].forEach(record);
      return { joined: true };
    } catch (error) {
      return { joined: false, code: error.code, message: error.message };
    }
  }, { secret, expiresAt, config: { relays: [relay.url], relayProbeMs: 2000, ...config, ...(relays ? { relays } : {}) },
    protocolVersion, deny, blackhole });
  return { page, context, outcome };
}

const until = async (page, predicate, timeout = 20_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const events = await page.evaluate(() => window.__events);
    const hit = events.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
};
const newInvite = () => ({ secret: [...crypto.getRandomValues(new Uint8Array(16))], expiresAt: Date.now() + 600_000 });

async function pair(configA, configB = configA, extra = {}) {
  const invite = newInvite();
  const a = await join({ ...invite, ...configA, ...extra.a });
  const b = await join({ ...invite, ...configB, ...extra.b });
  return { a, b, close: () => Promise.all([a.context.close(), b.context.close()]) };
}

try {
  // host-only: block srflx and relay → same-LAN behaviour
  {
    const { a, b, close } = await pair({ config: { iceFilter: ['host'], stun: [] } });
    const peerA = await until(a.page, (e) => e.type === 'peer');
    const peerB = await until(b.page, (e) => e.type === 'peer');
    check('host-only: both sides connect', Boolean(peerA && peerB));
    const tier = await until(a.page, (e) => e.type === 'tier' && e.tier === 'direct-host');
    check('host-only: tier reports direct-host', Boolean(tier), `${tier?.at} ms`);
    if (peerA && peerB) {
      await a.page.evaluate(({ id }) => window.__conn.send(id, { hello: 'from a' }), { id: peerA.peerId });
      const message = await until(b.page, (e) => e.type === 'message' && e.data?.hello === 'from a');
      check('host-only: a message crosses the room', Boolean(message));
      await b.page.evaluate(() => {
        window.__conn.onChannel((peerId, channel, label) => {
          channel.onmessage = (event) => { window.__events.push({ type: 'channel', data: `${label}:${event.data}` }); };
        });
      });
      await a.page.evaluate(async ({ id }) => {
        const channel = window.__conn.openChannel(id, 'bulk');
        await new Promise((resolve) => { channel.onopen = resolve; });
        channel.send('payload');
        await window.__conn.drain(channel);
      }, { id: peerA.peerId });
      check('host-only: an app data channel opens and carries data',
        Boolean(await until(b.page, (e) => e.type === 'channel' && e.data === 'bulk:payload')));
      await a.page.evaluate(() => window.__conn.leave());
      const left = await until(b.page, (e) => e.type === 'peer-left');
      const gone = await until(b.page, (e) => e.type === 'error' && e.code === 'PEER_LEFT');
      const down = await until(b.page, (e) => e.type === 'tier' && e.tier === 'disconnected');
      check('peer leaving: PEER_LEFT and tier disconnected', Boolean(left && gone && down));
    }
    await close();
  }

  // srflx-only: block host. Without a NAT there is no reflexive path, so this
  // is the negative control that proves host candidates really are blocked.
  {
    const { a, b, close } = await pair({ config: { iceFilter: ['srflx'], stun: [], connectTimeoutMs: 15_000 } });
    const failure = await until(a.page, (e) => e.type === 'error' && e.code === 'NO_CANDIDATES', 12_000);
    check('srflx-only: host path is blocked and the failure is named', Boolean(failure), `${failure?.at} ms`);
    check('srflx-only: nobody connected', !(await until(b.page, (e) => e.type === 'peer', 500)));
    await close();
  }

  // no candidates: only relay allowed and no TURN configured
  {
    const { a, b, close } = await pair({ config: { iceFilter: ['relay'], stun: [], connectTimeoutMs: 15_000 } });
    const failure = await until(a.page, (e) => e.type === 'error' && e.code === 'NO_CANDIDATES', 12_000);
    check('no candidates: NO_CANDIDATES arrives without a hang', Boolean(failure), `${failure?.at} ms`);
    check('no candidates: promptly, before the connect deadline', Boolean(failure) && failure.at < 10_000);
    await close();
  }

  // no relay
  {
    const { page, context, outcome } = await join({ ...newInvite(), relays: ['ws://127.0.0.1:1'] });
    check('no relay: NO_RELAY_REACHABLE', outcome.joined === false && outcome.code === 'NO_RELAY_REACHABLE', outcome.message);
    await context.close();
  }

  // version mismatch
  {
    const { a, b, close } = await pair({ config: { iceFilter: ['host'], stun: [] } }, undefined, { b: { protocolVersion: 2 } });
    const failureA = await until(a.page, (e) => e.type === 'error' && e.code === 'PROTOCOL_MISMATCH');
    const failureB = await until(b.page, (e) => e.type === 'error' && e.code === 'PROTOCOL_MISMATCH');
    check('version mismatch: both sides refuse by name', Boolean(failureA && failureB));
    check('version mismatch: neither side reports a peer', !(await until(a.page, (e) => e.type === 'peer', 500)));
    await close();
  }

  // room refused by peer policy
  {
    const { a, b, close } = await pair({ config: { iceFilter: ['host'], stun: [] } }, undefined, { a: { deny: true } });
    const refusedA = await until(a.page, (e) => e.type === 'error' && e.code === 'ROOM_REFUSED');
    const refusedB = await until(b.page, (e) => e.type === 'error' && e.code === 'ROOM_REFUSED');
    check('room refused: ROOM_REFUSED on both sides', Boolean(refusedA && refusedB));
    await close();
  }

  // nobody else shows up
  {
    const { page, context } = await join({ ...newInvite(), config: { peerTimeoutMs: 2000, stun: [] } });
    const failure = await until(page, (e) => e.type === 'error' && e.code === 'PEER_NOT_FOUND', 6000);
    check('empty room: PEER_NOT_FOUND after the timeout', Boolean(failure), `${failure?.at} ms`);
    await context.close();
  }

  // candidates exist on both sides, nothing connects
  {
    const { a, b, close } = await pair(
      { config: { iceFilter: ['host'], stun: [], connectTimeoutMs: 4000 }, blackhole: true },
    );
    const failure = await until(a.page, (e) => e.type === 'error' && e.code === 'ICE_FAILED', 20_000);
    check('ICE failure: ICE_FAILED at the deadline, not a hang', Boolean(failure), `${failure?.at} ms`);
    await close();
  }

  // mDNS-obfuscated host candidates (the browser default). Either the pair
  // connects, or the failure is named and says why: never a hang.
  {
    const config = { stun: [], connectTimeoutMs: 6000 };
    const { a, b, close } = await pair({ config, useDefaultBrowser: true });
    const outcome = await Promise.race([
      until(a.page, (e) => e.type === 'peer', 15_000),
      until(a.page, (e) => e.type === 'error' && e.code === 'ICE_FAILED', 15_000),
    ]);
    const events = await a.page.evaluate(() => window.__events);
    const failure = events.find((e) => e.type === 'error');
    check('default profile (mDNS on): connects or fails by name, no hang', Boolean(outcome),
      failure ? `${failure.code} / ${failure.diagnosis}` : 'connected');
    if (failure) {
      check('default profile (mDNS on): a hidden local address is named as such',
        failure.diagnosis === 'HIDDEN_LOCAL_ADDRESS', failure.diagnosis);
    }
    await close();
  }
} finally {
  await defaultBrowser.close();
  await browser.close();
  await relay.close();
  server.close();
}

const failed = results.filter((result) => !result.value);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${browserName})`);
process.exit(failed.length ? 1 : 0);
