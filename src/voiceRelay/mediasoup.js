'use strict';
/**
 * Built-in voice relay (mediasoup).
 *
 * Without a relay every person in a call sends their audio and video straight
 * to every other person, so each upload grows with the size of the call and
 * past about ten people it runs out. With the relay each person sends once,
 * to this server, and the server forwards it to everyone else.
 *
 * mediasoup runs its media work in separate worker processes. Each worker
 * listens on one port (UDP, with TCP on the same number as a fallback for
 * networks that block UDP), so the admin opens `port` up to
 * `port + workers - 1` and nothing else. Calls are spread across workers.
 *
 * mediasoup is installed on demand from Large Server Setup (see ./addon.js).
 * Until it is, the relay reports itself as not installed and calls keep
 * working peer to peer.
 */

const os = require('os');
const { detectPublicIp } = require('./publicIp');
const { loadMediasoup } = require('./addon');

const NOT_INSTALLED = 'The relay is not installed yet. Install it from Large Server Setup.';

// Per-person limits, so one participant cannot eat a worker that every call
// on it shares. A screen share with its two sizes, a camera and a mic fit well
// under the upload cap.
const MAX_INCOMING_BITRATE = 15_000_000;
const MAX_CONSUMERS_PER_PEER = 400;

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 2 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1 } },
];

/** The machine's first private IPv4 address, for people on the same network. */
function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

class MediasoupRelay {
  /**
   * @param {object} opts
   * @param {() => {port:number, workers:number, address:string}} opts.settings
   * @param {(code:string) => void} [opts.onRoomLost] a call's relay went away
   *        (its worker crashed); the people in it need to reconnect.
   */
  constructor({ settings, onRoomLost }) {
    this.settings = settings;
    this.onRoomLost = onRoomLost || (() => {});
    this.workers = [];          // { worker, webRtcServer, rooms: Set<code> }
    this.rooms = new Map();     // code -> { router, slot, peers: Map<peerId, Peer> }
    this.state = 'stopped';     // stopped | starting | running | error | unavailable
    this.error = null;
    this.address = null;        // what clients are told to connect to
    this._starting = null;
  }

  static available() { return !!loadMediasoup(); }

  status() {
    return {
      state: loadMediasoup() ? this.state : 'unavailable',
      error: loadMediasoup() ? this.error : NOT_INSTALLED,
      address: this.address,
      ports: this.workers.map(w => w.port),
      calls: this.rooms.size,
      people: [...this.rooms.values()].reduce((n, r) => n + r.peers.size, 0),
    };
  }

  /** Starts the workers. Safe to call again while starting or running. */
  start() {
    if (!loadMediasoup()) { this.state = 'unavailable'; this.error = NOT_INSTALLED; return Promise.resolve(false); }
    if (this.state === 'running') return Promise.resolve(true);
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start() {
    this.state = 'starting';
    this.error = null;
    const { port, workers, address } = this.settings();
    try {
      const lan = lanAddress();
      let announced = (address || '').trim();
      if (!announced) announced = await detectPublicIp().catch(() => null) || lan;
      if (!announced) throw new Error('Could not work out this server\'s address. Enter it under Voice relay.');
      this.address = announced;
      const listenIp = lan || '0.0.0.0';

      for (let i = 0; i < workers; i++) {
        const worker = await loadMediasoup().createWorker({ logLevel: 'warn' });
        const slot = { worker, webRtcServer: null, port: port + i, rooms: new Set() };
        worker.on('died', (err) => this._workerDied(slot, err));
        const info = (protocol) => ({
          protocol, ip: listenIp, port: slot.port,
          announcedAddress: announced,
          // People on the same network as the server reach it directly.
          exposeInternalIp: !!lan && lan !== announced,
        });
        slot.webRtcServer = await worker.createWebRtcServer({ listenInfos: [info('udp'), info('tcp')] });
        this.workers.push(slot);
      }
      this.state = 'running';
      console.log(`🔊 Voice relay running on ${this.address}, port${workers > 1 ? `s ${port}-${port + workers - 1}` : ` ${port}`} (UDP and TCP)`);
      return true;
    } catch (err) {
      this.error = /EADDRINUSE|address in use/i.test(String(err.message))
        ? `Port ${port} is already in use on this machine. Pick another under Voice relay.`
        : err.message;
      this.state = 'error';
      console.error('Voice relay failed to start:', err.message);
      await this.stop(true);
      this.state = 'error';
      return false;
    }
  }

  /** Stops everything. Every relayed call is dropped. */
  async stop(keepState = false) {
    const codes = [...this.rooms.keys()];
    this.rooms.clear();
    for (const slot of this.workers) {
      try { slot.worker.close(); } catch { /* already gone */ }
    }
    this.workers = [];
    if (!keepState) { this.state = 'stopped'; this.error = null; this.address = null; }
    for (const code of codes) this.onRoomLost(code);
  }

  _workerDied(slot, err) {
    console.error('Voice relay worker stopped unexpectedly:', err?.message || err);
    this.workers = this.workers.filter(w => w !== slot);
    for (const code of slot.rooms) {
      this.rooms.delete(code);
      this.onRoomLost(code);
    }
    if (!this.workers.length) {
      this.state = 'error';
      this.error = 'The relay stopped unexpectedly. It will restart when the next call needs it.';
    }
  }

  // ── Calls ────────────────────────────────────────────

  async _room(code) {
    let room = this.rooms.get(code);
    if (room) return room;
    if (!(await this.start())) throw new Error(this.error || 'Voice relay is not running');
    // The worker carrying the fewest calls takes the new one.
    const slot = [...this.workers].sort((a, b) => a.rooms.size - b.rooms.size)[0];
    const router = await slot.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    room = this.rooms.get(code);   // another join may have won the race
    if (room) { router.close(); return room; }
    room = { router, slot, peers: new Map() };
    slot.rooms.add(code);
    this.rooms.set(code, room);
    return room;
  }

  _peer(code, peerId) {
    const room = this.rooms.get(code);
    const peer = room?.peers.get(peerId);
    if (!peer) throw new Error('Not in this call');
    return { room, peer };
  }

  /** Joins a call: what the browser needs to set up its two connections. */
  async join(code, peerId, userId) {
    const room = await this._room(code);
    if (room.peers.has(peerId)) this.leave(code, peerId);
    // `watching`: sharers whose screen this person has open. Screen video is
    // only sent while it is, which is what keeps big screen shares affordable:
    // the server's upload goes to the people looking, not to the whole call.
    // `byProducer`: one consumer per track, however often it is asked for.
    // `pending`: sources being set up right now, so two at once cannot both win.
    const peer = {
      userId, transports: new Map(), producers: new Map(), consumers: new Map(),
      watching: new Set(), byProducer: new Map(), pending: new Set(),
    };
    room.peers.set(peerId, peer);
    const make = async (direction) => {
      const t = await room.router.createWebRtcTransport({
        webRtcServer: room.slot.webRtcServer,
        enableUdp: true, enableTcp: true, preferUdp: true,
        initialAvailableOutgoingBitrate: 1_000_000,
        appData: { direction },
      });
      peer.transports.set(t.id, t);
      if (direction === 'send') await t.setMaxIncomingBitrate(MAX_INCOMING_BITRATE);
      return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
    };
    const send = await make('send');
    const recv = await make('recv');
    // A second join for the same person while this one was setting up has
    // replaced it: close what this one made instead of leaving it behind.
    if (room.peers.get(peerId) !== peer) {
      for (const t of peer.transports.values()) { try { t.close(); } catch { /* gone */ } }
      throw new Error('Joined again elsewhere');
    }
    return { rtpCapabilities: room.router.rtpCapabilities, send, recv };
  }

  async connect(code, peerId, transportId, dtlsParameters) {
    const { peer } = this._peer(code, peerId);
    const t = peer.transports.get(transportId);
    if (!t) throw new Error('Unknown connection');
    await t.connect({ dtlsParameters });
  }

  /** Starts sending one track (mic, screen, webcam...) into the call. */
  async produce(code, peerId, transportId, kind, rtpParameters, source) {
    const { peer } = this._peer(code, peerId);
    const t = peer.transports.get(transportId);
    if (!t || t.appData.direction !== 'send') throw new Error('Unknown connection');
    // One track per source: a new mic replaces the old one, and a second
    // request for a source still being set up is turned away.
    if (peer.pending.has(source)) throw new Error('Already starting that');
    peer.pending.add(source);
    try {
      for (const [id, p] of peer.producers) {
        if (p.appData.source === source) { p.close(); peer.producers.delete(id); }
      }
      const producer = await t.produce({ kind, rtpParameters, appData: { source, userId: peer.userId } });
      peer.producers.set(producer.id, producer);
      return producer.id;
    } finally {
      peer.pending.delete(source);
    }
  }

  closeProducer(code, peerId, producerId) {
    const { peer } = this._peer(code, peerId);
    const p = peer.producers.get(producerId);
    if (!p) return false;
    p.close();
    peer.producers.delete(producerId);
    return true;
  }

  async setProducerPaused(code, peerId, producerId, paused) {
    const { peer } = this._peer(code, peerId);
    const p = peer.producers.get(producerId);
    if (!p) return;
    if (paused) await p.pause(); else await p.resume();
  }

  /** Everything being sent in the call, except by `peerId` itself. */
  producers(code, peerId) {
    const room = this.rooms.get(code);
    if (!room) return [];
    const out = [];
    for (const [id, peer] of room.peers) {
      if (id === peerId) continue;
      for (const p of peer.producers.values()) {
        out.push({ producerId: p.id, userId: peer.userId, source: p.appData.source, kind: p.kind, paused: p.paused });
      }
    }
    return out;
  }

  /** Starts receiving one track. Arrives paused; resume once it is wired up. */
  async consume(code, peerId, producerId, rtpCapabilities) {
    const { room, peer } = this._peer(code, peerId);
    const describe = (c) => ({
      id: c.id, producerId, kind: c.kind, rtpParameters: c.rtpParameters,
      userId: c.appData.sharerId, source: c.appData.source,
    });
    // The same track asked for again gets the consumer it already has.
    const existing = peer.byProducer.get(producerId);
    if (existing && !existing.closed) return describe(existing);
    if (peer.consumers.size >= MAX_CONSUMERS_PER_PEER) throw new Error('Too many tracks');
    if (!room.router.canConsume({ producerId, rtpCapabilities })) return null;
    const t = [...peer.transports.values()].find(x => x.appData.direction === 'recv');
    if (!t) throw new Error('No receiving connection');
    const owner = [...room.peers.values()].find(p => p.producers.has(producerId));
    const source = owner?.producers.get(producerId)?.appData.source ?? null;
    const consumer = await t.consume({
      producerId, rtpCapabilities, paused: true,
      appData: { source, sharerId: owner?.userId ?? null },
    });
    const again = peer.byProducer.get(producerId);
    if (again && !again.closed) { consumer.close(); return describe(again); }
    peer.consumers.set(consumer.id, consumer);
    peer.byProducer.set(producerId, consumer);
    const forget = () => {
      peer.consumers.delete(consumer.id);
      if (peer.byProducer.get(producerId) === consumer) peer.byProducer.delete(producerId);
    };
    consumer.on('producerclose', forget);
    consumer.on('transportclose', forget);
    return {
      id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters,
      userId: owner?.userId ?? null, source,
    };
  }

  /** Unpauses a received track once the browser is ready for it. */
  async resumeConsumer(code, peerId, consumerId) {
    const { peer } = this._peer(code, peerId);
    const c = peer.consumers.get(consumerId);
    if (!c) return;
    // Screen video waits until its tile is open (setWatching).
    if (c.appData.source === 'screen' && !peer.watching.has(c.appData.sharerId)) return;
    await c.resume();
  }

  /** The person opened (or closed) a sharer's screen: start or stop its video. */
  async setWatching(code, peerId, sharerId, watching) {
    const peer = this.rooms.get(code)?.peers.get(peerId);
    if (!peer) return;
    if (watching) peer.watching.add(sharerId); else peer.watching.delete(sharerId);
    for (const c of peer.consumers.values()) {
      if (c.appData.source !== 'screen' || c.appData.sharerId !== sharerId || c.closed) continue;
      if (watching) await c.resume(); else await c.pause();
    }
  }

  /** Stops a person's tracks from the given sources. Returns their ids. */
  closeSources(code, peerId, sources) {
    const peer = this.rooms.get(code)?.peers.get(peerId);
    if (!peer) return [];
    const closed = [];
    for (const [id, p] of peer.producers) {
      if (!sources.includes(p.appData.source)) continue;
      try { p.close(); } catch { /* gone */ }
      peer.producers.delete(id);
      closed.push(id);
    }
    return closed;
  }

  /** Every relay session: which person, in which call. */
  sessions() {
    const out = [];
    for (const [code, room] of this.rooms) {
      for (const peer of room.peers.values()) out.push({ code, userId: peer.userId });
    }
    return out;
  }

  /** Leaves a call. Returns the ids of the tracks that stopped. */
  leave(code, peerId) {
    const room = this.rooms.get(code);
    const peer = room?.peers.get(peerId);
    if (!peer) return [];
    const closed = [...peer.producers.keys()];
    for (const t of peer.transports.values()) { try { t.close(); } catch { /* gone */ } }
    room.peers.delete(peerId);
    if (!room.peers.size) {
      try { room.router.close(); } catch { /* gone */ }
      room.slot.rooms.delete(code);
      this.rooms.delete(code);
    }
    return closed;
  }

  inCall(code, peerId) {
    return !!this.rooms.get(code)?.peers.has(peerId);
  }
}

module.exports = { MediasoupRelay, MEDIA_CODECS };
