import test from "node:test";
import assert from "node:assert/strict";
import { AudioEngine, encodeWav } from "../audio-engine.js";

test("per-instrument levels are adjustable and safely bounded", () => {
  const engine = new AudioEngine();
  assert.equal(engine.getInstrumentLevel("acoustic-piano"), 1);
  engine.setInstrumentLevel("acoustic-piano", 1.65);
  assert.equal(engine.getInstrumentLevel("acoustic-piano"), 1.65);
  engine.setInstrumentLevel("acoustic-piano", 20);
  assert.equal(engine.getInstrumentLevel("acoustic-piano"), 2);
  engine.setInstrumentLevel("acoustic-piano", 0);
  assert.equal(engine.getInstrumentLevel("acoustic-piano"), 0.25);
});

test("WAV encoder creates stereo 44.1 kHz PCM16 and caps peaks", async () => {
  const left = Float32Array.from([0, 0.5, 1.5, -1.5]);
  const right = Float32Array.from([0, -0.25, 0.8, -0.8]);
  const audioBuffer = {
    numberOfChannels: 2,
    length: left.length,
    sampleRate: 44100,
    getChannelData: (channel) => channel ? right : left,
  };
  const blob = encodeWav(audioBuffer);
  const view = new DataView(await blob.arrayBuffer());
  const text = (start, length) => String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(start + index)));
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16);
  let peak = 0;
  for (let offset = 44; offset < view.byteLength; offset += 2) peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  assert.ok(peak <= Math.ceil(0x7fff * 0.98));
  assert.ok(peak > 0);
});
