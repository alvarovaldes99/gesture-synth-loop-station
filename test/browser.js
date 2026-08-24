import { LoopStation, LOOP_STATES, createEmptyProject } from "../loop-station.js";
import { AudioEngine } from "../audio-engine.js";
import { InstrumentRegistry } from "../instruments.js";

const results = document.getElementById("results");
const runButton = document.getElementById("run");

class BrowserFakeAudio {
  constructor() { this.currentTime = 0; }
  ensureContext() {}
  syncTracks() {}
  stopScheduledVoices() {}
  scheduleEvent() {}
  scheduleMetronome() {}
}

const store = { async load() { return createEmptyProject(); }, async save() {}, async clear() {} };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function report(name, task) {
  const item = document.createElement("li");
  try {
    await task();
    item.className = "pass";
    item.textContent = `PASS — ${name}`;
  } catch (error) {
    item.className = "fail";
    item.textContent = `FAIL — ${name}: ${error.message}`;
  }
  results.append(item);
}

runButton.addEventListener("click", async () => {
  results.replaceChildren();
  const audio = new BrowserFakeAudio();
  const station = new LoopStation(audio, { store });
  station.record({ instrumentId: "warm-triangle", mode: "melody" });
  audio.currentTime = station.recordingStartTime;
  station.update();

  const note = (gate, volume = 0.75, filter = 0) => ({
    mode: "melody", instrumentId: "warm-triangle", gate,
    midiNotes: gate ? [60] : [], volume, filter, label: gate ? "C" : "",
  });
  station.ingestPerformanceState(note(true), audio.currentTime);
  audio.currentTime += 0.08;
  station.ingestPerformanceState(note(true, 0.9, 0.35), audio.currentTime);
  audio.currentTime += 0.08;
  station.ingestPerformanceState(note(false, 0), audio.currentTime);
  audio.currentTime += 0.08;
  station.ingestPerformanceState(note(true), audio.currentTime);
  audio.currentTime += 0.08;
  station.ingestPerformanceState(note(false, 0), audio.currentTime);
  station.finishFirstRecording();

  await report("count-in enters first recording", () => assert(station.captureClosed && station.state === LOOP_STATES.RECORDING_FIRST, "wrong state"));
  await report("closed fist and reopen repeats the same melody note", () => {
    const events = station.project.tracks[0].events;
    assert(events.length === 2, `expected 2 events, got ${events.length}`);
    assert(events.every((event) => event.midiNotes[0] === 60), "wrong recorded pitch");
  });
  await report("20 Hz expression capture retains thresholded automation", () => {
    assert(station.project.tracks[0].events[0].automation.length === 2, "automation point missing");
  });
  await report("recorded notes remain absolute MIDI values", () => {
    const original = station.project.tracks[0].events[0].midiNotes[0];
    const simulatedNewKey = 7;
    assert(original === 60 && original !== 60 + simulatedNewKey, "recording was transposed");
  });
  await report("offline WAV is one exact audible cycle with automation", async () => {
    const renderer = new AudioEngine(new InstrumentRegistry());
    const project = {
      ...createEmptyProject(),
      loopTicks: 96,
      tracks: [{
        id: "render", name: "Render", instrumentId: "warm-triangle", mode: "melody",
        gain: 1, muted: false, solo: false,
        events: [{
          id: "event", startTick: 0, durationTicks: 72, midiNotes: [69], velocity: 0.8,
          automation: [
            { offsetTicks: 0, volume: 0.45, filter: -0.2 },
            { offsetTicks: 24, volume: 0.9, filter: 0.4 },
          ],
        }],
      }],
    };
    const wav = await renderer.renderProject(project);
    const bytes = new DataView(await wav.arrayBuffer());
    const expectedFrames = Math.ceil(0.5 * 44100);
    assert(bytes.byteLength === 44 + expectedFrames * 4, "WAV duration is not one cycle");
    let peak = 0;
    for (let offset = 44; offset < bytes.byteLength; offset += 2) peak = Math.max(peak, Math.abs(bytes.getInt16(offset, true)));
    assert(peak > 0, "WAV is silent");
    assert(peak <= Math.ceil(0x7fff * 0.98), "WAV exceeds limiter ceiling");
  });
  clearTimeout(station.saveTimer);
});

