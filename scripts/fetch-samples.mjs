import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleRoot = path.join(projectRoot, "public", "samples");
const vcsRevision = "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e";
const vscoRevision = "440300901dfe9275fd84e0b7763af1f8443ae62e";
const keysRevision = "VCSL_Keys.zip; Last-Modified 2023-10-11; ETag 271028eb-6076d72b82908";

const banks = [
  {
    id: "acoustic-piano",
    title: "Acoustic Piano",
    source: "VCSL Keys — Grand Piano, K",
    sourceUrl: "https://versilian-studios.com/vcsl-keys/",
    revision: keysRevision,
    license: "CC0-1.0",
    samples: ["C2", "C3", "C4", "C5", "C6"].flatMap((note) => [
      { note: noteToMidi(note), velocity: 0.35, url: `GPiano_sus_${note}_v1_rr1_Player.flac` },
      { note: noteToMidi(note), velocity: 0.92, url: `GPiano_sus_${note}_v4_rr1_Player.flac` },
    ]),
  },
  {
    id: "string-ensemble",
    title: "String Ensemble",
    source: "VSCO 2 CE — Violin Section susVib",
    sourceUrl: "https://github.com/sgossner/VSCO-2-CE/tree/master/Strings/Violin%20Section/susVib",
    revision: vscoRevision,
    license: "CC0-1.0",
    remote: { repo: "VSCO-2-CE", revision: vscoRevision, directory: "Strings/Violin Section/susVib" },
    samples: ["G2", "D3", "C4", "G4", "D5"].flatMap((note) => [
      { note: noteToMidi(note), velocity: 0.36, url: `VlnEns_susVib_${note}_v1.wav` },
      { note: noteToMidi(note), velocity: 0.9, url: `VlnEns_susVib_${note}_v2.wav` },
    ]),
  },
  {
    id: "marimba",
    title: "Marimba",
    source: "VCSL — Marimba Outrigger hits",
    sourceUrl: "https://github.com/sgossner/VCSL/tree/master/Idiophones/Struck%20Idiophones/Marimba",
    revision: vcsRevision,
    license: "CC0-1.0",
    remote: { repo: "VCSL", revision: vcsRevision, directory: "Idiophones/Struck Idiophones/Marimba" },
    samples: ["C2", "G2", "C4", "G4", "C6"].flatMap((note) => [
      { note: noteToMidi(note), velocity: 0.34, url: `Marimba_hit_Outrigger_${note}_soft_01.wav` },
      { note: noteToMidi(note), velocity: 0.92, url: `Marimba_hit_Outrigger_${note}_loud_01.wav` },
    ]),
  },
  {
    id: "glockenspiel",
    title: "Glockenspiel",
    source: "VCSL — Glockenspiel hits",
    sourceUrl: "https://github.com/sgossner/VCSL/tree/master/Idiophones/Struck%20Idiophones/Glockenspiel",
    revision: vcsRevision,
    license: "CC0-1.0",
    remote: { repo: "VCSL", revision: vcsRevision, directory: "Idiophones/Struck Idiophones/Glockenspiel" },
    samples: ["G4", "C5", "G5", "C6", "G6", "C7"].flatMap((note) => [
      { note: noteToMidi(note), velocity: 0.34, url: `glock_soft_${note}_${note === "C5" ? "02" : note === "C7" ? "03" : "01"}.wav` },
      { note: noteToMidi(note), velocity: 0.82, url: `glock_medium_${note}_01.wav` },
    ]),
  },
];

function noteToMidi(note) {
  const match = /^([A-G])(#?)(-?\d+)$/.exec(note);
  if (!match) throw new Error(`Invalid note ${note}`);
  const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (Number(match[3]) + 1) * 12 + semitones[match[1]] + (match[2] ? 1 : 0);
}

function rawUrl(remote, filename) {
  const encodedPath = `${remote.directory}/${filename}`.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/sgossner/${remote.repo}/${remote.revision}/${encodedPath}`;
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function hashFile(filename) {
  const data = await readFile(filename);
  return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

const sourceRecord = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sampleRate: 44100,
  maximumBankBytes: 100 * 1024 * 1024,
  banks: [],
};
let totalBytes = 0;

for (const bank of banks) {
  const bankDirectory = path.join(sampleRoot, bank.id);
  await mkdir(bankDirectory, { recursive: true });
  const files = [];
  for (const sample of bank.samples) {
    const destination = path.join(bankDirectory, sample.url);
    if (!await exists(destination)) {
      if (!bank.remote) throw new Error(`Missing ${sample.url}; extract the VCSL Keys subset first (see public/samples/README.md)`);
      const url = rawUrl(bank.remote, sample.url);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
      await writeFile(destination, Buffer.from(await response.arrayBuffer()));
      console.log(`Downloaded ${bank.id}/${sample.url}`);
    }
    const integrity = await hashFile(destination);
    totalBytes += integrity.bytes;
    files.push({ ...sample, ...integrity });
  }

  await writeFile(path.join(bankDirectory, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: bank.id,
    title: bank.title,
    sampleRate: 44100,
    velocityLayers: 2,
    source: bank.source,
    sourceUrl: bank.sourceUrl,
    revision: bank.revision,
    license: bank.license,
    samples: bank.samples,
  }, null, 2)}\n`);
  sourceRecord.banks.push({
    id: bank.id,
    source: bank.source,
    sourceUrl: bank.sourceUrl,
    revision: bank.revision,
    license: bank.license,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  });
}

if (totalBytes > sourceRecord.maximumBankBytes) {
  throw new Error(`Sample bank is ${(totalBytes / 1024 / 1024).toFixed(1)} MiB; maximum is 100 MiB`);
}
sourceRecord.totalBytes = totalBytes;
await writeFile(path.join(sampleRoot, "SOURCES.json"), `${JSON.stringify(sourceRecord, null, 2)}\n`);
console.log(`Sample bank ready: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);

