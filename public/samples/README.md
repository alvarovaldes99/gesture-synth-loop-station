# Gesture Synth sample bank

This local bank uses two velocity layers and spaced multisamples. Runtime playback never depends on a CDN.

- Acoustic Piano: VCSL Keys, Grand Piano “K” (CC0).
- Marimba and Glockenspiel: VCSL (CC0).
- String Ensemble: VSCO 2 CE, Violin Section `susVib` (CC0).

`SOURCES.json` records the source revision, byte size and SHA-256 hash of every distributed sample. The complete bank must remain below 100 MiB and at 44.1 kHz.

To rebuild the bank, first extract the piano subset without downloading the complete VCSL Keys archive:

```powershell
node scripts/remote-zip.mjs https://versilian-studios.com/Distro/VCSL_Keys.zip extract '^Grand Piano, K/Sustains/GPiano_sus_(C2|C3|C4|C5|C6)_v(1|4)_rr1_Player\.flac$' public/samples/acoustic-piano
node scripts/fetch-samples.mjs
```

The source libraries are public domain under CC0; provenance is retained here for auditability.

