# only-connect

Shared browser-to-browser room transport for the webCLI tools (drop, chess, rtc). It handles room membership, peer discovery, connection establishment, channel lifecycle, backpressure, relay and ICE configuration, and error reporting.

## This does not fix client-isolated networks

Guest Wi-Fi, classroom and institutional networks that isolate clients will still defeat a direct WebRTC connection. **only-connect is the vehicle, not the cure.** It makes that failure *named, observable, testable and fixable in one place*. The fix is a TURN relay, which is a separate deployment decision. The configuration surface for it exists (`config.turn`), so adding one later is a settings change, not a rewrite.

No TURN server is deployed by this project.

## What it knows and does not know

Boundary test: *does this code know what a file, a move or a media track is?* Then it does not belong here. The transport carries opaque bytes and messages. Manifests, accept flows, hash checks, game moves and signed logs belong to the applications above it.

## Use

```js
import { connect, CODES } from 'only-connect';

const room = await connect({
  library,                         // the signalling module ({ joinRoom }); you load and verify it
  secret, expiresAt,               // the invite
  appId: 'my-app',
  topicLabel: 'my-app/v1/topic',   // keeps your rooms separate from other apps' rooms
  sdpLabel: 'my-app/v1/sdp',
  config: { /* see Configuration */ },
});

room.on('peer', ({ peerId, tier }) => {});
room.on('tier', ({ peerId, tier }) => {});   // direct-host | direct-srflx | relayed | disconnected
room.on('error', (error) => error.code);      // always a code from CODES
room.on('message', ({ peerId, data }) => {});

await room.waitForPeer();                     // settles with a peer or a named failure
room.send(peerId, data);
const channel = room.openChannel(peerId, 'bulk');
await room.drain(channel);                    // backpressure: high/low water marks
room.getStatus(peerId);                       // { connection, ice } for diagnostics, or null
room.disconnect(peerId);
room.leave();
```

`observeSockets()` (call it before `connect()`) records the host of every WebSocket the page opens, for apps that show their own egress. drop-webCLI is the first consumer.

`connect()` rejects with `NO_RELAY_REACHABLE` when no relay answers. Every later failure is an `error` event.

## Upstream tools

`only-connect` is the extracted peer-transport layer used by the webCLI tools:

| tool | uses the transport for |
| --- | --- |
| [drop-webCLI](https://github.com/tejaswigowda/drop-webCLI) | room membership and verified browser-to-browser file transfer |
| [rtc-webCLI](https://github.com/tejaswigowda/rtc-webCLI) | room membership for direct audio, video and screen sharing |
| [chess-webCLI](https://github.com/tejaswigowda/chess-webCLI) | room membership while keeping the signed game and move protocol application-owned |

## Failure codes

There is no indefinite "connecting" state. Every path ends in a connection or one of these.

| code | meaning |
| --- | --- |
| `NO_RELAY_REACHABLE` | no signalling relay responded |
| `PEER_NOT_FOUND` | joined the room, nobody else appeared within `peerTimeoutMs` |
| `NO_CANDIDATES` | ICE gathering produced nothing usable |
| `ICE_FAILED` | candidates gathered, no pair connected |
| `PROTOCOL_MISMATCH` | peer's wire version differs, or the peer never completed the handshake |
| `PEER_LEFT` | the other side disconnected |
| `ROOM_REFUSED` | peer policy (`admit`) declined the join, or the room is full |

Each error carries `code`, `message`, `peerId` and a `detail` object.

## Connection tier

`direct-host` (same network), `direct-srflx` (across NATs via STUN), `relayed` (through TURN), `disconnected`. Read it with `room.getTier(peerId)` or the `tier` event. A peer-reflexive candidate on a private or mDNS address is counted as host, because that is what Firefox reports for a plain LAN pair.

## Configuration

Relays, STUN and TURN are data, with these defaults:

```js
{
  relays: [/* five public Nostr relays */],
  stun: ['stun:stun.cloudflare.com:3478'],
  turn: [],                        // [{ urls: 'turn:…', username, credential }]
  maxPeers: 10,
  relayProbeMs: 8000,
  peerTimeoutMs: 30000,
  connectTimeoutMs: 20000,
  handshakeMs: 10000,
  highWaterMark: 4 * 1024 * 1024,
  lowWaterMark: 1024 * 1024,
  stallMs: 15000,
  iceFilter: null,                 // diagnostics: allow only ['host'] / ['srflx'] / ['relay']
}
```

Unknown keys, non-`wss://` relays (except localhost), and malformed STUN/TURN entries throw rather than being ignored.

## Protocol version

Peers exchange a wire version on join. A mismatch is refused on both sides with `PROTOCOL_MISMATCH`. The current version is `PROTOCOL_VERSION`.

## Tests

```
npm install
npm test            # unit tests, then the network harness (Chromium)
BROWSER=firefox npm run test:harness
```

The harness runs real browser pages against a local mock relay and forces each condition:

| forced condition | asserted outcome |
| --- | --- |
| host-only (`iceFilter: ['host']`) | connects, tier `direct-host`, message and data channel work, `PEER_LEFT` on leave |
| srflx-only (`iceFilter: ['srflx']`) | host path is blocked; `NO_CANDIDATES`, promptly |
| no candidates (`iceFilter: ['relay']`, no TURN) | `NO_CANDIDATES`, promptly |
| no relay | `NO_RELAY_REACHABLE` |
| version mismatch | `PROTOCOL_MISMATCH` on both sides |
| peer policy refusal | `ROOM_REFUSED` on both sides |
| empty room | `PEER_NOT_FOUND` |
| remote candidates that carry nothing | `ICE_FAILED` at the deadline |

Limit: a single machine has no NAT, so the harness cannot show a successful `direct-srflx` or `relayed` connection. The srflx-only case is a negative control: it proves host candidates really are blocked. Those two tiers need a NAT and a TURN server to exercise end to end.

## Distribution

Apps vendor `only-connect` under a hash-bearing filename and map it in their import map. The import map is the lock file.

```
node scripts/vendor.mjs path/to/app/lib   # writes only-connect.<hash>.js, prints the import-map entry
```

The default app integration is local and reproducible:

```html
<script type="importmap">
{
  "imports": {
    "only-connect": "./lib/only-connect.<sha>.js"
  }
}
</script>
<script type="module">
  import { connect } from 'only-connect';
</script>
```

For a CDN-backed demo or separate release, pin the repository commit and use the full file path:

```html
<script type="module">
  import { connect } from
    'https://cdn.jsdelivr.net/gh/tejaswigowda/only-connect.js@<commit-sha>/only-connect.js';
</script>
```

Replace `<commit-sha>` with an immutable commit, not `main`, a branch name or a SemVer/floating tag. Keep the package unchanged from that commit and, when the browser delivery mechanism supports it, verify the CDN response with the matching SHA-256 SRI hash. A CDN is a distribution channel for others, not a runtime dependency of locally vendored apps.

## Out of scope

The signed hash chain (it stays in chess), deploying TURN, Strata play and any multiplayer log, drop's own resume, peer-policy and manifest features, and any choice of relay or Nostr specifics: those are configuration.

## License

GPL-3.0-only, as the code it was extracted from.