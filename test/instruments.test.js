import test from "node:test";
import assert from "node:assert/strict";
import { INSTRUMENT_DEFINITIONS, InstrumentRegistry, decodeAudioBuffer, frequencyToMidi, midiToFrequency } from "../instruments.js";

test("instrument registry exposes synth and local sampled presets", () => {
  const registry = new InstrumentRegistry();
  assert.equal(INSTRUMENT_DEFINITIONS.length, 11);
  assert.equal(registry.get("analog-bass").notePolicy, "root-octave");
  for (const id of ["acoustic-piano", "string-ensemble", "marimba", "glockenspiel"]) {
    assert.equal(registry.isSampled(id), true);
    assert.match(registry.get(id).manifestUrl, /^\/samples\//);
  }
});

test("MIDI and frequency conversion round trips", () => {
  for (const midi of [36, 57, 69, 84]) assert.equal(frequencyToMidi(midiToFrequency(midi)), midi);
});

test("sample decoding supports callback-only Safari and Promise browsers", async () => {
  const decoded = { duration: 1 };
  const callbackContext = {
    decodeAudioData(_data, success) {
      queueMicrotask(() => success(decoded));
      return undefined;
    },
  };
  assert.equal(await decodeAudioBuffer(callbackContext, new ArrayBuffer(4)), decoded);

  const promiseContext = {
    decodeAudioData() { return Promise.resolve(decoded); },
  };
  assert.equal(await decodeAudioBuffer(promiseContext, new ArrayBuffer(4)), decoded);
});
