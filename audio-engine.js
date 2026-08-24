import { InstrumentRegistry, midiToFrequency } from "./instruments.js";

const MAX_VOICES = 64;
const MIN_GAIN = 0.0001;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function expressionToFilter(value) {
  const tilt = clamp(Number(value) || 0, -1, 1);
  if (tilt < 0) {
    const intensity = Math.abs(tilt);
    return { frequency: 1200 - intensity * 950, q: 0.7 + intensity * 1.5 };
  }
  return { frequency: 1200 + tilt * 3800, q: 0.7 + tilt * 4.5 };
}

function holdParameter(param, time) {
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(time);
  } else {
    param.cancelScheduledValues(time);
    param.setValueAtTime(Math.max(MIN_GAIN, param.value), time);
  }
}

function connectMasterGraph(context, destination = context.destination) {
  const liveBus = context.createGain();
  const loopBus = context.createGain();
  const compressor = context.createDynamicsCompressor();
  const masterGain = context.createGain();
  const analyser = context.createAnalyser();

  liveBus.gain.value = 0.72;
  loopBus.gain.value = 0.72;
  compressor.threshold.value = -7;
  compressor.knee.value = 5;
  compressor.ratio.value = 18;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.16;
  masterGain.gain.value = 0.9;
  analyser.fftSize = 256;

  liveBus.connect(compressor);
  loopBus.connect(compressor);
  compressor.connect(masterGain);
  masterGain.connect(analyser);
  analyser.connect(destination);

  return { liveBus, loopBus, compressor, masterGain, analyser };
}

function createExpressionBus(context, destination) {
  const input = context.createGain();
  const filter = context.createBiquadFilter();
  const expressionGain = context.createGain();
  const trackGain = context.createGain();

  filter.type = "lowpass";
  filter.frequency.value = 1200;
  filter.Q.value = 0.7;
  expressionGain.gain.value = 0;
  trackGain.gain.value = 1;

  input.connect(filter);
  filter.connect(expressionGain);
  expressionGain.connect(trackGain);
  trackGain.connect(destination);
  return { input, filter, expressionGain, trackGain };
}

function normalizeNotes(notes, definition) {
  const normalized = Array.from(new Set(notes.map((note) => Math.round(note)))).sort((a, b) => a - b);
  if (definition.notePolicy === "root-octave" && normalized.length) {
    return [normalized[0], normalized[0] + 12];
  }
  return normalized;
}

function scheduleEnvelope(amp, envelope, when, velocity, normalization) {
  const peak = clamp(velocity, 0.02, 1) * normalization;
  const sustain = Math.max(MIN_GAIN, peak * envelope.sustain);
  amp.gain.cancelScheduledValues(when);
  amp.gain.setValueAtTime(MIN_GAIN, when);
  amp.gain.linearRampToValueAtTime(peak, when + envelope.attack);
  amp.gain.setTargetAtTime(sustain, when + envelope.attack, Math.max(0.01, envelope.decay / 3));
}

function releaseEnvelope(handle, when) {
  if (handle.released && when >= handle.releaseAt) return;
  handle.released = true;
  handle.releaseAt = when;
  const release = handle.release;
  for (const amp of handle.amps) {
    holdParameter(amp.gain, when);
    amp.gain.exponentialRampToValueAtTime(MIN_GAIN, when + release);
  }
  const stopAt = when + release + 0.05;
  for (const source of handle.sources) {
    try {
      source.stop(stopAt);
    } catch {}
  }
  handle.stopAt = stopAt;
}

function makeVoiceHandle(instrumentId, release, createdAt) {
  return {
    instrumentId,
    release,
    createdAt,
    released: false,
    sources: [],
    amps: [],
    nodes: [],
    voiceUnits: 0,
    releaseAt: Infinity,
    stopAt: Infinity,
  };
}

function attachCleanup(handle, onEnded) {
  let remaining = handle.sources.length;
  if (!remaining) return;
  for (const source of handle.sources) {
    source.addEventListener("ended", () => {
      remaining -= 1;
      if (remaining > 0) return;
      for (const node of handle.nodes) {
        try { node.disconnect(); } catch {}
      }
      onEnded(handle);
    }, { once: true });
  }
}

function createOscillatorNote(context, definition, midi, velocity, destination, when, normalization, handle) {
  const frequency = midiToFrequency(midi);
  const amp = context.createGain();
  amp.connect(destination);
  handle.amps.push(amp);
  handle.nodes.push(amp);
  scheduleEnvelope(amp, definition.envelope, when, velocity, normalization);

  for (const layer of definition.oscillators) {
    const oscillator = context.createOscillator();
    const layerGain = context.createGain();
    oscillator.type = layer.type;
    oscillator.frequency.setValueAtTime(frequency * (layer.ratio || 1), when);
    oscillator.detune.setValueAtTime(layer.detune || 0, when);
    layerGain.gain.value = layer.gain ?? 1;
    oscillator.connect(layerGain);
    layerGain.connect(amp);
    oscillator.start(when);
    handle.sources.push(oscillator);
    handle.nodes.push(oscillator, layerGain);
  }
}

function createFmNote(context, definition, midi, velocity, destination, when, normalization, handle) {
  const frequency = midiToFrequency(midi);
  const amp = context.createGain();
  const carrier = context.createOscillator();
  const modulator = context.createOscillator();
  const modulationGain = context.createGain();

  amp.connect(destination);
  carrier.type = definition.fm.carrierType || "sine";
  carrier.frequency.setValueAtTime(frequency, when);
  modulator.type = "sine";
  modulator.frequency.setValueAtTime(frequency * definition.fm.ratio, when);
  modulationGain.gain.setValueAtTime(frequency * definition.fm.index, when);
  modulationGain.gain.exponentialRampToValueAtTime(Math.max(1, frequency * 0.05), when + 1.2);
  modulator.connect(modulationGain);
  modulationGain.connect(carrier.frequency);
  carrier.connect(amp);
  carrier.start(when);
  modulator.start(when);

  handle.amps.push(amp);
  handle.sources.push(carrier, modulator);
  handle.nodes.push(amp, carrier, modulator, modulationGain);
  scheduleEnvelope(amp, definition.envelope, when, velocity, normalization);
}

function createSampleNote(context, registry, definition, midi, velocity, destination, when, normalization, handle) {
  const zone = registry.findZone(definition.id, midi, velocity);
  if (!zone) return false;
  const source = context.createBufferSource();
  const amp = context.createGain();
  source.buffer = zone.buffer;
  source.playbackRate.setValueAtTime(Math.pow(2, (midi - zone.note) / 12), when);
  if (zone.loopStart != null && zone.loopEnd != null) {
    source.loop = true;
    source.loopStart = Number(zone.loopStart);
    source.loopEnd = Number(zone.loopEnd);
  }
  source.connect(amp);
  amp.connect(destination);
  source.start(when, Math.max(0, Number(zone.offset) || 0));
  handle.sources.push(source);
  handle.amps.push(amp);
  handle.nodes.push(source, amp);
  scheduleEnvelope(amp, definition.envelope, when, velocity, normalization);
  return true;
}

export class AudioEngine {
  constructor(registry = new InstrumentRegistry(), options = {}) {
    this.registry = registry;
    this.context = options.context || null;
    this.destination = options.destination || null;
    this.graph = null;
    this.liveExpression = null;
    this.trackBuses = new Map();
    this.voices = new Set();
    this.liveHandle = null;
    this.liveKey = "";
    this.meterData = null;
    this.offline = Boolean(options.offline);
    if (this.context) this.#buildGraph();
  }

  ensureContext() {
    if (!this.context) {
      this.context = new (window.AudioContext || window.webkitAudioContext)();
      this.#buildGraph();
    }
    if (this.context.state === "suspended" && !this.offline) this.context.resume();
    return this.context;
  }

  #buildGraph() {
    this.graph = connectMasterGraph(this.context, this.destination || this.context.destination);
    this.liveExpression = createExpressionBus(this.context, this.graph.liveBus);
    this.meterData = new Float32Array(this.graph.analyser.fftSize);
  }

  get currentTime() {
    return this.context?.currentTime || 0;
  }

  async prepareInstrument(id, onProgress) {
    const context = this.ensureContext();
    return this.registry.load(id, context, onProgress);
  }

  #registerVoice(handle) {
    this.voices.add(handle);
    attachCleanup(handle, (voice) => this.voices.delete(voice));
    const voiceCount = () => Array.from(this.voices)
      .reduce((total, voice) => total + Math.max(1, voice.voiceUnits || 1), 0);
    while (voiceCount() > MAX_VOICES) {
      const oldest = Array.from(this.voices).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      releaseEnvelope(oldest, this.currentTime);
      this.voices.delete(oldest);
    }
  }

  noteOn({ midiNotes, instrumentId, velocity = 0.8, destination, when = this.currentTime }) {
    this.ensureContext();
    const definition = this.registry.get(instrumentId);
    if (definition.engine === "sampler" && !this.registry.isReady(instrumentId)) return null;
    const notes = normalizeNotes(midiNotes, definition);
    if (!notes.length) return null;

    const handle = makeVoiceHandle(definition.id, definition.envelope.release, when);
    handle.voiceUnits = notes.length;
    const target = destination || this.liveExpression.input;
    const normalization = Math.min(0.72, 1 / Math.sqrt(notes.length));
    for (const midi of notes) {
      if (definition.engine === "fm") {
        createFmNote(this.context, definition, midi, velocity, target, when, normalization, handle);
      } else if (definition.engine === "sampler") {
        createSampleNote(this.context, this.registry, definition, midi, velocity, target, when, normalization, handle);
      } else {
        createOscillatorNote(this.context, definition, midi, velocity, target, when, normalization, handle);
      }
    }
    if (!handle.sources.length) return null;
    this.#registerVoice(handle);
    return handle;
  }

  noteOff(handle, when = this.currentTime) {
    if (handle) releaseEnvelope(handle, Math.max(when, this.currentTime));
  }

  setExpression(bus, volume, filterValue, when = this.currentTime, smooth = true) {
    if (!bus || !this.context) return;
    const safeWhen = Math.max(this.currentTime, when);
    const targetVolume = clamp(volume);
    const filter = expressionToFilter(filterValue);
    if (smooth) {
      bus.expressionGain.gain.setTargetAtTime(targetVolume, safeWhen, 0.025);
      bus.filter.frequency.setTargetAtTime(filter.frequency, safeWhen, 0.04);
      bus.filter.Q.setTargetAtTime(filter.q, safeWhen, 0.04);
    } else {
      bus.expressionGain.gain.setValueAtTime(targetVolume, safeWhen);
      bus.filter.frequency.setValueAtTime(filter.frequency, safeWhen);
      bus.filter.Q.setValueAtTime(filter.q, safeWhen);
    }
  }

  updateLive(state) {
    this.ensureContext();
    this.setExpression(this.liveExpression, state.volume || 0, state.filter || 0);
    const notes = state.gate ? state.midiNotes || [] : [];
    const key = state.gate ? `${state.instrumentId}:${notes.join(",")}` : "";
    if (key === this.liveKey) return;

    if (this.liveHandle) this.noteOff(this.liveHandle, this.currentTime);
    this.liveHandle = null;
    this.liveKey = key;
    if (key) {
      this.liveHandle = this.noteOn({
        midiNotes: notes,
        instrumentId: state.instrumentId,
        velocity: Math.max(0.15, state.volume || 0.7),
      });
    }
  }

  stopLive() {
    if (this.liveHandle) this.noteOff(this.liveHandle, this.currentTime);
    this.liveHandle = null;
    this.liveKey = "";
    if (this.liveExpression) this.setExpression(this.liveExpression, 0, 0);
  }

  ensureTrackBus(trackId) {
    if (!this.trackBuses.has(trackId)) {
      this.trackBuses.set(trackId, createExpressionBus(this.context, this.graph.loopBus));
    }
    return this.trackBuses.get(trackId);
  }

  syncTracks(tracks) {
    if (!this.context) return;
    const anySolo = tracks.some((track) => track.solo);
    for (const track of tracks) {
      const bus = this.ensureTrackBus(track.id);
      const audible = !track.muted && (!anySolo || track.solo);
      bus.trackGain.gain.setTargetAtTime(audible ? clamp(track.gain ?? 1) : 0, this.currentTime, 0.02);
    }
  }

  scheduleEvent(event, track, when, ticksToSeconds) {
    const bus = this.ensureTrackBus(track.id);
    const duration = Math.max(0.02, ticksToSeconds(event.durationTicks));
    const handle = this.noteOn({
      midiNotes: event.midiNotes,
      instrumentId: track.instrumentId,
      velocity: event.velocity ?? 0.8,
      destination: bus.input,
      when,
    });
    if (!handle) return null;

    const automation = event.automation?.length
      ? event.automation
      : [{ offsetTicks: 0, volume: event.velocity ?? 0.8, filter: 0 }];
    for (const point of automation) {
      const pointTime = when + ticksToSeconds(point.offsetTicks || 0);
      this.setExpression(bus, point.volume, point.filter, pointTime, false);
    }
    this.noteOff(handle, when + duration);
    return handle;
  }

  stopScheduledVoices() {
    const now = this.currentTime;
    for (const voice of Array.from(this.voices)) {
      if (voice !== this.liveHandle) this.noteOff(voice, now);
    }
  }

  scheduleMetronome(when, accent = false) {
    if (!this.context) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(accent ? 1320 : 880, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.18 : 0.1, when + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
    oscillator.connect(gain);
    gain.connect(this.graph.masterGain);
    oscillator.start(when);
    oscillator.stop(when + 0.06);
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      gain.disconnect();
    }, { once: true });
  }

  getMasterLevel() {
    if (!this.graph || this.offline) return 0;
    this.graph.analyser.getFloatTimeDomainData(this.meterData);
    let sum = 0;
    for (const sample of this.meterData) sum += sample * sample;
    return clamp(Math.sqrt(sum / this.meterData.length) * 2.4);
  }

  async renderProject(project, onProgress = () => {}) {
    const loopSeconds = ticksToSeconds(project.loopTicks, project.bpm);
    if (!loopSeconds || !project.tracks.length) throw new Error("There is no loop to export");

    for (let index = 0; index < project.tracks.length; index += 1) {
      const track = project.tracks[index];
      if (this.registry.isSampled(track.instrumentId)) {
        await this.prepareInstrument(track.instrumentId, (progress) => {
          onProgress({ phase: "samples", track: index, ...progress });
        });
      }
    }

    const sampleRate = 44100;
    const loopFrames = Math.ceil(loopSeconds * sampleRate);
    const offlineContext = new OfflineAudioContext(2, loopFrames * 2, sampleRate);
    const renderer = new AudioEngine(this.registry, { context: offlineContext, offline: true });
    renderer.syncTracks(project.tracks);
    const convert = (ticks) => ticksToSeconds(ticks, project.bpm);
    const anySolo = project.tracks.some((track) => track.solo);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const cycleStart = cycle * loopSeconds;
      for (const track of project.tracks) {
        if (track.muted || (anySolo && !track.solo)) continue;
        for (const event of track.events) {
          renderer.scheduleEvent(event, track, cycleStart + convert(event.startTick), convert);
        }
      }
      onProgress({ phase: "schedule", ratio: (cycle + 1) / 2 });
    }

    const rendered = await offlineContext.startRendering();
    onProgress({ phase: "encode", ratio: 1 });
    return encodeWav(rendered, loopFrames, loopFrames);
  }
}

export function ticksToSeconds(ticks, bpm) {
  return (ticks / 96) * (60 / bpm);
}

export function secondsToTicks(seconds, bpm) {
  return (seconds * bpm / 60) * 96;
}

export function encodeWav(audioBuffer, startFrame = 0, frameCount = audioBuffer.length - startFrame) {
  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const length = Math.max(0, Math.min(frameCount, audioBuffer.length - startFrame));
  let peak = 0;
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = startFrame; index < startFrame + length; index += 1) {
      peak = Math.max(peak, Math.abs(data[index]));
    }
  }
  const scale = peak > 0.98 ? 0.98 / peak : 1;
  const bytes = new ArrayBuffer(44 + length * channels * 2);
  const view = new DataView(bytes);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + length * channels * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, length * channels * 2, true);

  let offset = 44;
  for (let frame = 0; frame < length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = clamp(audioBuffer.getChannelData(channel)[startFrame + frame] * scale, -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}

