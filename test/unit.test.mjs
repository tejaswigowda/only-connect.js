import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODES, ConnectError, DEFAULT_CONFIG, HIGH_WATER_MARK, LOW_WATER_MARK, TIERS,
  b64u, buildIceServers, candidateSummary, classifyTier, connect, deriveRoom,
  diagnoseConnection, parseRelayUrls, resolveConfig, tierFromStats, waitForChannelDrain,
} from '../only-connect.js';

const labels = { topicLabel: 'test/v1/topic', sdpLabel: 'test/v1/sdp' };

test('room derivation is keyed by secret, expiry and labels', async () => {
  const secret = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
  const base = await deriveRoom(secret, 1234, labels);
  assert.match(base.roomId, /^[0-9a-f]{64}$/);
  assert.notEqual(base.roomId, (await deriveRoom(Uint8Array.from(secret, (b) => b ^ 1), 1234, labels)).roomId);
  assert.notEqual(base.roomId, (await deriveRoom(secret, 5678, labels)).roomId);
  assert.notEqual(base.password, (await deriveRoom(secret, 5678, labels)).password);
  assert.notEqual(base.roomId, (await deriveRoom(secret, 1234, { ...labels, topicLabel: 'other/v1/topic' })).roomId);
  await assert.rejects(() => deriveRoom(secret, 1234, {}), TypeError);
  assert.deepEqual(b64u.decode(b64u.encode(secret)), secret);
});

test('relay URLs must be wss (ws only on localhost) and are capped', () => {
  assert.deepEqual(parseRelayUrls('wss://a.example/\nws://127.0.0.1:9'), ['wss://a.example', 'ws://127.0.0.1:9']);
  assert.throws(() => parseRelayUrls('ws://a.example'), /wss/);
  assert.throws(() => parseRelayUrls(Array.from({ length: 13 }, (_, i) => `wss://r${i}.example`).join(',')), /at most 12/);
});

test('configuration is data with a documented default and a TURN slot', () => {
  const defaults = resolveConfig();
  assert.equal(defaults.relays.length, 5);
  assert.deepEqual(buildIceServers(defaults), [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  assert.equal(defaults.highWaterMark, HIGH_WATER_MARK);
  assert.equal(defaults.lowWaterMark, LOW_WATER_MARK);

  const custom = resolveConfig({
    relays: ['wss://mine.example'],
    stun: ['stun:stun.example:3478'],
    turn: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }],
  });
  assert.deepEqual(custom.relays, ['wss://mine.example']);
  assert.deepEqual(buildIceServers(custom), [
    { urls: 'stun:stun.example:3478' },
    { urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' },
  ]);
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
});

test('configuration rejects typos and malformed servers instead of ignoring them', () => {
  assert.throws(() => resolveConfig({ relay: ['wss://x.example'] }), /Unknown/);
  assert.throws(() => resolveConfig({ stun: ['turn:x.example'] }), /stun/);
  assert.throws(() => resolveConfig({ turn: [{ urls: 'stun:x.example', username: 'u', credential: 'c' }] }), /turn/);
  assert.throws(() => resolveConfig({ turn: [{ urls: 'turn:x.example' }] }), /credential/);
  assert.throws(() => resolveConfig({ iceFilter: ['host', 'bogus'] }), /iceFilter/);
  assert.throws(() => resolveConfig({ relays: [] }), /relay/);
});

test('the failure taxonomy is exactly the seven named codes', () => {
  assert.deepEqual(Object.keys(CODES).sort(), [
    'ICE_FAILED', 'NO_CANDIDATES', 'NO_RELAY_REACHABLE', 'PEER_LEFT',
    'PEER_NOT_FOUND', 'PROTOCOL_MISMATCH', 'ROOM_REFUSED',
  ]);
  const error = new ConnectError(CODES.ICE_FAILED, 'x', { peerId: 'p' });
  assert.equal(error.code, 'ICE_FAILED');
  assert.equal(error.peerId, 'p');
  assert.ok(error instanceof Error);
});

test('tier is classified from the selected candidate pair', () => {
  assert.equal(classifyTier('host', 'host'), TIERS.DIRECT_HOST);
  assert.equal(classifyTier('srflx', 'host'), TIERS.DIRECT_SRFLX);
  assert.equal(classifyTier('host', 'prflx'), TIERS.DIRECT_SRFLX);
  assert.equal(classifyTier('relay', 'host'), TIERS.RELAYED);
  assert.equal(classifyTier('srflx', 'relay'), TIERS.RELAYED);
  assert.equal(classifyTier(undefined, 'host'), null);

  const stats = new Map([
    ['t', { type: 'transport', selectedCandidatePairId: 'p' }],
    ['p', { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' }],
    ['l', { type: 'local-candidate', candidateType: 'srflx' }],
    ['r', { type: 'remote-candidate', candidateType: 'host' }],
  ]);
  assert.equal(tierFromStats(stats), TIERS.DIRECT_SRFLX);
  const firefox = new Map([
    ['p', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' }],
    ['l', { type: 'local-candidate', candidateType: 'relay' }],
    ['r', { type: 'remote-candidate', candidateType: 'host' }],
  ]);
  assert.equal(tierFromStats(firefox), TIERS.RELAYED);
  assert.equal(tierFromStats(new Map()), null);

  const pair = (remote) => new Map([
    ['p', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' }],
    ['l', { type: 'local-candidate', candidateType: 'host', address: '192.168.0.2' }],
    ['r', { type: 'remote-candidate', candidateType: 'prflx', ...remote }],
  ]);
  assert.equal(tierFromStats(pair({ address: '192.168.0.9' })), TIERS.DIRECT_HOST, 'LAN prflx is a host path');
  assert.equal(tierFromStats(pair({ address: '203.0.113.7' })), TIERS.DIRECT_SRFLX, 'public prflx is a NAT mapping');
});

test('candidate diagnosis names the failure the same way drop did', () => {
  const host = (address) => `a=candidate:1 1 udp 2122260223 ${address} 50000 typ host`;
  const pc = (local, remote) => ({ _localCandidates: local, _remoteCandidates: remote, remoteDescription: null });
  assert.equal(candidateSummary(host('192.168.1.5')).addressClass, 'private');
  assert.equal(candidateSummary(host('abc.local')).addressClass, 'mdns');
  assert.equal(diagnoseConnection(pc([], [host('192.168.1.5')])).code, 'NO_CANDIDATES');
  assert.equal(diagnoseConnection(pc([host('a.local')], [host('192.168.1.5')])).code, 'HIDDEN_LOCAL_ADDRESS');
  assert.equal(diagnoseConnection(pc([host('192.168.1.5')], [host('192.168.1.9')])).code, 'NETWORK_ISOLATION');
  assert.equal(diagnoseConnection(pc([host('8.8.8.8')], [host('1.1.1.1')])).code, 'NO_DIRECT_PATH');
});

function fakeChannel(buffered) {
  const target = new EventTarget();
  target.bufferedAmount = buffered;
  return target;
}

test('backpressure waits for the low-water mark and fails on stall or close', async () => {
  const opts = { highWaterMark: 100, lowWaterMark: 10, stallMs: 50 };
  await waitForChannelDrain(fakeChannel(100), opts);

  const draining = fakeChannel(500);
  const waiting = waitForChannelDrain(draining, opts);
  draining.bufferedAmount = 5;
  draining.dispatchEvent(new Event('bufferedamountlow'));
  await waiting;

  await assert.rejects(() => waitForChannelDrain(fakeChannel(500), opts), /stalled/);

  const closing = fakeChannel(500);
  const closed = waitForChannelDrain(closing, { ...opts, stallMs: 5000 });
  closing.dispatchEvent(new Event('close'));
  await assert.rejects(() => closed, /closed/);
});

test('no reachable relay is a named code, promptly', async () => {
  const started = Date.now();
  await assert.rejects(
    () => connect({
      library: null, secret: new Uint8Array(16), expiresAt: Date.now() + 1000, appId: 't', ...labels,
      config: { relays: ['ws://127.0.0.1:1'], relayProbeMs: 2000 },
    }),
    (error) => error instanceof ConnectError && error.code === CODES.NO_RELAY_REACHABLE,
  );
  assert.ok(Date.now() - started < 2500);
});
