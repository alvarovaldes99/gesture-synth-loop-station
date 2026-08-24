import { secondsToTicks, ticksToSeconds } from "./audio-engine.js";

export const PPQ = 96;
export const MAX_TRACKS = 8;
export const MAX_FIRST_LOOP_BARS = 16;
export const LOOP_STATES = Object.freeze({
  IDLE: "idle",
  COUNT_IN: "countIn",
  RECORDING_FIRST: "recordingFirst",
  PLAYING: "playing",
  RECORDING_TRACK: "recordingTrack",
  STOPPED: "stopped",
});

export const METERS = Object.freeze({
  "3/4": { numerator: 3, denominator: 4 },
  "4/4": { numerator: 4, denominator: 4 },
  "6/8": { numerator: 6, denominator: 8 },
});

export const QUANTIZATION = Object.freeze({
  off: 0,
  "1/4": PPQ,
  "1/8": PPQ / 2,
  "1/16": PPQ / 4,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function uid(prefix = "id") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ticksPerBeat(meterName) {
  const meter = METERS[meterName] || METERS["4/4"];
  return PPQ * (4 / meter.denominator);
}

export function ticksPerBar(meterName) {
  const meter = METERS[meterName] || METERS["4/4"];
  return ticksPerBeat(meterName) * meter.numerator;
}

export function quantizeTick(tick, quantization) {
  const grid = QUANTIZATION[quantization] ?? QUANTIZATION["1/8"];
  if (!grid) return Math.max(0, Math.round(tick));
  return Math.max(0, Math.round(tick / grid) * grid);
}

export function createEmptyProject() {
  return {
    version: 1,
    bpm: 120,
    meter: "4/4",
    quantization: "1/8",
    metronome: true,
    recordBars: 4,
    loopTicks: 0,
    tracks: [],
    updatedAt: Date.now(),
  };
}

export function normalizeRecordedEvent(rawEvent, project, keepCrossingBoundary = true) {
  const grid = QUANTIZATION[project.quantization] || 1;
  const loopTicks = Math.max(1, project.loopTicks);
  let startTick = quantizeTick(rawEvent.startTick, project.quantization);
  let endTick = quantizeTick(rawEvent.startTick + rawEvent.durationTicks, project.quantization);
  const minimum = project.quantization === "off" ? 1 : grid;
  if (endTick <= startTick) endTick = startTick + minimum;

  if (startTick >= loopTicks) startTick %= loopTicks;
  let durationTicks = Math.max(minimum, endTick - quantizeTick(rawEvent.startTick, project.quantization));
  durationTicks = Math.min(durationTicks, loopTicks);
  if (!keepCrossingBoundary && startTick + durationTicks > loopTicks) {
    durationTicks = Math.max(minimum, loopTicks - startTick);
  }

  const automation = (rawEvent.automation || []).map((point) => ({
    offsetTicks: clamp(Math.round(point.offsetTicks), 0, durationTicks),
    volume: clamp(Number(point.volume) || 0, 0, 1),
    filter: clamp(Number(point.filter) || 0, -1, 1),
  }));

  return {
    id: rawEvent.id || uid("event"),
    startTick,
    durationTicks,
    midiNotes: rawEvent.midiNotes.map((note) => Math.round(note)),
    velocity: clamp(Number(rawEvent.velocity) || 0.8, 0.02, 1),
    automation: automation.length
      ? automation
      : [{ offsetTicks: 0, volume: clamp(rawEvent.velocity || 0.8, 0, 1), filter: 0 }],
    label: rawEvent.label || "",
  };
}

function validProject(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.tracks)) return createEmptyProject();
  const project = { ...createEmptyProject(), ...value };
  project.bpm = clamp(Number(project.bpm) || 120, 40, 240);
  project.meter = METERS[project.meter] ? project.meter : "4/4";
  project.quantization = Object.hasOwn(QUANTIZATION, project.quantization) ? project.quantization : "1/8";
  project.recordBars = clamp(Math.round(Number(project.recordBars) || 4), 1, MAX_FIRST_LOOP_BARS);
  project.loopTicks = Math.max(0, Math.round(project.loopTicks || 0));
  project.tracks = project.tracks.slice(0, MAX_TRACKS).map((track, index) => ({
    id: track.id || uid("track"),
    name: track.name || `Track ${index + 1}`,
    instrumentId: track.instrumentId || "warm-triangle",
    mode: track.mode === "melody" ? "melody" : "chord",
    gain: clamp(Number(track.gain ?? 1), 0, 1),
    muted: Boolean(track.muted),
    solo: Boolean(track.solo),
    events: Array.isArray(track.events) ? track.events : [],
  }));
  return project;
}

export class ProjectStore {
  constructor() {
    this.dbPromise = null;
    this.fallbackKey = "gesture-synth-loop-project-v1";
  }

  async #open() {
    if (!globalThis.indexedDB) return null;
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("gesture-synth", 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("projects")) database.createObjectStore("projects");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(() => null);
    }
    return this.dbPromise;
  }

  async load() {
    const database = await this.#open();
    if (!database) {
      try { return validProject(JSON.parse(localStorage.getItem(this.fallbackKey))); } catch { return createEmptyProject(); }
    }
    return new Promise((resolve) => {
      const request = database.transaction("projects", "readonly").objectStore("projects").get("current");
      request.onsuccess = () => resolve(validProject(request.result));
      request.onerror = () => resolve(createEmptyProject());
    });
  }

  async save(project) {
    const snapshot = structuredClone({ ...project, updatedAt: Date.now() });
    const database = await this.#open();
    if (!database) {
      localStorage.setItem(this.fallbackKey, JSON.stringify(snapshot));
      return;
    }
    await new Promise((resolve, reject) => {
      const request = database.transaction("projects", "readwrite").objectStore("projects").put(snapshot, "current");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear() {
    const database = await this.#open();
    if (!database) {
      localStorage.removeItem(this.fallbackKey);
      return;
    }
    await new Promise((resolve) => {
      const request = database.transaction("projects", "readwrite").objectStore("projects").delete("current");
      request.onsuccess = request.onerror = () => resolve();
    });
  }
}

export class LoopStation {
  constructor(audioEngine, options = {}) {
    this.audio = audioEngine;
    this.store = options.store || new ProjectStore();
    this.onChange = options.onChange || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.project = createEmptyProject();
    this.state = LOOP_STATES.IDLE;
    this.transportStartTime = 0;
    this.nextCycleIndex = 0;
    this.recordingStartTime = 0;
    this.recordingEndTime = 0;
    this.pendingStopTime = 0;
    this.countInTarget = null;
    this.capture = null;
    this.currentRawEvent = null;
    this.lastPerformanceState = null;
    this.lastAutomationTime = 0;
    this.saveTimer = null;
    this.captureClosed = false;
    this.firstRecordingTicks = 0;
    this.nextFirstMetronomeBeat = 0;
  }

  async restore() {
    this.project = await this.store.load();
    this.state = this.project.loopTicks ? LOOP_STATES.STOPPED : LOOP_STATES.IDLE;
    this.audio.ensureContext();
    this.audio.syncTracks(this.project.tracks);
    this.#emit();
    return this.project;
  }

  #emit(status) {
    this.onChange(this.project, this.state);
    if (status) this.onStatus(status);
  }

  #persistSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.store.save(this.project).catch(console.error), 350);
  }

  setBpm(value) {
    this.project.bpm = clamp(Number(value) || 120, 40, 240);
    const wasRunning = this.isTransportRunning();
    if (wasRunning) this.play(true);
    this.#persistSoon();
    this.#emit();
  }

  setMeter(value) {
    if (this.project.loopTicks || !METERS[value]) return false;
    this.project.meter = value;
    this.#persistSoon();
    this.#emit();
    return true;
  }

  setQuantization(value) {
    if (!Object.hasOwn(QUANTIZATION, value)) return;
    this.project.quantization = value;
    this.#persistSoon();
    this.#emit();
  }

  setMetronome(enabled) {
    this.project.metronome = Boolean(enabled);
    this.#persistSoon();
    this.#emit();
  }

  setRecordBars(value) {
    if (this.project.loopTicks || [LOOP_STATES.COUNT_IN, LOOP_STATES.RECORDING_FIRST].includes(this.state)) return false;
    this.project.recordBars = clamp(Math.round(Number(value) || 4), 1, MAX_FIRST_LOOP_BARS);
    this.#persistSoon();
    this.#emit();
    return true;
  }

  isTransportRunning() {
    return [LOOP_STATES.PLAYING, LOOP_STATES.RECORDING_TRACK].includes(this.state)
      || (this.state === LOOP_STATES.COUNT_IN && this.project.loopTicks > 0);
  }

  play(restart = false) {
    if (!this.project.loopTicks) return false;
    this.audio.ensureContext();
    this.audio.stopScheduledVoices();
    this.transportStartTime = this.audio.currentTime + 0.06;
    this.nextCycleIndex = 0;
    this.state = LOOP_STATES.PLAYING;
    this.#scheduleTransport(this.audio.currentTime, true);
    this.#emit(restart ? "Tempo updated" : "Playing");
    return true;
  }

  togglePlay() {
    if (this.isTransportRunning()) this.stop();
    else this.play();
  }

  record(config) {
    if (this.state === LOOP_STATES.RECORDING_FIRST) {
      this.finishFirstRecording();
      return true;
    }
    if (this.state === LOOP_STATES.RECORDING_TRACK || this.state === LOOP_STATES.COUNT_IN) return false;
    if (this.project.tracks.length >= MAX_TRACKS) {
      this.#emit("Maximum of 8 tracks reached");
      return false;
    }

    this.audio.ensureContext();
    this.capture = {
      id: uid("track"),
      name: `Track ${this.project.tracks.length + 1}`,
      instrumentId: config.instrumentId,
      mode: config.mode,
      gain: 1,
      muted: false,
      solo: false,
      rawEvents: [],
    };
    this.currentRawEvent = null;
    this.captureClosed = false;
    this.countInTarget = this.project.loopTicks ? "track" : "first";
    this.firstRecordingTicks = this.countInTarget === "first"
      ? ticksPerBar(this.project.meter) * this.project.recordBars
      : 0;

    const now = this.audio.currentTime;
    const barSeconds = ticksToSeconds(ticksPerBar(this.project.meter), this.project.bpm);
    if (this.project.loopTicks && this.isTransportRunning()) {
      const loopSeconds = ticksToSeconds(this.project.loopTicks, this.project.bpm);
      const cycles = Math.max(1, Math.ceil((now + 0.08 - this.transportStartTime) / loopSeconds));
      this.recordingStartTime = this.transportStartTime + cycles * loopSeconds;
    } else {
      this.recordingStartTime = now + barSeconds + 0.06;
      if (this.project.loopTicks) {
        this.transportStartTime = this.recordingStartTime;
        this.nextCycleIndex = 0;
      }
    }
    this.#scheduleCountIn(this.recordingStartTime - barSeconds);
    this.state = LOOP_STATES.COUNT_IN;
    this.#emit("Count in");
    return true;
  }

  #scheduleCountIn(startTime) {
    if (!this.project.metronome) return;
    const meter = METERS[this.project.meter];
    const beatSeconds = ticksToSeconds(ticksPerBeat(this.project.meter), this.project.bpm);
    for (let beat = 0; beat < meter.numerator; beat += 1) {
      const accent = beat === 0 || (this.project.meter === "6/8" && beat === 3);
      this.audio.scheduleMetronome(startTime + beat * beatSeconds, accent);
    }
  }

  #beginRecording() {
    this.currentRawEvent = null;
    this.lastAutomationTime = 0;
    if (this.countInTarget === "first") {
      this.recordingEndTime = this.recordingStartTime + ticksToSeconds(this.firstRecordingTicks, this.project.bpm);
      this.nextFirstMetronomeBeat = 0;
      this.state = LOOP_STATES.RECORDING_FIRST;
      this.#emit(`Recording ${this.project.recordBars} bar${this.project.recordBars === 1 ? "" : "s"}`);
    } else {
      this.recordingEndTime = this.recordingStartTime + ticksToSeconds(this.project.loopTicks, this.project.bpm);
      this.state = LOOP_STATES.RECORDING_TRACK;
      this.#emit("Recording track");
    }
    if (this.lastPerformanceState) this.ingestPerformanceState(this.lastPerformanceState, this.recordingStartTime);
  }

  finishFirstRecording(fixedTicks = 0) {
    if (this.state !== LOOP_STATES.RECORDING_FIRST || this.captureClosed) return false;
    const elapsedTicks = secondsToTicks(this.audio.currentTime - this.recordingStartTime, this.project.bpm);
    const barTicks = ticksPerBar(this.project.meter);
    const bars = fixedTicks
      ? clamp(Math.round(fixedTicks / barTicks), 1, MAX_FIRST_LOOP_BARS)
      : clamp(Math.ceil(Math.max(1, elapsedTicks) / barTicks), 1, MAX_FIRST_LOOP_BARS);
    this.project.loopTicks = bars * barTicks;
    this.pendingStopTime = this.recordingStartTime + ticksToSeconds(this.project.loopTicks, this.project.bpm);
    this.#finalizeRawEvent(this.project.loopTicks);
    this.captureClosed = true;
    this.#commitCapture(false);
    this.transportStartTime = this.pendingStopTime;
    this.nextCycleIndex = 0;
    this.#emit(`Loop closes in ${bars} bar${bars === 1 ? "" : "s"}`);
    return true;
  }

  stop() {
    if (this.state === LOOP_STATES.RECORDING_FIRST) return this.finishFirstRecording();
    if (this.state === LOOP_STATES.COUNT_IN) {
      this.capture = null;
      this.currentRawEvent = null;
      this.state = this.project.loopTicks ? LOOP_STATES.STOPPED : LOOP_STATES.IDLE;
      this.audio.stopScheduledVoices();
      this.#emit("Recording cancelled");
      return true;
    }
    if (this.state === LOOP_STATES.RECORDING_TRACK) {
      const tick = clamp(secondsToTicks(this.audio.currentTime - this.recordingStartTime, this.project.bpm), 0, this.project.loopTicks);
      this.#finalizeRawEvent(tick);
      this.#commitCapture(true);
    }
    this.audio.stopScheduledVoices();
    this.state = this.project.loopTicks ? LOOP_STATES.STOPPED : LOOP_STATES.IDLE;
    this.transportStartTime = 0;
    this.nextCycleIndex = 0;
    this.#emit("Stopped");
    return true;
  }

  ingestPerformanceState(performanceState, audioTime) {
    this.lastPerformanceState = performanceState;
    const recording = this.state === LOOP_STATES.RECORDING_FIRST || this.state === LOOP_STATES.RECORDING_TRACK;
    if (!recording || this.captureClosed || audioTime < this.recordingStartTime || !this.capture) return;

    const maximum = this.state === LOOP_STATES.RECORDING_TRACK
      ? this.project.loopTicks
      : ticksPerBar(this.project.meter) * MAX_FIRST_LOOP_BARS;
    const relativeTick = clamp(secondsToTicks(audioTime - this.recordingStartTime, this.project.bpm), 0, maximum);
    const notes = performanceState.gate ? performanceState.midiNotes || [] : [];
    const key = notes.length ? notes.join(",") : "";
    const currentKey = this.currentRawEvent?.midiNotes.join(",") || "";

    if (this.currentRawEvent && key !== currentKey) this.#finalizeRawEvent(relativeTick);
    if (key && !this.currentRawEvent) {
      this.currentRawEvent = {
        id: uid("event"),
        startTick: relativeTick,
        durationTicks: 0,
        midiNotes: [...notes],
        velocity: clamp(performanceState.volume || 0.8, 0.02, 1),
        label: performanceState.label || "",
        automation: [{
          offsetTicks: 0,
          volume: clamp(performanceState.volume || 0.8, 0, 1),
          filter: clamp(performanceState.filter || 0, -1, 1),
        }],
      };
      this.lastAutomationTime = audioTime;
    }

    if (this.currentRawEvent && audioTime - this.lastAutomationTime >= 0.05) {
      const previous = this.currentRawEvent.automation.at(-1);
      const volume = clamp(performanceState.volume || 0, 0, 1);
      const filter = clamp(performanceState.filter || 0, -1, 1);
      if (Math.abs(previous.volume - volume) >= 0.02 || Math.abs(previous.filter - filter) >= 0.02) {
        this.currentRawEvent.automation.push({
          offsetTicks: relativeTick - this.currentRawEvent.startTick,
          volume,
          filter,
        });
      }
      this.lastAutomationTime = audioTime;
    }
  }

  #finalizeRawEvent(endTick) {
    if (!this.currentRawEvent || !this.capture) return;
    this.currentRawEvent.durationTicks = Math.max(1, endTick - this.currentRawEvent.startTick);
    this.capture.rawEvents.push(this.currentRawEvent);
    this.currentRawEvent = null;
  }

  #commitCapture(keepCrossingBoundary) {
    if (!this.capture || !this.project.loopTicks) return;
    const track = {
      id: this.capture.id,
      name: this.capture.name,
      instrumentId: this.capture.instrumentId,
      mode: this.capture.mode,
      gain: 1,
      muted: false,
      solo: false,
      events: this.capture.rawEvents
        .map((event) => normalizeRecordedEvent(event, this.project, keepCrossingBoundary))
        .filter((event) => event.midiNotes.length),
    };
    this.project.tracks.push(track);
    this.audio.syncTracks(this.project.tracks);
    this.capture = null;
    this.currentRawEvent = null;
    this.#persistSoon();
  }

  update(audioTime = this.audio.currentTime) {
    if (this.state === LOOP_STATES.COUNT_IN && audioTime >= this.recordingStartTime) this.#beginRecording();

    if (this.state === LOOP_STATES.RECORDING_FIRST && !this.captureClosed) {
      this.#scheduleFirstRecordingMetronome(audioTime);
      if (audioTime >= this.recordingEndTime) this.finishFirstRecording(this.firstRecordingTicks);
    }

    if (this.state === LOOP_STATES.RECORDING_FIRST && this.captureClosed && audioTime >= this.pendingStopTime) {
      this.state = LOOP_STATES.PLAYING;
      this.captureClosed = false;
      this.#emit("Playing");
    }

    if (this.state === LOOP_STATES.RECORDING_TRACK && audioTime >= this.recordingEndTime) {
      this.#finalizeRawEvent(this.project.loopTicks);
      this.#commitCapture(true);
      this.state = LOOP_STATES.PLAYING;
      this.#emit("Track captured");
    }

    if (this.project.loopTicks && this.transportStartTime && this.isTransportRunning()) {
      this.#scheduleTransport(audioTime);
    }
  }

  #scheduleFirstRecordingMetronome(now) {
    if (!this.project.metronome || !this.firstRecordingTicks) return;
    const beatTicks = ticksPerBeat(this.project.meter);
    const beatSeconds = ticksToSeconds(beatTicks, this.project.bpm);
    const totalBeats = Math.round(this.firstRecordingTicks / beatTicks);
    const meter = METERS[this.project.meter];
    const scheduleUntil = now + 0.22;
    while (this.nextFirstMetronomeBeat < totalBeats) {
      const beat = this.nextFirstMetronomeBeat;
      const when = this.recordingStartTime + beat * beatSeconds;
      if (when >= scheduleUntil) break;
      if (when >= now - 0.03) {
        const withinBar = beat % meter.numerator;
        const accent = withinBar === 0 || (this.project.meter === "6/8" && withinBar === 3);
        this.audio.scheduleMetronome(when, accent);
      }
      this.nextFirstMetronomeBeat += 1;
    }
  }

  #scheduleTransport(now, force = false) {
    if (!this.project.loopTicks || !this.transportStartTime) return;
    const loopSeconds = ticksToSeconds(this.project.loopTicks, this.project.bpm);
    const scheduleUntil = now + (force ? Math.max(0.25, loopSeconds) : 0.22);
    const convert = (ticks) => ticksToSeconds(ticks, this.project.bpm);
    this.audio.syncTracks(this.project.tracks);

    while (this.transportStartTime + this.nextCycleIndex * loopSeconds < scheduleUntil) {
      const cycleStart = this.transportStartTime + this.nextCycleIndex * loopSeconds;
      for (const track of this.project.tracks) {
        for (const event of track.events) {
          const when = cycleStart + convert(event.startTick);
          if (when >= now - 0.02) this.audio.scheduleEvent(event, track, when, convert);
        }
      }
      if (this.project.metronome) this.#scheduleCycleMetronome(cycleStart);
      this.nextCycleIndex += 1;
    }
  }

  #scheduleCycleMetronome(cycleStart) {
    const beatTicks = ticksPerBeat(this.project.meter);
    const totalBeats = Math.round(this.project.loopTicks / beatTicks);
    const meter = METERS[this.project.meter];
    for (let beat = 0; beat < totalBeats; beat += 1) {
      const withinBar = beat % meter.numerator;
      const accent = withinBar === 0 || (this.project.meter === "6/8" && withinBar === 3);
      this.audio.scheduleMetronome(cycleStart + ticksToSeconds(beat * beatTicks, this.project.bpm), accent);
    }
  }

  getSnapshot(audioTime = this.audio.currentTime) {
    let progress = 0;
    let currentTick = 0;
    let countIn = 0;
    if (this.state === LOOP_STATES.COUNT_IN) countIn = Math.max(0, Math.ceil(this.recordingStartTime - audioTime));
    if (this.project.loopTicks && this.transportStartTime && audioTime >= this.transportStartTime) {
      const loopSeconds = ticksToSeconds(this.project.loopTicks, this.project.bpm);
      const elapsed = (audioTime - this.transportStartTime) % loopSeconds;
      progress = elapsed / loopSeconds;
      currentTick = secondsToTicks(elapsed, this.project.bpm);
    } else if (this.state === LOOP_STATES.RECORDING_FIRST && !this.captureClosed) {
      currentTick = clamp(secondsToTicks(audioTime - this.recordingStartTime, this.project.bpm), 0, this.firstRecordingTicks);
      progress = this.firstRecordingTicks ? currentTick / this.firstRecordingTicks : 0;
    }
    const timelineTicks = this.project.loopTicks || this.firstRecordingTicks || ticksPerBar(this.project.meter) * this.project.recordBars;
    const previewEvents = this.capture ? this.capture.rawEvents.map((event) => ({ ...event })) : [];
    if (this.currentRawEvent) {
      previewEvents.push({
        ...this.currentRawEvent,
        durationTicks: Math.max(1, currentTick - this.currentRawEvent.startTick),
      });
    }
    const beatTicks = ticksPerBeat(this.project.meter);
    const barTicks = ticksPerBar(this.project.meter);
    return {
      state: this.state,
      progress: clamp(progress, 0, 1),
      countIn,
      bar: Math.floor(currentTick / barTicks) + 1,
      beat: Math.floor((currentTick % barTicks) / beatTicks) + 1,
      trackCount: this.project.tracks.length,
      currentTick,
      timelineTicks,
      previewEvents,
    };
  }

  updateTrack(trackId, patch) {
    const track = this.project.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    if (patch.instrumentId) track.instrumentId = patch.instrumentId;
    if (patch.name != null) track.name = String(patch.name).slice(0, 40);
    if (patch.gain != null) track.gain = clamp(Number(patch.gain), 0, 1);
    if (patch.muted != null) track.muted = Boolean(patch.muted);
    if (patch.solo != null) track.solo = Boolean(patch.solo);
    this.audio.syncTracks(this.project.tracks);
    this.#persistSoon();
    this.#emit();
    return true;
  }

  deleteTrack(trackId) {
    const index = this.project.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) return false;
    this.project.tracks.splice(index, 1);
    if (!this.project.tracks.length) {
      this.stop();
      this.project.loopTicks = 0;
      this.state = LOOP_STATES.IDLE;
    }
    this.audio.syncTracks(this.project.tracks);
    this.#persistSoon();
    this.#emit("Track deleted");
    return true;
  }

  undoLastTrack() {
    const track = this.project.tracks.at(-1);
    return track ? this.deleteTrack(track.id) : false;
  }

  async clearAll() {
    this.audio.stopScheduledVoices();
    this.project = createEmptyProject();
    this.state = LOOP_STATES.IDLE;
    this.transportStartTime = 0;
    this.capture = null;
    await this.store.clear();
    this.#emit("Loop cleared");
  }

  async exportWav(onProgress) {
    return this.audio.renderProject(this.project, onProgress);
  }
}
