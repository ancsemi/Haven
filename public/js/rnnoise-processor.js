/**
 * RNNoise AudioWorklet Processor
 * Processes mic audio through RNNoise WASM for real-time noise suppression.
 *
 * RNNoise operates on 480-sample frames (10ms at 48kHz).
 * AudioWorklet's process() delivers 128-sample blocks.
 * We buffer input samples and process whenever we accumulate a full frame.
 *
 * WASM payload (#5458): the main thread posts raw ArrayBuffer bytes
 * (`wasm-bytes`), NOT a WebAssembly.Module. Module objects fail structured
 * clone into AudioWorkletGlobalScope (port fires messageerror, never
 * message), which left this processor permanently in the pass-through
 * branch. Bytes clone/transfer fine; we compile here.
 */
class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ready = false;
    this._destroyed = false;

    // Ring buffers for bridging 128-sample blocks → 480-sample RNNoise frames
    this._inputBuf = new Float32Array(480);
    this._inputPos = 0;   // write cursor into _inputBuf

    // Output FIFO with independent read/write cursors (#5458).
    //
    // The producer is bursty: 480 samples land at once, once every 3.75 render
    // quanta. The consumer takes a steady 128 per quantum. Average rates match,
    // but 480 is not a multiple of 128, so the frame boundary falls mid-quantum
    // and the phase drifts. With zero headroom the drain point periodically
    // overtakes the fill point and the old code emitted `output[i] = 0`.
    // Simulating the previous arithmetic over 4000 quanta: 5.07% of all output
    // samples were digital silence, in 32-sample gaps recurring at roughly
    // 72 Hz. Step discontinuities to zero at that rate are broadband clicks,
    // which is the crackle people reported.
    //
    // Pre-filling _PRIME samples before draining removes the underruns
    // entirely (same simulation: zero). Steady-state occupancy then sits
    // between 448 and 896 samples, so this adds roughly 9-19 ms of latency,
    // plus a one-off ~20 ms of silence when suppression is switched on.
    this._FIFO_CAP = 2880;  // 6 frames, comfortably clear of prime + one frame
    this._PRIME = 960;      // 2 frames of headroom before we start draining
    this._fifo = new Float32Array(this._FIFO_CAP);
    this._fifoRead = 0;
    this._fifoWrite = 0;
    this._fifoCount = 0;
    this._priming = true;

    this.port.onmessage = (e) => {
      const data = e && e.data;
      if (!data || !data.type) return;
      if (data.type === 'wasm-bytes') {
        this._initWasm(data.bytes);
      } else if (data.type === 'wasm-module') {
        // Legacy path (broken on Chromium/Electron: Module does not clone).
        // Kept only so a mixed-version deploy still surfaces an error instead
        // of hanging forever in pass-through.
        this._initWasm(data.module);
      } else if (data.type === 'destroy') {
        this._cleanup();
      }
    };

    // Without this, a failed structured clone is completely silent (#5458).
    this.port.onmessageerror = () => {
      this.port.postMessage({
        type: 'error',
        message: 'messageerror: WASM payload failed structured clone into the worklet'
      });
    };
  }

  async _initWasm(payload) {
    try {
      if (payload == null) throw new Error('empty WASM payload');

      // Accept raw bytes (preferred) or a precompiled Module (legacy).
      let wasmModule = null;
      if (payload instanceof WebAssembly.Module) {
        wasmModule = payload;
      } else {
        let bytes = payload;
        if (ArrayBuffer.isView(payload)) {
          bytes = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        }
        if (!(bytes instanceof ArrayBuffer)) {
          throw new Error('WASM payload is neither ArrayBuffer nor WebAssembly.Module');
        }
        wasmModule = await WebAssembly.compile(bytes);
      }

      // The Jitsi RNNoise WASM exports its own memory ('c') and needs two imports:
      //   a.a = _emscripten_resize_heap (grow memory)
      //   a.b = _emscripten_memcpy_big (fast memcpy via TypedArray.copyWithin)
      let wasmMemory = null;
      let HEAPU8 = null;

      const updateViews = () => {
        HEAPU8 = new Uint8Array(wasmMemory.buffer);
        this._HEAPF32 = new Float32Array(wasmMemory.buffer);
      };

      const instance = await WebAssembly.instantiate(wasmModule, {
        a: {
          a: (requestedSize) => {
            // _emscripten_resize_heap: grow memory
            const oldSize = HEAPU8.length;
            const maxHeapSize = 2147483648;
            requestedSize = requestedSize >>> 0;
            if (requestedSize > maxHeapSize) return false;
            for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
              let overGrown = oldSize * (1 + 0.2 / cutDown);
              overGrown = Math.min(overGrown, requestedSize + 100663296);
              const newSize = Math.min(maxHeapSize,
                (Math.max(requestedSize, overGrown) + 65535) & ~65535);
              try {
                wasmMemory.grow((newSize - wasmMemory.buffer.byteLength + 65535) >>> 16);
                updateViews();
                return true;
              } catch (e) { /* try next */ }
            }
            return false;
          },
          b: (dest, src, num) => {
            // _emscripten_memcpy_big: fast memcpy
            HEAPU8.copyWithin(dest, src, src + num);
          }
        }
      });

      const exports = instance.exports;
      wasmMemory = exports.c; // exported Memory
      updateViews();

      // Call __wasm_call_ctors to initialize (export 'd')
      if (exports.d) exports.d();

      this._malloc = exports.g;
      this._free = exports.i;
      this._rnnoise_create = exports.f;
      this._rnnoise_destroy = exports.h;
      this._rnnoise_process_frame = exports.j;
      this._wasmMemory = wasmMemory;

      // Create denoiser state
      this._state = this._rnnoise_create();

      // Allocate input/output buffers in WASM heap (480 floats = 1920 bytes each)
      this._wasmInputPtr = this._malloc(480 * 4);
      this._wasmOutputPtr = this._malloc(480 * 4);

      this._ready = true;
      this.port.postMessage({ type: 'ready', sampleRate });
    } catch (err) {
      this.port.postMessage({
        type: 'error',
        message: (err && err.message) ? err.message : String(err)
      });
    }
  }

  _cleanup() {
    this._destroyed = true;
    if (this._state) {
      this._rnnoise_destroy(this._state);
      this._state = null;
    }
    if (this._wasmInputPtr) {
      this._free(this._wasmInputPtr);
      this._free(this._wasmOutputPtr);
      this._wasmInputPtr = null;
      this._wasmOutputPtr = null;
    }
    this._ready = false;
  }

  process(inputs, outputs) {
    if (this._destroyed) return false;

    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    // If WASM not ready yet, pass through
    if (!this._ready) {
      output.set(input);
      return true;
    }

    // Feed input samples into the ring buffer, process when we have 480
    for (let i = 0; i < input.length; i++) {
      this._inputBuf[this._inputPos++] = input[i];

      if (this._inputPos === 480) {
        this._processFrame();
        this._inputPos = 0;
      }
    }

    // Hold output until the FIFO has enough headroom to drain without running
    // dry. One ~20 ms gap when suppression is enabled, instead of a 32-sample
    // dropout every ~14 ms for the rest of the session.
    if (this._priming) {
      if (this._fifoCount >= this._PRIME) {
        this._priming = false;
      } else {
        output.fill(0);
        return true;
      }
    }

    // Drain the FIFO.
    for (let i = 0; i < output.length; i++) {
      if (this._fifoCount > 0) {
        output[i] = this._fifo[this._fifoRead];
        this._fifoRead = (this._fifoRead + 1) % this._FIFO_CAP;
        this._fifoCount--;
      } else {
        // Should not happen now, but never emit stale samples if it does.
        output[i] = 0;
        this._priming = true; // rebuild headroom rather than crackle on
      }
    }

    return true;
  }

  _processFrame() {
    // Refresh heap view in case memory grew
    if (this._HEAPF32.buffer !== this._wasmMemory.buffer) {
      this._HEAPF32 = new Float32Array(this._wasmMemory.buffer);
    }

    // RNNoise expects float32 samples scaled to roughly [-32768, 32767]
    const inIdx = this._wasmInputPtr >> 2;
    for (let i = 0; i < 480; i++) {
      this._HEAPF32[inIdx + i] = this._inputBuf[i] * 32768;
    }

    // Process: returns VAD probability (0..1), output written to wasmOutputPtr
    this._rnnoise_process_frame(this._state, this._wasmOutputPtr, this._wasmInputPtr);

    // Read output, scale back to [-1, 1], and append to the FIFO. The old code
    // reset the cursors here and declared 480 samples ready, which threw away
    // any undrained tail of the previous frame. Appending can't do that.
    const outIdx = this._wasmOutputPtr >> 2;
    for (let i = 0; i < 480; i++) {
      if (this._fifoCount >= this._FIFO_CAP) break; // full: drop rather than wrap over unread data
      this._fifo[this._fifoWrite] = this._HEAPF32[outIdx + i] / 32768;
      this._fifoWrite = (this._fifoWrite + 1) % this._FIFO_CAP;
      this._fifoCount++;
    }
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
