export const MAX_SAMPLE_BYTES = 100 * 1024 * 1024;
const APP_BASE_URL = import.meta.env?.BASE_URL || "/";

export const INSTRUMENT_DEFINITIONS = [
  {
    id: "warm-triangle",
    label: "Warm Triangle",
    group: "Synths",
    engine: "oscillator",
    oscillators: [{ type: "triangle", ratio: 1, gain: 1 }],
    envelope: { attack: 0.015, decay: 0.08, sustain: 0.9, release: 0.12 },
    filter: { frequency: 2600, q: 0.7 },
  },
  {
    id: "bright-saw",
    label: "Bright Saw",
    group: "Synths",
    engine: "oscillator",
    oscillators: [
      { type: "sawtooth", ratio: 1, detune: -5, gain: 0.52 },
      { type: "sawtooth", ratio: 1, detune: 5, gain: 0.52 },
    ],
    envelope: { attack: 0.01, decay: 0.09, sustain: 0.82, release: 0.15 },
    filter: { frequency: 4200, q: 0.9 },
  },
  {
    id: "retro-square",
    label: "Retro Square",
    group: "Synths",
    engine: "oscillator",
    oscillators: [{ type: "square", ratio: 1, gain: 0.72 }],
    envelope: { attack: 0.008, decay: 0.07, sustain: 0.72, release: 0.1 },
    filter: { frequency: 3000, q: 1.2 },
  },
  {
    id: "analog-bass",
    label: "Analog Bass",
    group: "Synths",
    engine: "oscillator",
    notePolicy: "root-octave",
    oscillators: [
      { type: "sawtooth", ratio: 0.5, gain: 0.68 },
      { type: "square", ratio: 0.25, gain: 0.3 },
    ],
    envelope: { attack: 0.008, decay: 0.13, sustain: 0.72, release: 0.16 },
    filter: { frequency: 900, q: 2.4 },
  },
  {
    id: "fm-electric-piano",
    label: "FM Electric Piano",
    group: "Keys",
    engine: "fm",
    envelope: { attack: 0.008, decay: 0.9, sustain: 0.3, release: 0.65 },
    filter: { frequency: 5200, q: 0.6 },
    fm: { carrierType: "sine", ratio: 2, index: 2.35 },
  },
  {
    id: "drawbar-organ",
    label: "Drawbar Organ",
    group: "Keys",
    engine: "oscillator",
    oscillators: [
      { type: "sine", ratio: 0.5, gain: 0.28 },
      { type: "sine", ratio: 1, gain: 0.64 },
      { type: "sine", ratio: 2, gain: 0.28 },
      { type: "sine", ratio: 3, gain: 0.16 },
    ],
    envelope: { attack: 0.025, decay: 0.04, sustain: 0.96, release: 0.22 },
    filter: { frequency: 4800, q: 0.5 },
  },
  {
    id: "airy-pad",
    label: "Airy Pad",
    group: "Synths",
    engine: "oscillator",
    oscillators: [
      { type: "triangle", ratio: 1, detune: -9, gain: 0.38 },
      { type: "sawtooth", ratio: 1, detune: 0, gain: 0.22 },
      { type: "triangle", ratio: 1, detune: 9, gain: 0.38 },
    ],
    envelope: { attack: 0.42, decay: 0.3, sustain: 0.82, release: 1.1 },
    filter: { frequency: 2400, q: 0.8 },
  },
  {
    id: "acoustic-piano",
    label: "Acoustic Piano",
    group: "Sampled",
    engine: "sampler",
    manifestUrl: `${APP_BASE_URL}samples/acoustic-piano/manifest.json`,
    envelope: { attack: 0.004, decay: 1.8, sustain: 0.34, release: 0.8 },
    filter: { frequency: 7200, q: 0.4 },
  },
  {
    id: "string-ensemble",
    label: "String Ensemble",
    group: "Sampled",
    engine: "sampler",
    manifestUrl: `${APP_BASE_URL}samples/string-ensemble/manifest.json`,
    envelope: { attack: 0.28, decay: 0.25, sustain: 0.86, release: 0.9 },
    filter: { frequency: 4800, q: 0.5 },
  },
  {
    id: "marimba",
    label: "Marimba",
    group: "Sampled",
    engine: "sampler",
    manifestUrl: `${APP_BASE_URL}samples/marimba/manifest.json`,
    envelope: { attack: 0.003, decay: 1.15, sustain: 0.05, release: 0.25 },
    filter: { frequency: 6800, q: 0.7 },
  },
  {
    id: "glockenspiel",
    label: "Glockenspiel",
    group: "Sampled",
    engine: "sampler",
    manifestUrl: `${APP_BASE_URL}samples/glockenspiel/manifest.json`,
    envelope: { attack: 0.002, decay: 1.8, sustain: 0.04, release: 0.45 },
    filter: { frequency: 9200, q: 0.4 },
  },
];

export function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToMidi(frequency) {
  return Math.round(69 + 12 * Math.log2(frequency / 440));
}

function sampleKey(instrumentId, sample) {
  return `${instrumentId}:${sample.note}:${sample.velocity}`;
}

export function decodeAudioBuffer(audioContext, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (buffer) => {
      if (settled) return;
      settled = true;
      if (buffer) resolve(buffer);
      else reject(new Error("The browser returned an empty decoded sample"));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error("Unable to decode audio sample"));
    };

    try {
      const result = audioContext.decodeAudioData(arrayBuffer.slice(0), succeed, fail);
      if (result && typeof result.then === "function") result.then(succeed, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export class InstrumentRegistry {
  constructor(definitions = INSTRUMENT_DEFINITIONS) {
    this.definitions = new Map(definitions.map((definition) => [definition.id, definition]));
    this.loaded = new Map();
    this.loading = new Map();
    this.errors = new Map();
  }

  list() {
    return Array.from(this.definitions.values());
  }

  get(id) {
    return this.definitions.get(id) || this.definitions.get("warm-triangle");
  }

  isSampled(id) {
    return this.get(id).engine === "sampler";
  }

  isReady(id) {
    return !this.isSampled(id) || this.loaded.has(id);
  }

  getError(id) {
    return this.errors.get(id) || null;
  }

  getStatus(id) {
    if (!this.isSampled(id) || this.loaded.has(id)) return "ready";
    if (this.loading.has(id)) return "loading";
    if (this.errors.has(id)) return "error";
    return "idle";
  }

  getSampleBank(id) {
    return this.loaded.get(id) || null;
  }

  async load(id, audioContext, onProgress = () => {}) {
    const definition = this.get(id);
    if (definition.engine !== "sampler") return null;
    if (this.loaded.has(id)) return this.loaded.get(id);
    if (this.loading.has(id)) return this.loading.get(id);

    const promise = this.#loadSampleBank(definition, audioContext, onProgress)
      .then((bank) => {
        this.loaded.set(id, bank);
        this.errors.delete(id);
        return bank;
      })
      .catch((error) => {
        this.errors.set(id, error);
        throw error;
      })
      .finally(() => this.loading.delete(id));

    this.loading.set(id, promise);
    return promise;
  }

  async #loadSampleBank(definition, audioContext, onProgress) {
    onProgress({ loaded: 0, total: 1, ratio: 0, phase: "manifest" });
    const manifestResponse = await fetch(definition.manifestUrl);
    if (!manifestResponse.ok) {
      throw new Error(`Unable to load ${definition.label} manifest (${manifestResponse.status})`);
    }

    const manifest = await manifestResponse.json();
    if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
      throw new Error(`${definition.label} has no sample zones`);
    }

    const baseUrl = new URL(definition.manifestUrl, window.location.href);
    const zones = [];
    let loaded = 0;
    let totalBytes = 0;

    for (const sample of manifest.samples) {
      const url = new URL(sample.url, baseUrl).href;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Unable to load sample ${sample.url}`);
      const arrayBuffer = await response.arrayBuffer();
      totalBytes += arrayBuffer.byteLength;
      if (totalBytes > MAX_SAMPLE_BYTES) {
        throw new Error(`${definition.label} exceeds the 100 MiB sample budget`);
      }
      const buffer = await decodeAudioBuffer(audioContext, arrayBuffer);
      zones.push({
        ...sample,
        note: Number(sample.note),
        velocity: Number(sample.velocity ?? 1),
        key: sampleKey(definition.id, sample),
        buffer,
      });
      loaded += 1;
      onProgress({ loaded, total: manifest.samples.length, ratio: loaded / manifest.samples.length, phase: "samples" });
    }

    zones.sort((a, b) => a.note - b.note || a.velocity - b.velocity);
    return { id: definition.id, manifest, zones, totalBytes };
  }

  findZone(instrumentId, midi, velocity = 0.8) {
    const bank = this.getSampleBank(instrumentId);
    if (!bank) return null;
    let best = null;
    let bestScore = Infinity;
    for (const zone of bank.zones) {
      const pitchDistance = Math.abs(zone.note - midi);
      const velocityDistance = Math.abs(zone.velocity - velocity) * 5;
      const score = pitchDistance + velocityDistance;
      if (score < bestScore) {
        best = zone;
        bestScore = score;
      }
    }
    return best;
  }
}
