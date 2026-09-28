/**
 * Browser half of the voice relay (see src/voiceRelay on the server).
 *
 * In a relayed call this page sends each of its tracks once, to the server,
 * and receives everyone else's from the server, over two connections (one
 * sending, one receiving) instead of one connection per person.
 *
 * VoiceManager (voice.js) owns everything else: the microphone chain, playing
 * audio, the screen and camera tiles. It hands tracks to this session with
 * publish() and gets other people's tracks back through onTrack. People who
 * cannot use the relay (older apps, bots) are still connected directly by
 * VoiceManager, so a call can mix both.
 *
 * mediasoup-client is loaded on first use from /js/vendor/mediasoup-client.js.
 */
(function () {
  'use strict';

  const REQUEST_TIMEOUT_MS = 12000;
  let loading = null;

  function loadClientLibrary() {
    if (window.mediasoupClient) return Promise.resolve(window.mediasoupClient);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/vendor/mediasoup-client.js?v=3.24.1';
      s.onload = () => window.mediasoupClient ? resolve(window.mediasoupClient) : reject(new Error('Relay library did not load'));
      s.onerror = () => { loading = null; reject(new Error('Relay library could not be downloaded')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  class HavenRelaySession {
    /**
     * @param {object} socket  the app's socket.io connection
     * @param {string} code    voice channel code
     * @param {object} opts
     * @param {RTCIceServer[]} [opts.iceServers]  TURN/STUN, for networks that need them
     * @param {string} [opts.iceTransportPolicy]
     * @param {(t:{userId:number, source:string, track:MediaStreamTrack, producerId:string}) => void} opts.onTrack
     * @param {(t:{userId:number, source:string, producerId:string}) => void} opts.onTrackEnded
     * @param {(reason:string) => void} opts.onLost  the session broke; start a new one
     */
    constructor(socket, code, opts) {
      this.socket = socket;
      this.code = code;
      this.opts = opts;
      this.device = null;
      this.sendTransport = null;
      this.recvTransport = null;
      this.producers = new Map();   // source -> Producer
      this.consumers = new Map();   // producerId -> { consumer, userId, source }
      this.closed = false;
      this._listeners = [];
    }

    _request(event, data) {
      return new Promise((resolve, reject) => {
        if (this.closed) return reject(new Error('Relay session closed'));
        const timer = setTimeout(() => reject(new Error(`${event} timed out`)), REQUEST_TIMEOUT_MS);
        this.socket.emit(event, { code: this.code, ...data }, (res) => {
          clearTimeout(timer);
          if (!res || res.error) reject(new Error(res?.error || `${event} failed`));
          else resolve(res);
        });
      });
    }

    _on(event, fn) {
      const h = (data) => { if (!this.closed && data && data.channelCode === this.code) fn(data); };
      this.socket.on(event, h);
      this._listeners.push([event, h]);
    }

    async start() {
      const { Device } = await loadClientLibrary();
      const joined = await this._request('relay:join', {});
      this.device = new Device();
      await this.device.load({ routerRtpCapabilities: joined.rtpCapabilities });

      const transportOpts = (p) => ({
        id: p.id, iceParameters: p.iceParameters, iceCandidates: p.iceCandidates, dtlsParameters: p.dtlsParameters,
        iceServers: this.opts.iceServers || [],
        iceTransportPolicy: this.opts.iceTransportPolicy || 'all',
      });

      this.sendTransport = this.device.createSendTransport(transportOpts(joined.send));
      this.recvTransport = this.device.createRecvTransport(transportOpts(joined.recv));

      for (const t of [this.sendTransport, this.recvTransport]) {
        t.on('connect', ({ dtlsParameters }, done, fail) => {
          this._request('relay:connect', { transportId: t.id, dtlsParameters }).then(() => done(), fail);
        });
        t.on('connectionstatechange', (state) => {
          if (state === 'failed' && !this.closed) this.opts.onLost?.('connection failed');
        });
      }
      this.sendTransport.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
        this._request('relay:produce', { transportId: this.sendTransport.id, kind, rtpParameters, source: appData.source })
          .then(res => done({ id: res.producerId }), fail);
      });

      this._on('relay:new-producer', (p) => { this._consume(p).catch(err => console.warn('[Relay] Could not receive a track:', err.message)); });
      this._on('relay:producer-closed', (p) => this._dropConsumer(p.producerId));
      this._on('relay:lost', () => this.opts.onLost?.('relay restarted'));

      const { producers } = await this._request('relay:producers', {});
      await Promise.all(producers.map(p => this._consume(p).catch(err => console.warn('[Relay] Could not receive a track:', err.message))));
    }

    async _consume({ producerId }) {
      if (this.closed || this.consumers.has(producerId)) return;
      const { consumer: c } = await this._request('relay:consume', { producerId, rtpCapabilities: this.device.rtpCapabilities });
      if (this.closed) return;
      const consumer = await this.recvTransport.consume({ id: c.id, producerId: c.producerId, kind: c.kind, rtpParameters: c.rtpParameters });
      const entry = { consumer, userId: c.userId, source: c.source };
      this.consumers.set(producerId, entry);
      consumer.on('trackended', () => this._dropConsumer(producerId));
      consumer.on('transportclose', () => this._dropConsumer(producerId));
      this.opts.onTrack?.({ userId: c.userId, source: c.source, track: consumer.track, producerId });
      await this._request('relay:resume', { consumerId: c.id });
    }

    _dropConsumer(producerId) {
      const entry = this.consumers.get(producerId);
      if (!entry) return;
      this.consumers.delete(producerId);
      try { entry.consumer.close(); } catch { /* already closed */ }
      this.opts.onTrackEnded?.({ userId: entry.userId, source: entry.source, producerId });
    }

    /**
     * After a connection blip the socket may have missed announcements:
     * pick up tracks that started, drop the ones that stopped.
     */
    async resync() {
      const { producers } = await this._request('relay:producers', {});
      const live = new Set(producers.map(p => p.producerId));
      for (const producerId of [...this.consumers.keys()]) {
        if (!live.has(producerId)) this._dropConsumer(producerId);
      }
      await Promise.all(producers.map(p => this._consume(p).catch(err => console.warn('[Relay] Could not receive a track:', err.message))));
    }

    /**
     * Sends a track into the call as `source` (mic, screen, screen-audio,
     * webcam). With `simulcast`, a video goes up at full quality and at half
     * size, and the relay gives each viewer the one their connection can
     * take, so one viewer on a weak link does not hold the others back.
     */
    async publish(source, track, { maxBitrate, simulcast = false } = {}) {
      if (!track) return null;
      const existing = this.producers.get(source);
      if (existing && !existing.closed) {
        await existing.replaceTrack({ track });
        return existing;
      }
      const opts = { track, appData: { source }, stopTracks: false };
      if (simulcast && track.kind === 'video') {
        const top = maxBitrate || 2500000;
        opts.encodings = [
          { scaleResolutionDownBy: 2, maxBitrate: Math.max(300000, Math.round(top / 4)) },
          { scaleResolutionDownBy: 1, maxBitrate: top },
        ];
        opts.codecOptions = { videoGoogleStartBitrate: 1000 };
      } else if (maxBitrate) {
        opts.encodings = [{ maxBitrate }];
      }
      if (source === 'mic') opts.codecOptions = { opusStereo: false, opusDtx: true, opusFec: true };
      const producer = await this.sendTransport.produce(opts);
      this.producers.set(source, producer);
      return producer;
    }

    /** Swaps the track behind a source without telling anyone (a new mic). */
    async replace(source, track) {
      const producer = this.producers.get(source);
      if (producer && !producer.closed) await producer.replaceTrack({ track });
    }

    /** Stops sending `source`. */
    async unpublish(source) {
      const producer = this.producers.get(source);
      if (!producer) return;
      this.producers.delete(source);
      const producerId = producer.id;
      try { producer.close(); } catch { /* already closed */ }
      await this._request('relay:close-producer', { producerId, source }).catch(() => {});
    }

    hasPublished(source) {
      const p = this.producers.get(source);
      return !!p && !p.closed;
    }

    /** True while both connections are up (or still coming up). */
    isLive() {
      if (this.closed || !this.sendTransport) return false;
      const ok = (t) => t && !t.closed && t.connectionState !== 'failed' && t.connectionState !== 'closed';
      return ok(this.sendTransport) && ok(this.recvTransport);
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      for (const [event, h] of this._listeners) this.socket.off(event, h);
      this._listeners = [];
      for (const [producerId] of this.consumers) this._dropConsumer(producerId);
      for (const p of this.producers.values()) { try { p.close(); } catch { /* closed */ } }
      this.producers.clear();
      try { this.sendTransport?.close(); } catch { /* closed */ }
      try { this.recvTransport?.close(); } catch { /* closed */ }
    }
  }

  window.HavenRelaySession = HavenRelaySession;
})();
