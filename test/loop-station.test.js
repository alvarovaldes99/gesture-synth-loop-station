import test from "node:test";
import assert from "node:assert/strict";
import { secondsToTicks, ticksToSeconds } from "../audio-engine.js";
import {
  LOOP_STATES,
  MAX_TRACKS,
  LoopStation,
  ProjectStore,
  createEmptyProject,
  normalizeRecordedEvent,
  quantizeTick,
  ticksPerBar,
  ticksPerBeat,
} from "../loop-station.js";

class FakeAudioEngine {
  constructor() {
    this.currentTime = 0;
    this.scheduledEvents = [];
    this.metronome = [];
  }
  ensureContext() {}
  syncTracks() {}
  stopScheduledVoices() {}
  scheduleEvent(event, track, when) { this.scheduledEvents.push({ event, track, when }); }
  scheduleMetronome(when, accent) { this.metronome.push({ when, accent }); }
}

const memoryStore = {
  async load() { return createEmptyProject(); },
  async save() {},
  async clear() {},
};

test("96 PPQ clock and supported meters use quarter-note BPM", () => {
  assert.equal(ticksToSeconds(96, 120), 0.5);
  assert.equal(secondsToTicks(0.5, 120), 96);
  assert.equal(ticksPerBar("3/4"), 288);
  assert.equal(ticksPerBar("4/4"), 384);
  assert.equal(ticksPerBar("6/8"), 288);
  assert.equal(ticksPerBeat("6/8"), 48);
});

test("quantization supports off, quarters, eighths and sixteenths", () => {
  assert.equal(quantizeTick(31, "off"), 31);
  assert.equal(quantizeTick(55, "1/4"), 96);
  assert.equal(quantizeTick(55, "1/8"), 48);
  assert.equal(quantizeTick(37, "1/16"), 48);
});

test("short events get a minimum division and boundary crossings are preserved", () => {
  const project = { ...createEmptyProject(), loopTicks: 384, quantization: "1/8" };
  const short = normalizeRecordedEvent({ startTick: 53, durationTicks: 2, midiNotes: [60], velocity: 0.8 }, project);
  assert.deepEqual([short.startTick, short.durationTicks], [48, 48]);

  const crossing = normalizeRecordedEvent({ startTick: 350, durationTicks: 90, midiNotes: [64], velocity: 0.8 }, project, true);
  assert.equal(crossing.startTick, 336);
  assert.equal(crossing.durationTicks, 96);
  assert.ok(crossing.startTick + crossing.durationTicks > project.loopTicks);

  const clipped = normalizeRecordedEvent({ startTick: 350, durationTicks: 90, midiNotes: [64], velocity: 0.8 }, project, false);
  assert.equal(clipped.startTick + clipped.durationTicks, project.loopTicks);
});

test("first take counts in, closes on a bar and enters playback", () => {
  const audio = new FakeAudioEngine();
  const station = new LoopStation(audio, { store: memoryStore });
  assert.equal(station.record({ instrumentId: "warm-triangle", mode: "chord" }), true);
  assert.equal(station.state, LOOP_STATES.COUNT_IN);
  assert.equal(station.recordingStartTime, 2.06);

  audio.currentTime = station.recordingStartTime;
  station.update();
  assert.equal(station.state, LOOP_STATES.RECORDING_FIRST);
  station.ingestPerformanceState({ gate: true, midiNotes: [60, 64, 67], volume: 0.7, filter: 0, label: "C" }, audio.currentTime);
  audio.currentTime += 0.3;
  station.ingestPerformanceState({ gate: false, midiNotes: [], volume: 0, filter: 0 }, audio.currentTime);
  assert.equal(station.finishFirstRecording(), true);
  assert.equal(station.project.loopTicks, 384);
  assert.equal(station.project.tracks.length, 1);
  assert.equal(station.project.tracks[0].events.length, 1);

  audio.currentTime = station.pendingStopTime;
  station.update();
  assert.equal(station.state, LOOP_STATES.PLAYING);
  clearTimeout(station.saveTimer);
});

test("overdub captures exactly one cycle and the ninth track is rejected", () => {
  const audio = new FakeAudioEngine();
  const station = new LoopStation(audio, { store: memoryStore });
  station.project.loopTicks = 384;
  station.project.tracks.push({ id: "one", name: "Track 1", instrumentId: "warm-triangle", mode: "chord", gain: 1, muted: false, solo: false, events: [] });
  station.state = LOOP_STATES.PLAYING;
  station.transportStartTime = 0.06;
  audio.currentTime = 0.2;
  assert.equal(station.record({ instrumentId: "retro-square", mode: "melody" }), true);
  audio.currentTime = station.recordingStartTime;
  station.update();
  assert.equal(station.state, LOOP_STATES.RECORDING_TRACK);
  station.ingestPerformanceState({ gate: true, midiNotes: [69], volume: 0.8, filter: 0.2, label: "A" }, audio.currentTime);
  audio.currentTime = station.recordingEndTime;
  station.update();
  assert.equal(station.state, LOOP_STATES.PLAYING);
  assert.equal(station.project.tracks.length, 2);
  assert.equal(station.project.tracks[1].mode, "melody");

  station.project.tracks = Array.from({ length: MAX_TRACKS }, (_, index) => ({ id: String(index), events: [] }));
  assert.equal(station.record({ instrumentId: "warm-triangle", mode: "chord" }), false);
  clearTimeout(station.saveTimer);
});

test("6/8 metronome accents eighth-note pulses 1 and 4", () => {
  const audio = new FakeAudioEngine();
  const station = new LoopStation(audio, { store: memoryStore });
  station.project.loopTicks = ticksPerBar("6/8");
  station.project.meter = "6/8";
  station.project.tracks = [{ id: "one", name: "Track 1", instrumentId: "warm-triangle", mode: "chord", gain: 1, muted: false, solo: false, events: [] }];
  station.play();
  assert.equal(audio.metronome.length, 6);
  assert.deepEqual(audio.metronome.map((pulse) => pulse.accent), [true, false, false, true, false, false]);
});

test("ten minutes of scheduling stays locked to exact cycle boundaries", () => {
  const audio = new FakeAudioEngine();
  const station = new LoopStation(audio, { store: memoryStore });
  station.project.loopTicks = 384;
  station.project.metronome = false;
  station.project.tracks = [{
    id: "one", name: "Track 1", instrumentId: "warm-triangle", mode: "melody", gain: 1, muted: false, solo: false,
    events: [{ id: "event", startTick: 0, durationTicks: 48, midiNotes: [60], velocity: 0.8, automation: [] }],
  }];
  station.play();
  for (let time = 0; time <= 600; time += 0.1) {
    audio.currentTime = time;
    station.update();
  }
  assert.ok(audio.scheduledEvents.length >= 300);
  for (let index = 1; index < audio.scheduledEvents.length; index += 1) {
    assert.ok(Math.abs((audio.scheduledEvents[index].when - audio.scheduledEvents[index - 1].when) - 2) < 1e-10);
  }
});

test("ProjectStore persists a versioned project through its fallback", async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.indexedDB = undefined;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  try {
    const store = new ProjectStore();
    const project = { ...createEmptyProject(), bpm: 137, meter: "3/4", loopTicks: 288 };
    await store.save(project);
    const restored = await store.load();
    assert.equal(restored.version, 1);
    assert.equal(restored.bpm, 137);
    assert.equal(restored.meter, "3/4");
    assert.equal(restored.loopTicks, 288);
    assert.equal(typeof restored.updatedAt, "number");
    await store.clear();
    assert.equal((await store.load()).loopTicks, 0);
  } finally {
    globalThis.indexedDB = previousIndexedDb;
    globalThis.localStorage = previousLocalStorage;
  }
});

