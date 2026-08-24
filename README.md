# Gesture Synth

A camera-based musical instrument that lets you control chords, tone, and expression using hand gestures.

## Demo

🎥 Watch the Gesture Synth tutorial on Instagram:
https://www.instagram.com/p/DbH1BACxNCG/

## Features

- Left hand selects a chord or scale degree; right hand controls gate, voicing, volume, filter and octave.
- Chord and Melody performance modes.
- Eleven instruments: seven synthesized presets and four local CC0 multisampled instruments.
- Eight-track loop station with count-in, 96 PPQ clock, quantization, overdubbing, mute/solo, editable instruments and track names.
- 3/4, 4/4 and 6/8 meters, metronome, keyboard shortcuts and 40–240 BPM tempo.
- IndexedDB autosave and stereo 44.1 kHz PCM16 WAV export.
- Real-time hand tracking with MediaPipe and independent Live/Loop Web Audio buses.

## Loop workflow

Press **REC** for a one-bar count-in. On the first take, press **STOP** to close at the next bar; this sets the loop to 1–16 bars. Every later REC creates a new track and records exactly one cycle. Shortcuts are Space, R, S, U and M.

Sampled instruments load only when selected. If a bank fails, retry it from the track panel before exporting.

## Development

```bash
npm install
npm run fetch:samples
npm run dev
npm test
npm run check:samples
npm run build
```

The browser integration harness is available at `/test/browser.html` while the dev server is running.

## GitHub Pages

Push the project to a repository whose default branch is `main`. The included GitHub Actions workflow runs the tests, verifies the sample bank, builds with the correct repository base path and deploys `dist` to Pages. Camera access works from the resulting HTTPS URL.

## Sample provenance

The generated 44.1 kHz local bank is 45.3 MiB. Piano, marimba and glockenspiel come from VCSL; strings come from VSCO 2 CE. Both source libraries use CC0. `npm run fetch:samples` reconstructs it from fixed revisions and writes exact sizes and SHA-256 hashes to `public/samples/SOURCES.json`.

## Built With
- JavaScript
- MediaPipe Hand Landmarker
- Web Audio API
- Vite

## License
Gesture Synth is free to use, modify, and share for educational and non-commercial purposes.
If you build upon this project, please credit the original creator.

