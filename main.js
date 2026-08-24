import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { AudioEngine } from "./audio-engine.js";
import {
  INSTRUMENT_DEFINITIONS,
  InstrumentRegistry,
  frequencyToMidi,
} from "./instruments.js";
import { LOOP_STATES, LoopStation, MAX_TRACKS, ticksPerBar } from "./loop-station.js";

// ---- DOM references ----
const videoEl = document.getElementById("webcam");
const canvasEl = document.getElementById("overlay");
const ctx = canvasEl.getContext("2d");

const gestureGuideEl = document.getElementById("gestureGuide");
const guideToggleEl = document.getElementById("guideToggle");
const chordDisplayEl = document.getElementById("chordDisplay");
const volumeBarEls = Array.from(document.querySelectorAll(".vol-bar"));
const qualityDisplayEl = document.getElementById("qualityDisplay");
const startOverlayEl = document.getElementById("startOverlay");
const instrumentSelectEl = document.getElementById("instrumentSelect");
const instrumentPreviewButtonEl = document.getElementById("instrumentPreviewButton");
const playModeSelectEl = document.getElementById("playModeSelect");
const sampleLoadStatusEl = document.getElementById("sampleLoadStatus");
const recordButtonEl = document.getElementById("recordButton");
const playButtonEl = document.getElementById("playButton");
const stopButtonEl = document.getElementById("stopButton");
const undoButtonEl = document.getElementById("undoButton");
const clearButtonEl = document.getElementById("clearButton");
const exportButtonEl = document.getElementById("exportButton");
const bpmInputEl = document.getElementById("bpmInput");
const meterSelectEl = document.getElementById("meterSelect");
const quantizeSelectEl = document.getElementById("quantizeSelect");
const recordBarsInputEl = document.getElementById("recordBarsInput");
const metronomeToggleEl = document.getElementById("metronomeToggle");
const transportStatusEl = document.getElementById("transportStatus");
const loopProgressEl = document.getElementById("loopProgress");
const loopPositionEl = document.getElementById("loopPosition");
const masterMeterFillEl = document.getElementById("masterMeterFill");
const trackPanelToggleEl = document.getElementById("trackPanelToggle");
const trackPanelEl = document.getElementById("trackPanel");
const trackListEl = document.getElementById("trackList");
const trackCountEl = document.getElementById("trackCount");
const toastEl = document.getElementById("toast");
const recordingTimelineEl = document.getElementById("recordingTimeline");
const recordingTimelineCanvasEl = document.getElementById("recordingTimelineCanvas");
const recordingTimelineCtx = recordingTimelineCanvasEl.getContext("2d");
const timelineTitleEl = document.getElementById("timelineTitle");
const timelineChordEl = document.getElementById("timelineChord");

function trackClarityEvent(eventName) {
  if (typeof window.clarity === "function") {
    window.clarity("event", eventName);
  }
}

// NEW
const helpButton = document.getElementById("helpButton");
const helpModal = document.getElementById("helpModal");
const closeHelp = document.getElementById("closeHelp");

// ---- Finger landmark indices ----
const FINGERS = {
  index:  { pip: 6, tip: 8 },
  middle: { pip: 10, tip: 12 },
  ring:   { pip: 14, tip: 16 },
  pinky:  { pip: 18, tip: 20 },
};

function isFingerExtended(landmarks, name) {
  const { pip, tip } = FINGERS[name];
  return landmarks[tip].y < landmarks[pip].y;
}

function isThumbExtended(landmarks, handedness) {
  const thumbTip = landmarks[4];
  const thumbIp = landmarks[3];

  if (handedness === "Right") {
    return thumbTip.x > thumbIp.x;
  } else {
    return thumbTip.x < thumbIp.x;
  }
}

function getChordQuality(landmarks) {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9]; // middle finger MCP joint
  return middleMcp.x > wrist.x ? "minor" : "major";
}

function classifyChord(landmarks, handedness) {
  const thumb = isThumbExtended(landmarks, handedness);
  const index = isFingerExtended(landmarks, "index");
  const middle = isFingerExtended(landmarks, "middle");
  const ring = isFingerExtended(landmarks, "ring");
  const pinky = isFingerExtended(landmarks, "pinky");

  const quality = getChordQuality(landmarks);

  if (index && pinky && !middle && !ring && !thumb) {
    return quality === "major" ? "VI" : "vi";
  }

  if (index && pinky && !middle && !ring && thumb) {
    return quality === "major" ? "VII" : "vii";
  }

  const count = [thumb, index, middle, ring, pinky].filter(Boolean).length;
  const ROMAN = { 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V" };
  const base = ROMAN[count];
  if (!base) return null;

  return quality === "major" ? base : base.toLowerCase();
}

function getHandHorizontalTilt(landmarks, handedness) {
  // Safe structure guardrails to prevent engine freezing
  if (!landmarks || typeof landmarks.length === "undefined" || landmarks.length < 18) {
    return 0;
  }

  try {
    const wrist = landmarks[0];     // Wrist Base
    const middleMcp = landmarks[9];  // Middle Knuckle (Left pillar)
    const ringMcp = landmarks[13];  // Ring Knuckle (Right pillar)

    if (!wrist || !middleMcp || !ringMcp) return 0;

    // Determine the left boundary and right boundary in coordinate space
    const minX = Math.min(middleMcp.x, ringMcp.x);
    const maxX = Math.max(middleMcp.x, ringMcp.x);

    let tiltFactor = 0;
    // Max travel distance past the boundaries before hitting 100%
    const MAX_TRAVEL = 0.12; 

    if (wrist.x < minX) {
      // Wrist has slipped out to the left of the hand structure
      tiltFactor = (wrist.x - minX) / MAX_TRAVEL;
    } else if (wrist.x > maxX) {
      // Wrist has slipped out to the right of the hand structure
      tiltFactor = (wrist.x - maxX) / MAX_TRAVEL;
    } else {
      // Wrist is safely between the knuckles -> Dead-zone active!
      tiltFactor = 0;
    }

    // Clamp value safely between -1.0 and 1.0
    tiltFactor = Math.max(-1, Math.min(1, tiltFactor));

    // Keep your working structural layout rule for right-hand inversion
    if (handedness === "Right") {
      tiltFactor = -tiltFactor;
    }

    return tiltFactor;

  } catch (error) {
    console.error("Buffered tilt calculation failed:", error);
    return 0;
  }
}

function drawEnergy(ctx, volume01, qualityIndex, tiltFactor, chordStr) {
  if (!ctx) return;

  // 1. QUALITY determines the number of lines (1: Major, 2: Minor, 3: Dominant, 4: Diminished)
  if (qualityIndex === 0) return;
  const lineCount = qualityIndex; // 1 to 4 lines stacked or layered

  try {
    // Center alignment point behind your absolute bottom HTML #chordDisplay text
    const centerY = ctx.canvas.height - 128;
    const canvasWidth = ctx.canvas.width;

    // 2. VOLUME determines the thickness of the lines
    const maxThickness = 1 + (volume01 * 8); // Scaled from hairline to 9px thick

    // 3. TILT determines the "shakiness" (magnitude and speed of jagged distortion)
    // Convert tiltFactor (-1 to 1) linearly to a chaos scale (0 to 1)
    const chaosScale = (tiltFactor + 1) / 2;
    const shakinessAmp = chaosScale * 25;   // Micro-vibrations past the base wave path
    const shakinessFreq = 0.05 + (chaosScale * 0.15); 

    // ---- 4. SCALE DEGREE determines the color hues ----
    let baseColorRGB = "150, 150, 150"; // Muted gray placeholder when no chord is playing
    let isChordActive = false;
    let isMajor = false;

    if (chordStr && chordStr !== "--") {
      isChordActive = true;
      const upperStr = chordStr.toUpperCase();
      isMajor = (chordStr === upperStr);

      const SCALE_COLORS = {
        "I":   "232, 161, 61",  // Tonic: Golden Sunset
        "II":  "210, 50, 120",  // 2nd: Purple-Red
        "III": "180, 40, 150",  // 3rd: Deep Violet/Magenta alternative
        "IV":  "240, 210, 40",  // 4th: Yellow
        "V":   "245, 120, 30",  // 5th: Orange
        "VI":  "230, 40, 40",    // 6th: Red
        "VII": "100, 200, 250"   // 7th: Cyan
      };
      baseColorRGB = SCALE_COLORS[upperStr] || "232, 161, 61";
    }


    // ---- 5. MAJOR / MINOR determines brightness ----
    // Major chords pop at 100% full opacity/glow. Minor chords damp down to a subtle 45% moody state.
    const brightnessAlpha = isChordActive ? (isMajor ? 1 : 0.70) : 0.3;

    ctx.save();
    
    // Time variable creates fluid left-to-right scrolling motion frame-by-frame
    const time = performance.now() * 0.004;

    // Parse base color strings safely for layout injection
    const colorChannels = baseColorRGB.split(",");
    const r = parseInt(colorChannels[0]);
    const g = parseInt(colorChannels[1]);
    const b = parseInt(colorChannels[2]);

    ctx.shadowBlur = 10 + (volume01 * 20);
    ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${0.5 * brightnessAlpha})`;

    // Draw individual lines stacked around the vertical text baseline
    for (let l = 0; l < lineCount; l++) {
      ctx.beginPath();

      // Separate each individual line layer vertically so they look like a wire ribbon
      const lineYOffset = centerY + (l - (lineCount - 1) / 2) * 12;

      for (let x = 0; x <= canvasWidth; x += 10) {
        // A standard flowing sine wave path
        const baseSine = Math.sin(x * 0.005 + time + l * 0.5) * 20;
        
        // Jitter math: Random noise scaled entirely by the right-hand tilt shakiness
        const jitter = (Math.random() - 0.5) * shakinessAmp * Math.sin(x * shakinessFreq + time);

        const y = lineYOffset + baseSine + jitter;

        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${brightnessAlpha})`;
      ctx.lineWidth = Math.max(1, maxThickness - (l * 0.5)); // Subtle thickness variation per line layer
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    ctx.restore();

  } catch (error) {
    console.error("Wave animation failed:", error);
  }
}


// ---- Independent Gesture Stabilizers ----

// Musical state: needs confidence before changing
const CHORD_HOLD_TIME_MS = 100;

// Expression controls: should feel immediate
const VIBE_NULL_WINDOW_MS = 50;
// ============================
// CHORD STATE STABILIZER
// ============================

let stableChordState = null;
let candidateChordState = null;
let candidateChordSince = 0;
let lastChordSeenValidTime = 0;


function sameChordState(a, b) {

  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  return (
    a.chord === b.chord &&
    a.isMajorMode === b.isMajorMode &&
    a.qualityIndex === b.qualityIndex &&
    a.thumbDown === b.thumbDown
  );
}


function stabilizeChordState(rawState, now) {

  if (rawState !== null) {
    lastChordSeenValidTime = now;
  }


  let effectiveState = rawState;


  // prevent MediaPipe flicker
  if (
    rawState === null &&
    now - lastChordSeenValidTime < VIBE_NULL_WINDOW_MS
  ) {
    effectiveState = candidateChordState;
  }


  if (
    !sameChordState(
      effectiveState,
      candidateChordState
    )
  ) {

    candidateChordState = effectiveState;
    candidateChordSince = now;

  }


  if (
    now - candidateChordSince >= CHORD_HOLD_TIME_MS
  ) {

    stableChordState = candidateChordState;

  }


  return stableChordState;
}

// ---- Right hand: volume from height ----
function getVolumeFromHeight(landmarks) {
  const wrist = landmarks[0];
  const TOP = 0.05;
  const BOTTOM = 0.95;

  const clamped = Math.max(TOP, Math.min(BOTTOM, wrist.y));
  const t = (clamped - TOP) / (BOTTOM - TOP);
  return 1 - t;
}

function updateVolumeMeter(volume01) {
  const litCount = Math.round(volume01 * volumeBarEls.length);
  volumeBarEls.forEach((bar) => {
    const index = Number(bar.dataset.index);
    bar.classList.toggle("lit", index >= volumeBarEls.length - litCount);
  });
}

// ---- Right hand: quality (1-4 fingers = major, minor, dominant, diminished) ----
function getRightHandQualityIndex(landmarks) {
  const index = isFingerExtended(landmarks, "index");
  const middle = isFingerExtended(landmarks, "middle");
  const ring = isFingerExtended(landmarks, "ring");
  const pinky = isFingerExtended(landmarks, "pinky");

  return [index, middle, ring, pinky].filter(Boolean).length;
}


// ---- Camera setup ----
async function setupCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: false,
  });
  videoEl.srcObject = stream;
  return new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      resolve();
    };
  });
}



// ---- MediaPipe setup ----
async function setupHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
  });
}

// ADD THIS
const GESTURE_GUIDE = [
  { degree: 1, gesture: "1️⃣" },
  { degree: 2, gesture: "2️⃣" },
  { degree: 3, gesture: "3️⃣" },
  { degree: 4, gesture: "4️⃣" },
  { degree: 5, gesture: "5️⃣" },
  { degree: 6, gesture: "🤘" },
  { degree: 7, gesture: "🤟" }
];

const MAJOR_SCALE = {
  A:  ["A","B","C#","D","E","F#","G#"],
  Bb: ["Bb","C","D","Eb","F","G","A"],
  B:  ["B","C#","D#","E","F#","G#","A#"],
  C:  ["C","D","E","F","G","A","B"],
  Db: ["Db","Eb","F","Gb","Ab","Bb","C"],
  D:  ["D","E","F#","G","A","B","C#"],
  Eb: ["Eb","F","G","Ab","Bb","C","D"],
  E:  ["E","F#","G#","A","B","C#","D#"],
  F:  ["F","G","A","Bb","C","D","E"],
  Gb: ["Gb","Ab","Bb","Cb","Db","Eb","F"],
  G:  ["G","A","B","C","D","E","F#"],
  Ab: ["Ab","Bb","C","Db","Eb","F","G"]
};

function updateGestureGuide() {
  if (!gestureGuideEl) return;

  const scale = MAJOR_SCALE[currentKeyName];

  gestureGuideEl.innerHTML = GESTURE_GUIDE
    .map(({ degree, gesture }) => `
      <div class="gesture-guide-row">
        <span class="gesture-guide-note">
          ${scale[degree - 1]}
        </span>

        <span class="gesture-guide-gesture">
          ${gesture}
        </span>
      </div>
    `)
    .join("");
}

// ---- Chord -> note frequencies ----
// Semitone offset of each scale degree from the tonic, in a major scale.
// This stays fixed -- what changes is which frequency counts as "0".
const DEGREE_SEMITONES = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9 ,7: -1};

const keySelectEl = document.getElementById("keySelect");

let currentTonicFreq = Number(keySelectEl.value);

let currentKeyName =
  keySelectEl.selectedOptions[0].dataset.note;

  updateGestureGuide();

  keySelectEl.addEventListener("change", () => {

  currentTonicFreq = Number(keySelectEl.value);

  currentKeyName =
    keySelectEl.selectedOptions[0].dataset.note;

  updateGestureGuide();

});

let currentInstrumentId = "warm-triangle";
let currentPlayMode = "chord";

function getDegreeFreq(degree) {
  const semitones = DEGREE_SEMITONES[degree];

  let tonic = currentTonicFreq;

  // Drop these keys one octave
  if (
    tonic === 369.99 || // Gb/F#
    tonic === 392.00 || // G
    tonic === 415.30    // Ab/G#
  ) {
    tonic /= 2;
  }

  return tonic * Math.pow(2, semitones / 12);
}

const NUMERAL_TO_DEGREE = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7
};



function getChordName(roman, isMajorMode) {

  if (!roman || roman === "--") {
    return "";
  }

  const degree =
    NUMERAL_TO_DEGREE[roman.toUpperCase()];

  if (!degree) {
    return "";
  }

  const root =
    MAJOR_SCALE[currentKeyName][degree - 1];


  return isMajorMode
    ? root
    : root + "m";

}


// Generate all fundamental raw intervals relative to the degree root
function getChordTones(numeralStr, isMajorMode) {
  if (!numeralStr || numeralStr === "--") return null;

  const degree = NUMERAL_TO_DEGREE[numeralStr.toUpperCase()];
  if (!degree) return null;

  const root = getDegreeFreq(degree); 

  // Define scale intervals using precise semitone adjustments
  const thirdSemitones = isMajorMode ? 4 : 3;
  const fifthSemitones = 7; // Fixed perfect 5th for modes 1, 2, 3

  // Extension semitones (11 for Major 7th, 10 for Dominant 7, 9 for Diminished 7)
  const maj7Semitones = 11;
  const dom7Semitones = 10;
  const dim7Semitones = 9;

  // Build the tone collection
  const third = root * Math.pow(2, thirdSemitones / 12);
  const fifth = root * Math.pow(2, fifthSemitones / 12);
  
  const octaveRoot = root * 2;
  const octaveThird = third * 2;

  // Special extension notes
  const maj7Tone = root * Math.pow(2, maj7Semitones / 12);
  const dom7Tone = root * Math.pow(2, dom7Semitones / 12);
  const dim7Tone = root * Math.pow(2, dim7Semitones / 12);

  // If left hand mode is minor, case 4 needs a diminished 5th (tritone) for the Diminished 7th chord
  const dim5Tone = root * Math.pow(2, 6 / 12);

  return { 
    root, third, fifth, octaveRoot, octaveThird, 
    maj7Tone, dom7Tone, dim7Tone, dim5Tone 
  };
}

// Map the 4 right-hand finger variations depending entirely on the left-hand tilt mode
function getSolidNotes(tones, rightHandCount, isMajorMode) {
  if (!tones) return [];
  
  const { 
    root, third, fifth, octaveRoot, octaveThird, 
    maj7Tone, dom7Tone, dim7Tone, dim5Tone 
  } = tones;

  if (isMajorMode) {
    switch (rightHandCount) {
      case 1: // Major chord (root, fifth, octave, octave third)
        return [root, fifth, octaveRoot, octaveThird];
      case 2: // 1st inversion (third, fifth, octave, octave third)
        return [third, fifth, octaveRoot, octaveThird];
      case 3: // Major 7th (root, third, fifth, maj7)
        return [root, third, fifth, maj7Tone];
      case 4: // Dominant 7th (root, third, fifth, dom7)
        return [root, third, fifth, dom7Tone];
      default: 
        return [root, fifth, octaveRoot, octaveThird];
    }
  } else {
    // Minor Mode Routing
    switch (rightHandCount) {
      case 1: // Minor chord (root, fifth, octave, octave minor third)
        return [root, fifth, octaveRoot, octaveThird];
      case 2: // 1st inversion (minor third, fifth, octave, octave minor third)
        return [third, fifth, octaveRoot, octaveThird];
      case 3: // Minor 7th (root, third, fifth, dom7)
        return [root, third, fifth, dom7Tone]; 
      case 4: // Diminished 7th (root, minor third, diminished fifth, dim7)
        return [root, third, dim5Tone, dim7Tone];
      default: 
        return [root, fifth, octaveRoot, octaveThird];
    }
  }
}

let hasPlayedFirstSound = false;
let lastTrackedChord = null;
let audioStarted = false;
let toastTimer = null;

const instrumentRegistry = new InstrumentRegistry();
const audioEngine = new AudioEngine(instrumentRegistry);
const loopStation = new LoopStation(audioEngine, {
  onChange: renderLoopUi,
  onStatus: showToast,
});

function showToast(message) {
  if (!message) return;
  toastEl.textContent = message;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 2400);
}

function instrumentOptions(selectedId) {
  const groups = new Map();
  for (const instrument of INSTRUMENT_DEFINITIONS) {
    if (!groups.has(instrument.group)) groups.set(instrument.group, []);
    groups.get(instrument.group).push(instrument);
  }
  return Array.from(groups.entries()).map(([group, instruments]) => `
    <optgroup label="${group}">
      ${instruments.map((instrument) => `
        <option value="${instrument.id}" ${instrument.id === selectedId ? "selected" : ""}>${instrument.label}</option>
      `).join("")}
    </optgroup>
  `).join("");
}

instrumentSelectEl.innerHTML = instrumentOptions(currentInstrumentId);

async function prepareInstrument(instrumentId, progressTarget = sampleLoadStatusEl) {
  if (!instrumentRegistry.isSampled(instrumentId)) return true;
  try {
    progressTarget.textContent = "Loading 0%";
    const loading = audioEngine.prepareInstrument(instrumentId, ({ ratio = 0 }) => {
      progressTarget.textContent = `Loading ${Math.round(ratio * 100)}%`;
    });
    renderLoopUi();
    await loading;
    progressTarget.textContent = "Ready";
    setTimeout(() => {
      if (progressTarget.textContent === "Ready") progressTarget.textContent = "";
    }, 1200);
    return true;
  } catch (error) {
    console.error(error);
    const detail = error?.message ? ` · ${error.message}` : "";
    progressTarget.textContent = "Load failed";
    showToast(`${instrumentRegistry.get(instrumentId).label}: sample load failed${detail}`);
    return false;
  }
}

instrumentSelectEl.addEventListener("change", async () => {
  const requested = instrumentSelectEl.value;
  const previous = currentInstrumentId;
  instrumentSelectEl.disabled = true;
  instrumentPreviewButtonEl.disabled = true;
  const ready = await prepareInstrument(requested);
  instrumentSelectEl.disabled = false;
  instrumentPreviewButtonEl.disabled = false;
  if (!ready) {
    instrumentSelectEl.value = previous;
    return;
  }
  currentInstrumentId = requested;
  audioEngine.stopLive();
  trackClarityEvent("instrument_changed");
});

instrumentPreviewButtonEl.addEventListener("click", async () => {
  instrumentPreviewButtonEl.disabled = true;
  try {
    if (!await prepareInstrument(currentInstrumentId)) return;
    if (!audioEngine.previewInstrument(currentInstrumentId)) showToast("Instrument is not ready");
  } finally {
    setTimeout(() => { instrumentPreviewButtonEl.disabled = false; }, 350);
  }
});

playModeSelectEl.addEventListener("change", () => {
  currentPlayMode = playModeSelectEl.value === "melody" ? "melody" : "chord";
  audioEngine.stopLive();
  trackClarityEvent("play_mode_changed");
});

function renderLoopUi(project = loopStation.project, state = loopStation.state) {
  bpmInputEl.value = project.bpm;
  meterSelectEl.value = project.meter;
  quantizeSelectEl.value = project.quantization;
  recordBarsInputEl.value = project.recordBars;
  metronomeToggleEl.checked = project.metronome;
  const recording = [LOOP_STATES.COUNT_IN, LOOP_STATES.RECORDING_FIRST, LOOP_STATES.RECORDING_TRACK].includes(state);
  const playing = [LOOP_STATES.PLAYING, LOOP_STATES.RECORDING_TRACK].includes(state);
  bpmInputEl.disabled = recording;
  meterSelectEl.disabled = Boolean(project.loopTicks) || recording;
  quantizeSelectEl.disabled = recording;
  recordBarsInputEl.disabled = Boolean(project.loopTicks) || recording;
  recordButtonEl.classList.toggle("active", recording);
  playButtonEl.classList.toggle("active", playing);
  playButtonEl.textContent = playing ? "❚❚ PAUSE" : "▶ PLAY";
  recordButtonEl.disabled = project.tracks.length >= MAX_TRACKS && state !== LOOP_STATES.RECORDING_FIRST;
  playButtonEl.disabled = !project.loopTicks;
  stopButtonEl.disabled = state === LOOP_STATES.IDLE || state === LOOP_STATES.STOPPED;
  undoButtonEl.disabled = !project.tracks.length;
  clearButtonEl.disabled = !project.tracks.length;
  const sampleError = project.tracks.some((track) => instrumentRegistry.getError(track.instrumentId));
  exportButtonEl.disabled = !project.tracks.length || sampleError;
  exportButtonEl.title = sampleError ? "Retry unavailable sample banks before export" : "Export loop as WAV";
  renderTracks(project);
}

function renderTracks(project) {
  trackCountEl.textContent = `${project.tracks.length} / ${MAX_TRACKS}`;
  trackPanelToggleEl.textContent = `Tracks ${project.tracks.length}/${MAX_TRACKS}`;
  if (!project.tracks.length) {
    trackListEl.innerHTML = '<div class="empty-tracks">Record your first loop to create a track.</div>';
    return;
  }
  trackListEl.innerHTML = "";
  project.tracks.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "track-row";
    const sampleStatus = instrumentRegistry.getStatus(track.instrumentId);
    const hasError = sampleStatus === "error";
    const statusLabel = sampleStatus === "loading" ? " · LOADING" : hasError ? " · ERROR" : "";
    row.innerHTML = `
      <div class="track-row-main">
        <div>
          <input class="track-name" maxlength="40" aria-label="Track ${index + 1} name">
          <div class="track-meta">${track.mode.toUpperCase()} · ${track.events.length} EVENTS${statusLabel}</div>
        </div>
        <span>${index + 1}</span>
      </div>
      <select class="track-instrument" aria-label="Instrument for ${track.name}">${instrumentOptions(track.instrumentId)}</select>
      <div class="track-controls">
        <input class="track-volume" type="range" min="0" max="1" step="0.01" value="${track.gain}" aria-label="Volume for ${track.name}">
        <button class="track-button mute ${track.muted ? "active" : ""}">M</button>
        <button class="track-button solo ${track.solo ? "active" : ""}">S</button>
        <button class="track-button delete" title="Delete track">✕</button>
      </div>
      ${hasError ? '<div class="track-warning">Samples unavailable <button class="track-button retry">Retry</button></div>' : ""}
    `;
    const nameInput = row.querySelector(".track-name");
    nameInput.value = track.name;
    nameInput.addEventListener("change", (event) => loopStation.updateTrack(track.id, { name: event.target.value }));
    row.querySelector(".track-volume").addEventListener("input", (event) => {
      loopStation.updateTrack(track.id, { gain: Number(event.target.value) });
    });
    row.querySelector(".mute").addEventListener("click", () => loopStation.updateTrack(track.id, { muted: !track.muted }));
    row.querySelector(".solo").addEventListener("click", () => loopStation.updateTrack(track.id, { solo: !track.solo }));
    row.querySelector(".delete").addEventListener("click", () => loopStation.deleteTrack(track.id));
    row.querySelector(".retry")?.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      const ready = await prepareInstrument(track.instrumentId, sampleLoadStatusEl);
      if (ready) renderLoopUi();
      else event.currentTarget.disabled = false;
    });
    row.querySelector(".track-instrument").addEventListener("change", async (event) => {
      const select = event.target;
      const requested = select.value;
      select.disabled = true;
      const ready = await prepareInstrument(requested, sampleLoadStatusEl);
      select.disabled = false;
      if (ready) loopStation.updateTrack(track.id, { instrumentId: requested });
      else select.value = track.instrumentId;
    });
    trackListEl.append(row);
  });
}

function selectedPerformanceConfig() {
  return { instrumentId: currentInstrumentId, mode: currentPlayMode };
}

recordButtonEl.addEventListener("click", async () => {
  if (!await prepareInstrument(currentInstrumentId)) return;
  loopStation.setRecordBars(recordBarsInputEl.value);
  loopStation.record(selectedPerformanceConfig());
  trackClarityEvent("loop_record");
});
playButtonEl.addEventListener("click", () => loopStation.togglePlay());
stopButtonEl.addEventListener("click", () => loopStation.stop());
undoButtonEl.addEventListener("click", () => loopStation.undoLastTrack());
clearButtonEl.addEventListener("click", async () => {
  if (window.confirm("Delete all loop tracks?")) await loopStation.clearAll();
});
exportButtonEl.addEventListener("click", async () => {
  exportButtonEl.disabled = true;
  try {
    exportButtonEl.textContent = "0%";
    const blob = await loopStation.exportWav(({ ratio = 0, phase }) => {
      exportButtonEl.textContent = phase === "encode" ? "WAV" : `${Math.round(ratio * 100)}%`;
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const bars = Math.round(loopStation.project.loopTicks / ticksPerBar(loopStation.project.meter));
    anchor.href = url;
    anchor.download = `gesture-synth-${loopStation.project.bpm}bpm-${Math.max(1, bars)}bars.wav`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("WAV exported");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Export failed");
  } finally {
    exportButtonEl.textContent = "WAV";
    renderLoopUi();
  }
});

bpmInputEl.addEventListener("change", () => loopStation.setBpm(bpmInputEl.value));
meterSelectEl.addEventListener("change", () => loopStation.setMeter(meterSelectEl.value));
quantizeSelectEl.addEventListener("change", () => loopStation.setQuantization(quantizeSelectEl.value));
recordBarsInputEl.addEventListener("change", () => loopStation.setRecordBars(recordBarsInputEl.value));
metronomeToggleEl.addEventListener("change", () => loopStation.setMetronome(metronomeToggleEl.checked));
trackPanelToggleEl.addEventListener("click", () => {
  const hidden = trackPanelEl.classList.toggle("hidden");
  trackPanelToggleEl.setAttribute("aria-expanded", String(!hidden));
});

document.addEventListener("keydown", async (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
  if (event.code === "Space") {
    event.preventDefault();
    loopStation.togglePlay();
  } else if (event.key.toLowerCase() === "r") {
    if (await prepareInstrument(currentInstrumentId)) {
      loopStation.setRecordBars(recordBarsInputEl.value);
      loopStation.record(selectedPerformanceConfig());
    }
  } else if (event.key.toLowerCase() === "s") {
    loopStation.stop();
  } else if (event.key.toLowerCase() === "u") {
    loopStation.undoLastTrack();
  } else if (event.key.toLowerCase() === "m") {
    loopStation.setMetronome(!loopStation.project.metronome);
  }
});

startOverlayEl.addEventListener("click", async () => {
  audioEngine.ensureContext();
  audioStarted = true;
  await loopStation.restore();
  startOverlayEl.style.display = "none";
  canvasEl.classList.remove("dimmed");
  for (const track of loopStation.project.tracks) {
    if (instrumentRegistry.isSampled(track.instrumentId)) {
      prepareInstrument(track.instrumentId).finally(() => renderLoopUi());
    }
  }
});

const TRANSPORT_LABELS = {
  [LOOP_STATES.IDLE]: "READY",
  [LOOP_STATES.COUNT_IN]: "COUNT IN",
  [LOOP_STATES.RECORDING_FIRST]: "REC FIRST",
  [LOOP_STATES.RECORDING_TRACK]: "OVERDUB",
  [LOOP_STATES.PLAYING]: "PLAYING",
  [LOOP_STATES.STOPPED]: "STOPPED",
};

function drawTimelineEvent(context, event, totalTicks, y, height, color, width) {
  const start = Math.max(0, Number(event.startTick) || 0);
  const duration = Math.max(1, Number(event.durationTicks) || 1);
  const x = 1 + (start / totalTicks) * (width - 2);
  const eventWidth = Math.max(3, (Math.min(duration, totalTicks) / totalTicks) * (width - 2));
  context.fillStyle = color;
  context.fillRect(x, y, Math.min(eventWidth, width - x - 1), height);
  const label = event.label || (event.midiNotes || []).join("+");
  if (label && eventWidth > 22) {
    context.save();
    context.beginPath();
    context.rect(x + 2, y, Math.max(0, eventWidth - 4), height);
    context.clip();
    context.fillStyle = "rgba(10, 10, 10, .88)";
    context.font = "10px monospace";
    context.fillText(label, x + 4, y + height - 4);
    context.restore();
  }
}

function drawRecordingTimeline(snapshot) {
  const visible = [LOOP_STATES.COUNT_IN, LOOP_STATES.RECORDING_FIRST, LOOP_STATES.RECORDING_TRACK].includes(snapshot.state);
  recordingTimelineEl.classList.toggle("hidden", !visible);
  if (!visible) return;

  const totalTicks = Math.max(1, snapshot.timelineTicks);
  const barTicks = ticksPerBar(loopStation.project.meter);
  const beatTicks = barTicks / ({ "3/4": 3, "4/4": 4, "6/8": 6 }[loopStation.project.meter] || 4);
  const bars = Math.max(1, Math.round(totalTicks / barTicks));
  const rect = recordingTimelineCanvasEl.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (recordingTimelineCanvasEl.width !== Math.round(width * dpr)
      || recordingTimelineCanvasEl.height !== Math.round(height * dpr)) {
    recordingTimelineCanvasEl.width = Math.round(width * dpr);
    recordingTimelineCanvasEl.height = Math.round(height * dpr);
  }
  recordingTimelineCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  recordingTimelineCtx.clearRect(0, 0, width, height);
  recordingTimelineCtx.fillStyle = "rgba(7, 7, 7, .88)";
  recordingTimelineCtx.fillRect(0, 0, width, height);

  for (let tick = 0; tick <= totalTicks; tick += beatTicks) {
    const x = Math.min(width - 1, Math.round((tick / totalTicks) * width) + .5);
    const isBar = tick % barTicks === 0;
    recordingTimelineCtx.strokeStyle = isBar ? "rgba(232,161,61,.55)" : "rgba(255,255,255,.12)";
    recordingTimelineCtx.lineWidth = isBar ? 1.5 : 1;
    recordingTimelineCtx.beginPath();
    recordingTimelineCtx.moveTo(x, isBar ? 0 : 15);
    recordingTimelineCtx.lineTo(x, height);
    recordingTimelineCtx.stroke();
    if (isBar && tick < totalTicks) {
      recordingTimelineCtx.fillStyle = "rgba(255,255,255,.48)";
      recordingTimelineCtx.font = "9px monospace";
      recordingTimelineCtx.fillText(String(Math.floor(tick / barTicks) + 1), x + 3, 10);
    }
  }

  for (const track of loopStation.project.tracks) {
    for (const event of track.events) {
      drawTimelineEvent(recordingTimelineCtx, event, totalTicks, 20, 18, "rgba(232,161,61,.34)", width);
    }
  }
  for (const event of snapshot.previewEvents) {
    drawTimelineEvent(recordingTimelineCtx, event, totalTicks, 47, 23, "rgba(255,107,95,.82)", width);
  }

  const playheadX = Math.min(width - 1, Math.max(0, (snapshot.currentTick / totalTicks) * width));
  recordingTimelineCtx.strokeStyle = "#fff";
  recordingTimelineCtx.lineWidth = 2;
  recordingTimelineCtx.beginPath();
  recordingTimelineCtx.moveTo(playheadX, 0);
  recordingTimelineCtx.lineTo(playheadX, height);
  recordingTimelineCtx.stroke();

  const mode = snapshot.state === LOOP_STATES.COUNT_IN
    ? "COUNT IN"
    : snapshot.state === LOOP_STATES.RECORDING_TRACK ? "OVERDUB" : "FIRST TAKE";
  timelineTitleEl.textContent = `${mode} · ${bars} BAR${bars === 1 ? "" : "S"}`;
  timelineChordEl.textContent = snapshot.previewEvents.at(-1)?.label || "—";
}

function updateTransportFrame() {
  if (audioStarted) {
    loopStation.update(audioEngine.currentTime);
    const snapshot = loopStation.getSnapshot(audioEngine.currentTime);
    transportStatusEl.textContent = snapshot.state === LOOP_STATES.COUNT_IN && snapshot.countIn
      ? `COUNT ${snapshot.countIn}`
      : TRANSPORT_LABELS[snapshot.state] || snapshot.state;
    loopPositionEl.textContent = `${snapshot.bar} · ${snapshot.beat}`;
    loopProgressEl.style.setProperty("--progress", snapshot.progress.toFixed(4));
    masterMeterFillEl.style.height = `${Math.round(audioEngine.getMasterLevel() * 100)}%`;
    drawRecordingTimeline(snapshot);
  }
  requestAnimationFrame(updateTransportFrame);
}

requestAnimationFrame(updateTransportFrame);

guideToggleEl.addEventListener("click", () => {
  const isHidden = gestureGuideEl.classList.toggle("hidden");

  if (!isHidden) {
    trackClarityEvent("guide_opened");
  }

  guideToggleEl.textContent = isHidden ? "Open Guide" : "Close Guide";
});

helpButton.addEventListener("click", () => {
  trackClarityEvent("help_opened");
  helpModal.classList.remove("hidden");
});

closeHelp.addEventListener("click", (e) => {
  e.stopPropagation();
  helpModal.classList.add("hidden");
});

// Optional: click outside the card to close
helpModal.addEventListener("click", (e) => {
  if (e.target === helpModal) {
    helpModal.classList.add("hidden");
  }
});

// Computes a "cover" crop rect in source-video pixel space: the largest
// centered rectangle matching the destination's aspect ratio, so the
// video fills the screen (height fit, width cropped) with zero stretch.
function computeCoverRect(srcW, srcH, dstW, dstH) {
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;

  if (srcRatio > dstRatio) {
    const sHeight = srcH;
    const sWidth = srcH * dstRatio;
    return { sx: (srcW - sWidth) / 2, sy: 0, sWidth, sHeight };
  } else {
    const sWidth = srcW;
    const sHeight = srcW / dstRatio;
    return { sx: 0, sy: (srcH - sHeight) / 2, sWidth, sHeight };
  }
}

function drawFrame(results, canvasWidth, canvasHeight) {
  const srcW = videoEl.videoWidth;
  const srcH = videoEl.videoHeight;
  if (!srcW || !srcH) return;

  const { sx, sy, sWidth, sHeight } = computeCoverRect(srcW, srcH, canvasWidth, canvasHeight);

  ctx.save();
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.translate(canvasWidth, 0);
  ctx.scale(-1, 1);

  ctx.drawImage(videoEl, sx, sy, sWidth, sHeight, 0, 0, canvasWidth, canvasHeight);

  ctx.fillStyle = "#ffffff80";
  for (const landmarks of results.landmarks) {
    for (const point of landmarks) {
      const videoPx = point.x * srcW;
      const videoPy = point.y * srcH;
      const canvasX = ((videoPx - sx) / sWidth) * canvasWidth;
      const canvasY = ((videoPy - sy) / sHeight) * canvasHeight;

      ctx.beginPath();
      ctx.arc(canvasX, canvasY, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---- Main loop ----
function resizeCanvas() {
  canvasEl.width = window.innerWidth;
  canvasEl.height = window.innerHeight;
}

async function main() {
  await setupCamera();
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  const handLandmarker = await setupHandLandmarker();

  let lastVideoTime = -1;
  
  // Persistent structural cache to keep landmark data accessible across high-speed ticks
  let cachedLeftLandmarks = null;
  let cachedRightLandmarks = null;

  function loop() {
  const timestampNow = performance.now();

  // ============================
  // 1. UPDATE MEDIAPIPE FRAME
  // ============================

  if (videoEl.currentTime !== lastVideoTime) {
    lastVideoTime = videoEl.currentTime;

    const results = handLandmarker.detectForVideo(videoEl, timestampNow);

    drawFrame(
      results,
      canvasEl.width,
      canvasEl.height
    );

    cachedLeftLandmarks = null;
    cachedRightLandmarks = null;

    results.landmarks.forEach((landmarks, i) => {
      const handedness = results.handedness[i][0].categoryName;

      if (handedness === "Left") {
        cachedLeftLandmarks = landmarks;
      }

      if (handedness === "Right") {
        cachedRightLandmarks = landmarks;
      }
    });
  }


  // ============================
  // 2. RAW GESTURE STATES
  // ============================

  let currentChord = null;
  let isMajorMode = true;

  let qualityIndex = 0;
  let thumbDown = false;


  let rawChordState = null;


  // ============================
// BUILD MUSICAL CHORD STATE
// ============================

let rawChord = null;
let rawMode = true;
let rawQualityIndex = 0;
let rawThumbDown = false;


// LEFT HAND = ROOT CHORD

if (cachedLeftLandmarks) {

  const leftTilt =
    getHandHorizontalTilt(
      cachedLeftLandmarks,
      "Left"
    );


  rawChord =
    classifyChord(
      cachedLeftLandmarks,
      "Left"
    );


  rawMode =
    leftTilt >= 0;

}


// RIGHT HAND = VOICING

if (cachedRightLandmarks) {

  rawQualityIndex =
    getRightHandQualityIndex(
      cachedRightLandmarks
    );


  rawThumbDown =
    isThumbExtended(
      cachedRightLandmarks,
      "Right"
    );

}


// Combine into ONE musical object

if (rawChord) {

  rawChordState = {

    chord: rawChord,

    isMajorMode: rawMode,

    qualityIndex: rawQualityIndex,

    thumbDown: rawThumbDown

  };

}


  // ============================
  // 3. STABILIZE HANDS
  // ============================

  const stableChordState =
  stabilizeChordState(
    rawChordState,
    timestampNow
  );


  if (stableChordState) {

  currentChord =
    stableChordState.chord;


  isMajorMode =
    stableChordState.isMajorMode;


  qualityIndex =
    stableChordState.qualityIndex;


  thumbDown =
    stableChordState.thumbDown;

}


  // ============================
  // 4. UI UPDATE
  // ============================

  if (currentChord) {
  const chordName =
    getChordName(
      currentChord,
      isMajorMode
    );

  chordDisplayEl.textContent =
    `${chordName}(${currentChord})`;
  } else {
    chordDisplayEl.textContent = "--";
  }


  const MAJOR_LABELS = {
    1: "Major",
    2: "Major 1st Inv",
    3: "Major 7th",
    4: "Dominant 7th"
  };


  const MINOR_LABELS = {
    1: "Minor",
    2: "Minor 1st Inv",
    3: "Minor 7th",
    4: "Diminished 7th"
  };


  const activeLabel = currentPlayMode === "melody"
    ? (qualityIndex >= 1 ? "Melody Note" : null)
    : (isMajorMode ? MAJOR_LABELS[qualityIndex] : MINOR_LABELS[qualityIndex]);


  qualityDisplayEl.textContent =
    activeLabel
      ? `${activeLabel}${thumbDown ? " (-8ve)" : ""}`
      : "--";



  // ============================
  // 5. AUDIO ENGINE
  // ============================
  let currentVolume = 0;
  let horizontalTilt = 0;
  if (cachedRightLandmarks) {
    currentVolume = getVolumeFromHeight(cachedRightLandmarks);
    horizontalTilt = getHandHorizontalTilt(cachedRightLandmarks, "Right");
  }
  updateVolumeMeter(currentVolume);
  const tiltPercentage = Math.round(horizontalTilt * 100);
  const targetEl = document.getElementById("distortionDisplay");
  if (targetEl) targetEl.textContent = `Filter: ${tiltPercentage > 0 ? "+" : ""}${tiltPercentage}%`;

  const performanceState = {
    mode: currentPlayMode,
    instrumentId: currentInstrumentId,
    midiNotes: [],
    gate: false,
    volume: currentVolume,
    filter: horizontalTilt,
    label: "",
  };

  if (cachedRightLandmarks && currentChord && qualityIndex >= 1) {
    let frequencies = [];
    if (currentPlayMode === "melody") {
      const degree = NUMERAL_TO_DEGREE[currentChord.toUpperCase()];
      if (degree) frequencies = [getDegreeFreq(degree)];
    } else {
      const tones = getChordTones(currentChord, isMajorMode);
      frequencies = getSolidNotes(tones, qualityIndex, isMajorMode);
    }
    if (thumbDown) frequencies = frequencies.map((frequency) => frequency / 2);
    performanceState.midiNotes = frequencies.map(frequencyToMidi);
    performanceState.gate = performanceState.midiNotes.length > 0;
    performanceState.label = currentPlayMode === "melody"
      ? getChordName(currentChord, true)
      : getChordName(currentChord, isMajorMode);

    const trackingKey = `${currentPlayMode}-${currentChord}-${isMajorMode}-${qualityIndex}-${thumbDown}`;
    if (trackingKey !== lastTrackedChord) {
      lastTrackedChord = trackingKey;
      trackClarityEvent(currentPlayMode === "melody" ? "note_changed" : "chord_changed");
    }
  }

  if (audioStarted) {
    if (performanceState.gate && !hasPlayedFirstSound) {
      hasPlayedFirstSound = true;
      trackClarityEvent("first_sound");
    }
    audioEngine.updateLive(performanceState);
    loopStation.ingestPerformanceState(performanceState, audioEngine.currentTime);
  }



  // ============================
  // 6. VISUAL ENERGY
  // ============================

  const volume =
    cachedRightLandmarks
      ? getVolumeFromHeight(
          cachedRightLandmarks
        )
      : 0;


  const tilt =
    cachedRightLandmarks
      ? getHandHorizontalTilt(
          cachedRightLandmarks,
          "Right"
        )
      : 0;


  drawEnergy(
    ctx,
    volume,
    qualityIndex,
    tilt,
    currentChord
  );


  requestAnimationFrame(loop);
}
  
  loop();
}

main().catch((err) => console.error(err));
