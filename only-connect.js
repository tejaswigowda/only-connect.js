// only-connect — shared browser-to-browser room transport.
//
// Boundary test: does this code know what a file, a move or a media track is?
// Then it does not belong here. Everything below is room membership, peer
// discovery, connection establishment, channel lifecycle, the backpressure
// mechanism, relay/ICE configuration, and error reporting.
//
// Layout
//   1. Moved from drop-webCLI unchanged (phase 1): helpers, relay probing,
//      room derivation, backpressure, the tracked RTCPeerConnection, and the
//      candidate diagnosis.
//   2. Added surface (phase 2): error taxonomy, connection tier, configuration
//      as data, protocol version, and connect(), which composes them.

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// 1. Moved from drop-webCLI
// ---------------------------------------------------------------------------

export const HIGH_WATER_MARK = 4 * 1024 * 1024;
export const LOW_WATER_MARK = 1024 * 1024;
export const STALL_MS = 15_000;
export const DEFAULT_RELAYS = Object.freeze([
  'wss://no.str.cr',
  'wss://relay.wavlake.com',
  'wss://nostr.hifish.org',
  'wss://relay.notoshi.win',
  'wss://relay.dwadziesciajeden.pl',
]);
export const DEFAULT_STUN = 'stun:stun.cloudflare.com:3478';

const enc = new TextEncoder();

export const b64u = {
  encode(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  },
};

export function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function concat(first, second) {
  const output = new Uint8Array(first.length + second.length);
  output.set(first);
  output.set(second, first.length);
  return output;
}

// The labels keep each application's rooms cryptographically separate from the
// others, so they are supplied by the caller and never defaulted.
export async function deriveRoom(secret, expiresAt, { topicLabel, sdpLabel }) {
  if (!topicLabel || !sdpLabel) throw new TypeError('deriveRoom needs topicLabel and sdpLabel');
  const expiry = enc.encode(`:${expiresAt}`);
  const topic = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(enc.encode(topicLabel), concat(secret, expiry))));
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const password = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: expiry, info: enc.encode(sdpLabel) },
    key,
    256,
  ));
  return { roomId: hex(topic), password: b64u.encode(password) };
}

export function parseRelayUrls(raw) {
  const urls = String(raw || '').split(/[\n,]/).map((url) => url.trim()).filter(Boolean);
  if (!urls.length) return [];
  if (urls.length > 12) throw new Error('Choose at most 12 relays.');
  return urls.map((value) => {
    const url = new URL(value);
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && localhost)) {
      throw new Error(`${value} must use wss:// (ws:// is allowed only for localhost).`);
    }
    return url.href.replace(/\/$/, '');
  });
}

export async function probeRelays(urls, timeoutMs = 8000) {
  const reachable = await Promise.all(urls.map((url) => new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(url);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.addEventListener('open', () => finish(true), { once: true });
    socket.addEventListener('error', () => finish(false), { once: true });
  })));
  return urls.filter((_, index) => reachable[index]);
}

export function waitForChannelDrain(channel, {
  highWaterMark = HIGH_WATER_MARK,
  lowWaterMark = LOW_WATER_MARK,
  stallMs = STALL_MS,
} = {}) {
  if (channel.bufferedAmount <= highWaterMark) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('The connection stalled while waiting for the peer to receive data.'));
    }, stallMs);
    const cleanup = () => {
      clearTimeout(timeout);
      channel.removeEventListener('bufferedamountlow', low);
      channel.removeEventListener('close', closed);
      channel.removeEventListener('error', closed);
    };
    const low = () => {
      if (channel.bufferedAmount <= lowWaterMark) {
        cleanup();
        resolve();
      }
    };
    const closed = () => {
      cleanup();
      reject(new Error('The transfer connection closed while data was buffered.'));
    };
    channel.addEventListener('bufferedamountlow', low);
    channel.addEventListener('close', closed);
    channel.addEventListener('error', closed);
    if (channel.bufferedAmount <= lowWaterMark) low();
  });
}

const PRIVATE_ADDRESS = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd)/i;

export function candidateSummary(line) {
  const fields = String(line).replace(/^a=/, '').split(' ');
  const type = /\btyp (\w+)/.exec(line)?.[1] || 'unknown';
  const address = fields[4] || '';
  let addressClass;
  if (type === 'relay') addressClass = 'relay';
  else if (address.endsWith('.local')) addressClass = 'mdns';
  else if (PRIVATE_ADDRESS.test(address)) addressClass = 'private';
  else addressClass = 'public';
  return { type, addressClass };
}

export function diagnoseConnection(pc) {
  const local = pc?._localCandidates.map(candidateSummary) || [];
  const remote = [
    ...(pc?.remoteDescription?.sdp.match(/^a=candidate:.*$/gm) || []).map((line) => candidateSummary(line)),
    ...(pc?._remoteCandidates.map(candidateSummary) || []),
  ];
  const host = (items) => items.filter((item) => item.type === 'host');
  const localMdns = host(local).some((item) => item.addressClass === 'mdns');
  const remoteMdns = host(remote).some((item) => item.addressClass === 'mdns');
  const localPrivate = host(local).some((item) => item.addressClass === 'private');
  const remotePrivate = host(remote).some((item) => item.addressClass === 'private');
  if (!local.length || !remote.length) {
    return { code: 'NO_CANDIDATES', text: 'One browser offered no usable connection candidates. A VPN, browser privacy setting, or restrictive network may be blocking WebRTC.' };
  }
  if (localMdns || remoteMdns) {
    return { code: 'HIDDEN_LOCAL_ADDRESS', text: 'One browser hid a same-network address behind an mDNS name. Try another browser, disable the browser’s WebRTC mDNS hiding for this test, or use a cellular network.' };
  }
  if (localPrivate && remotePrivate) {
    return { code: 'NETWORK_ISOLATION', text: 'Both devices offered local-network addresses, but the network did not let them connect. Guest Wi-Fi, client isolation, a VPN, or a device firewall may be keeping them apart. Try cellular or a different network.' };
  }
  return { code: 'NO_DIRECT_PATH', text: 'The browsers could not find a direct network path. Try cellular or another network. No TURN relay is configured, so this version cannot cross every NAT or firewall.' };
}

// Builds the RTCPeerConnection subclass handed to the signalling library, the
// set of live connections, and the observed signalling hosts.
//
//   channelPrefix       data channels whose label starts with this are hidden
//                       from the signalling library and belong to the app
//   onDataChannel       called for every incoming data channel
//   onConnectionChange  called when a connection fails, disconnects or closes
//   iceFilter           phase 2: restrict candidate types (diagnostics/tests)
//   onState             phase 2: called on every connection state change
//   onAttempt           phase 2: called when a remote description is applied
//   onGathered          phase 2: called when ICE gathering completes
export function createTracker({
  channelPrefix = '',
  onDataChannel = () => {},
  onConnectionChange = () => {},
  iceFilter = null,
  onState = null,
  onAttempt = null,
  onGathered = null,
} = {}) {
  const allPCs = new Set();
  const observedSockets = new Set();
  const allowed = iceFilter ? new Set(iceFilter) : null;
  const candidateAllowed = (line) => !allowed || allowed.has(/\btyp (\w+)/.exec(line)?.[1]);

  class TrackedPC extends RTCPeerConnection {
    constructor(config) {
      super(config);
      allPCs.add(this);
      this._localCandidates = [];
      this._remoteCandidates = [];
      this.addEventListener('icecandidate', (event) => {
        const line = event.candidate?.candidate;
        if (line && candidateAllowed(line)) this._localCandidates.push(line);
      });
      this.addEventListener('datachannel', (event) => onDataChannel(this, event.channel));
      this.addEventListener('connectionstatechange', () => {
        if (this.connectionState === 'closed') allPCs.delete(this);
        if (['failed', 'disconnected', 'closed'].includes(this.connectionState)) onConnectionChange(this);
        onState?.(this);
      });
      if (onGathered) {
        this.addEventListener('icegatheringstatechange', () => {
          if (this.iceGatheringState === 'complete') onGathered(this);
        });
      }
    }
    close() {
      allPCs.delete(this);
      return super.close();
    }
    get ondatachannel() { return this.trysteroOnDataChannel || null; }
    set ondatachannel(handler) {
      this.trysteroOnDataChannel = typeof handler === 'function' ? handler : null;
      super.ondatachannel = handler ? (event) => {
        if (!event.channel.label.startsWith(channelPrefix)) handler.call(this, event);
      } : null;
    }
    addIceCandidate(candidate, ...rest) {
      if (candidate?.candidate && !candidateAllowed(candidate.candidate)) return Promise.resolve();
      if (candidate?.candidate) this._remoteCandidates.push(candidate.candidate);
      return super.addIceCandidate(candidate, ...rest);
    }
    async setRemoteDescription(description, ...rest) {
      if (!allowed && !onAttempt) return super.setRemoteDescription(description, ...rest);
      if (allowed && description?.sdp) {
        description = {
          type: description.type,
          sdp: description.sdp.split(/\r?\n/)
            .filter((line) => !line.startsWith('a=candidate:') || candidateAllowed(line))
            .join('\r\n'),
        };
      }
      const result = await super.setRemoteDescription(description, ...rest);
      onAttempt?.(this);
      return result;
    }
  }

  function observeSockets() {
    const NativeWebSocket = globalThis.WebSocket;
    if (!NativeWebSocket || NativeWebSocket.observed) return;
    globalThis.WebSocket = class ObservedWebSocket extends NativeWebSocket {
      static observed = true;
      constructor(url, ...args) {
        try { observedSockets.add(new URL(url).host); } catch {}
        super(url, ...args);
      }
    };
  }

  return { PeerConnection: TrackedPC, allPCs, observedSockets, observeSockets };
}

// ---------------------------------------------------------------------------
// 2. Added surface
// ---------------------------------------------------------------------------

// D1. Every failure is a named code; there is no indefinite "connecting".
export const CODES = Object.freeze({
  NO_RELAY_REACHABLE: 'NO_RELAY_REACHABLE',
  PEER_NOT_FOUND: 'PEER_NOT_FOUND',
  NO_CANDIDATES: 'NO_CANDIDATES',
  ICE_FAILED: 'ICE_FAILED',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  PEER_LEFT: 'PEER_LEFT',
  ROOM_REFUSED: 'ROOM_REFUSED',
});

export class ConnectError extends Error {
  constructor(code, message, { peerId = null, detail = null } = {}) {
    super(message);
    this.name = 'ConnectError';
    this.code = code;
    this.peerId = peerId;
    this.detail = detail;
  }
}

// D2. The degradation ladder as an API.
export const TIERS = Object.freeze({
  DIRECT_HOST: 'direct-host',
  DIRECT_SRFLX: 'direct-srflx',
  RELAYED: 'relayed',
  DISCONNECTED: 'disconnected',
});

export function classifyTier(localType, remoteType) {
  if (localType === 'relay' || remoteType === 'relay') return TIERS.RELAYED;
  const reflexive = (type) => type === 'srflx' || type === 'prflx';
  if (reflexive(localType) || reflexive(remoteType)) return TIERS.DIRECT_SRFLX;
  if (localType === 'host' && remoteType === 'host') return TIERS.DIRECT_HOST;
  return null;
}

// Firefox reports the far end of a same-LAN pair as peer-reflexive, because it
// is learned from the connectivity check. A peer-reflexive candidate on a
// private, link-local or mDNS address is a host path, not a NAT mapping.
function effectiveType(candidate) {
  if (candidate?.candidateType !== 'prflx') return candidate?.candidateType;
  const address = candidate.address || candidate.ip || '';
  return PRIVATE_ADDRESS.test(address) || address.endsWith('.local') || address === '127.0.0.1' || address === '::1'
    ? 'host'
    : 'prflx';
}

// `stats` is an RTCStatsReport (or any Map of id → stat).
export function tierFromStats(stats) {
  let pair = null;
  for (const stat of stats.values()) {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) {
      pair = stats.get(stat.selectedCandidatePairId) || pair;
    }
  }
  if (!pair) {
    for (const stat of stats.values()) {
      if (stat.type === 'candidate-pair' && (stat.selected || (stat.nominated && stat.state === 'succeeded'))) pair = stat;
    }
  }
  if (!pair) return null;
  return classifyTier(
    effectiveType(stats.get(pair.localCandidateId)),
    effectiveType(stats.get(pair.remoteCandidateId)),
  );
}

// D3 + D4. Relay and ICE configuration is data. TURN has a place to go even
// though no TURN server is deployed.
export const DEFAULT_CONFIG = Object.freeze({
  relays: DEFAULT_RELAYS,
  stun: Object.freeze([DEFAULT_STUN]),
  turn: Object.freeze([]),
  iceFilter: null,
  maxPeers: 10,
  relayProbeMs: 8000,
  peerTimeoutMs: 30_000,
  connectTimeoutMs: 20_000,
  handshakeMs: 10_000,
  highWaterMark: HIGH_WATER_MARK,
  lowWaterMark: LOW_WATER_MARK,
  stallMs: STALL_MS,
});

const ICE_TYPES = ['host', 'srflx', 'relay'];

export function resolveConfig(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_CONFIG)) throw new TypeError(`Unknown only-connect option "${key}".`);
  }
  const config = { ...DEFAULT_CONFIG, ...overrides };
  config.relays = Array.isArray(config.relays) ? parseRelayUrls(config.relays.join('\n')) : parseRelayUrls(config.relays);
  if (!config.relays.length) throw new TypeError('At least one relay is required.');
  config.stun = (Array.isArray(config.stun) ? config.stun : [config.stun]).filter(Boolean).map(String);
  for (const url of config.stun) {
    if (!/^stuns?:/i.test(url)) throw new TypeError(`STUN server "${url}" must start with stun: or stuns:.`);
  }
  config.turn = (config.turn || []).map((server) => {
    const urls = [].concat(server?.urls || []);
    if (!urls.length || !urls.every((url) => /^turns?:/i.test(url))) {
      throw new TypeError('Each TURN server needs urls starting with turn: or turns:.');
    }
    if (!server.username || !server.credential) throw new TypeError('Each TURN server needs a username and credential.');
    return { urls, username: String(server.username), credential: String(server.credential) };
  });
  if (config.iceFilter) {
    if (!Array.isArray(config.iceFilter) || !config.iceFilter.length
      || !config.iceFilter.every((type) => ICE_TYPES.includes(type))) {
      throw new TypeError(`iceFilter must be a non-empty list drawn from ${ICE_TYPES.join(', ')}.`);
    }
  }
  return Object.freeze(config);
}

export function buildIceServers(config) {
  return [...config.stun.map((urls) => ({ urls })), ...config.turn];
}

const CONNECTION_FAILURES = new Set([
  CODES.NO_CANDIDATES, CODES.ICE_FAILED, CODES.PROTOCOL_MISMATCH, CODES.ROOM_REFUSED, CODES.PEER_NOT_FOUND,
]);

// connect() joins a room and reports everything that happens to it.
//
//   library      the signalling library module ({ joinRoom }); the caller loads
//                and verifies it, so its provenance stays the app's decision
//   secret       16-byte invite secret
//   expiresAt    invite expiry, ms
//   appId        signalling namespace
//   topicLabel / sdpLabel   room derivation labels (see deriveRoom)
//   config       DEFAULT_CONFIG overrides
//   admit        optional (peerId, hello) => boolean | Promise<boolean>;
//                returning false refuses the peer with ROOM_REFUSED
//   hello        optional JSON-safe object shared with admitted peers
//   protocolVersion  wire version to announce; override only to test mismatches
//
// Rejects with ConnectError(NO_RELAY_REACHABLE) when no relay answers. Every
// later failure arrives as an "error" event carrying a code from CODES.
export async function connect({
  library, secret, expiresAt, appId, topicLabel, sdpLabel,
  config: overrides = {}, admit = null, hello = null,
  protocolVersion = PROTOCOL_VERSION,
}) {
  const config = resolveConfig(overrides);
  const reachable = await probeRelays(config.relays, config.relayProbeMs);
  if (!reachable.length) {
    throw new ConnectError(CODES.NO_RELAY_REACHABLE,
      `None of the ${config.relays.length} configured relays responded within ${config.relayProbeMs} ms.`,
      { detail: { relays: config.relays } });
  }

  const listeners = new Map();
  const on = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => listeners.get(type).delete(handler);
  };
  const emit = (type, event) => {
    for (const handler of listeners.get(type) || []) {
      try { handler(event); } catch (cause) { console.error('only-connect listener failed', cause); }
    }
  };

  const CHANNEL_PREFIX = 'oc:';
  const peers = new Map();
  const channelHandlers = new Set();
  const failed = new WeakSet();
  const timers = new Set();
  let room = null;
  let left = false;
  let peerTimer = null;
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };

  const peerIdFor = (pc) => {
    for (const [peerId, peer] of Object.entries(room?.getPeers() || {})) {
      if (peer.connection === pc) return peerId;
    }
    return null;
  };

  function fail(code, message, extra = {}) {
    if (left) return;
    emit('error', new ConnectError(code, message, extra));
  }

  function setTier(peerId, tier) {
    const peer = peers.get(peerId);
    if (!peer || peer.tier === tier) return;
    peer.tier = tier;
    emit('tier', { peerId, tier });
  }

  async function refreshTier(peerId) {
    const pc = room?.getPeers()?.[peerId]?.connection;
    if (!pc || !peers.has(peerId)) return;
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      setTier(peerId, TIERS.DISCONNECTED);
      return;
    }
    if (pc.connectionState !== 'connected') return;
    try {
      const tier = tierFromStats(await pc.getStats());
      if (tier) setTier(peerId, tier);
    } catch {}
  }

  // One attempt starts when a remote description is applied to a connection.
  // It ends in a connection, or in a code — by failure, by gathering nothing,
  // or by the deadline.
  function judge(pc, { deadline = false } = {}) {
    if (left || failed.has(pc) || !pc._attempt) return;
    if (pc._attempt.connected) return;
    if (pc.connectionState === 'connected') {
      pc._attempt.connected = true;
      clearTimeout(pc._attempt.timer);
      timers.delete(pc._attempt.timer);
      return;
    }
    const gathered = pc.iceGatheringState === 'complete';
    const noLocal = gathered && !pc._localCandidates.length;
    const dead = pc.connectionState === 'failed' || pc.iceConnectionState === 'failed' || deadline;
    if (!noLocal && !dead) return;
    failed.add(pc);
    clearTimeout(pc._attempt.timer);
    timers.delete(pc._attempt.timer);
    const diagnosis = diagnoseConnection(pc);
    const code = diagnosis.code === 'NO_CANDIDATES' ? CODES.NO_CANDIDATES : CODES.ICE_FAILED;
    fail(code, diagnosis.text, {
      peerId: peerIdFor(pc),
      detail: {
        diagnosis: diagnosis.code,
        local: pc._localCandidates.length,
        remote: (pc.remoteDescription?.sdp.match(/^a=candidate:/gm) || []).length + pc._remoteCandidates.length,
      },
    });
    try { pc.close(); } catch {}
  }

  const tracker = createTracker({
    channelPrefix: CHANNEL_PREFIX,
    iceFilter: config.iceFilter,
    onDataChannel(pc, channel) {
      if (!channel.label.startsWith(CHANNEL_PREFIX)) return;
      const peerId = peerIdFor(pc);
      for (const handler of channelHandlers) handler(peerId, channel, channel.label.slice(CHANNEL_PREFIX.length));
    },
    onConnectionChange(pc) {
      judge(pc);
      const peerId = peerIdFor(pc);
      if (peerId) setTier(peerId, TIERS.DISCONNECTED);
    },
    onState(pc) {
      judge(pc);
      if (pc.connectionState === 'connected') {
        const peerId = peerIdFor(pc);
        if (peerId) refreshTier(peerId);
      }
    },
    onAttempt(pc) {
      if (pc._attempt) return;
      pc._attempt = { timer: later(() => judge(pc, { deadline: true }), config.connectTimeoutMs) };
      judge(pc);
    },
    onGathered: (pc) => judge(pc),
  });

  const { roomId, password } = await deriveRoom(secret, expiresAt, { topicLabel, sdpLabel });
  room = library.joinRoom({
    appId,
    password,
    maxUsers: config.maxPeers,
    identity: 'none',
    relayConfig: { urls: reachable, warnOnRelayFailure: false },
    rtcConfig: { iceServers: buildIceServers(config) },
    rtcPolyfill: tracker.PeerConnection,
  }, roomId);

  const control = room.makeAction('oc-ctl');
  const messages = room.makeAction('oc-msg');
  const refuse = (peerId, code, message, detail) => {
    const peer = peers.get(peerId);
    if (peer) peer.state = 'refused';
    fail(code, message, { peerId, detail });
    try { room.getPeers()?.[peerId]?.connection?.close(); } catch {}
  };

  control.onMessage(async (message, { peerId }) => {
    const peer = peers.get(peerId);
    if (!peer || peer.state === 'refused' || !message || typeof message !== 'object') return;
    if (message.type === 'refuse') {
      refuse(peerId, CODES.ROOM_REFUSED, 'The peer declined this connection.', { reason: message.reason ?? null });
      return;
    }
    if (message.type !== 'hello' || peer.state !== 'handshaking') return;
    clearTimeout(peer.handshakeTimer);
    if (message.version !== protocolVersion) {
      refuse(peerId, CODES.PROTOCOL_MISMATCH,
        `The peer speaks wire version ${message.version}; this side speaks ${protocolVersion}.`,
        { local: protocolVersion, remote: message.version });
      return;
    }
    let ok = true;
    try { ok = admit ? await admit(peerId, message.hello ?? null) : true; } catch { ok = false; }
    if (left || peer.state !== 'handshaking') return;
    if (!ok) {
      control.send({ type: 'refuse', reason: 'policy' }, { target: peerId }).catch(() => {});
      refuse(peerId, CODES.ROOM_REFUSED, 'This side declined the peer.', { reason: 'policy' });
      return;
    }
    peer.state = 'ready';
    peer.info = message.hello ?? null;
    clearTimeout(peerTimer);
    emit('peer', { peerId, info: peer.info, tier: peer.tier });
  });

  messages.onMessage((data, { peerId }) => {
    if (peers.get(peerId)?.state === 'ready') emit('message', { peerId, data });
  });

  room.onPeerJoin(({ peerId }) => {
    const peer = { state: 'handshaking', tier: null, info: null, handshakeTimer: null };
    peers.set(peerId, peer);
    peer.handshakeTimer = later(() => {
      if (peer.state === 'handshaking') {
        refuse(peerId, CODES.PROTOCOL_MISMATCH, 'The peer never completed the only-connect handshake.',
          { local: protocolVersion, remote: null });
      }
    }, config.handshakeMs);
    refreshTier(peerId);
    control.send({ type: 'hello', version: protocolVersion, hello }, { target: peerId }).catch(() => {});
  });

  room.onPeerLeave(({ peerId }) => {
    const peer = peers.get(peerId);
    if (!peer) return;
    setTier(peerId, TIERS.DISCONNECTED);
    peers.delete(peerId);
    clearTimeout(peer.handshakeTimer);
    if (peer.state === 'ready') {
      emit('peer-left', { peerId });
      fail(CODES.PEER_LEFT, 'The other side disconnected.', { peerId });
    }
  });

  room.onError((event) => {
    if (event?.code === 'room-full') {
      fail(CODES.ROOM_REFUSED, `The room is full (${config.maxPeers} participants).`, { detail: { reason: 'room-full' } });
    } else if (event?.code === 'peer-connect-failed') {
      const pc = [...tracker.allPCs].find((item) => !failed.has(item)
        && (item.connectionState === 'failed' || item.iceConnectionState === 'failed'));
      if (pc) { pc._attempt ||= { timer: null }; judge(pc, { deadline: true }); }
    }
  });

  const self = await room.getSelf();
  peerTimer = later(() => {
    if (![...peers.values()].some((peer) => peer.state === 'ready')
      && ![...tracker.allPCs].some((pc) => pc._attempt && !failed.has(pc))) {
      fail(CODES.PEER_NOT_FOUND, `Nobody else appeared in the room within ${config.peerTimeoutMs} ms.`);
    }
  }, config.peerTimeoutMs);

  const connection = {
    selfId: self.peerId,
    roomId,
    config,
    protocolVersion,
    relays: reachable,
    get peers() {
      return [...peers].filter(([, peer]) => peer.state === 'ready').map(([peerId, peer]) => ({
        peerId, tier: peer.tier, info: peer.info,
      }));
    },
    get allPeerConnections() { return tracker.allPCs; },
    getTier: (peerId) => peers.get(peerId)?.tier ?? TIERS.DISCONNECTED,
    on,
    // Settles with the first ready peer or the first connection-class failure.
    waitForPeer() {
      const existing = connection.peers[0];
      if (existing) return Promise.resolve(existing.peerId);
      return new Promise((resolve, reject) => {
        const stops = [
          on('peer', ({ peerId }) => { stops.forEach((stop) => stop()); resolve(peerId); }),
          on('error', (error) => {
            if (!CONNECTION_FAILURES.has(error.code)) return;
            stops.forEach((stop) => stop());
            reject(error);
          }),
        ];
      });
    },
    send: (peerId, data) => messages.send(data, peerId ? { target: peerId } : undefined),
    openChannel(peerId, label, init) {
      const pc = room.getPeers()?.[peerId]?.connection;
      if (!pc) throw new ConnectError(CODES.PEER_LEFT, 'That peer is not connected.', { peerId });
      const channel = pc.createDataChannel(`${CHANNEL_PREFIX}${label}`, init);
      channel.bufferedAmountLowThreshold = config.lowWaterMark;
      return channel;
    },
    onChannel(handler) {
      channelHandlers.add(handler);
      return () => channelHandlers.delete(handler);
    },
    drain: (channel) => waitForChannelDrain(channel, config),
    leave() {
      left = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      try { room.leave(); } catch {}
      for (const pc of [...tracker.allPCs]) { try { pc.close(); } catch {} }
      tracker.allPCs.clear();
      peers.clear();
    },
  };
  return connection;
}
