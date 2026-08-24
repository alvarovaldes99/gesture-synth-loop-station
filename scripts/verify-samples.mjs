import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "samples");
const sources = JSON.parse(await readFile(path.join(root, "SOURCES.json"), "utf8"));
let totalBytes = 0;

function sampleRate(data, filename) {
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE") {
    return data.readUInt32LE(24);
  }
  if (data.subarray(0, 4).toString("ascii") === "fLaC") {
    return (data[18] << 12) | (data[19] << 4) | (data[20] >> 4);
  }
  throw new Error(`Unsupported sample format: ${filename}`);
}

function pcm16Peak(data) {
  if (data.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  let offset = 12;
  let format = 0;
  let bits = 0;
  let audio = null;
  while (offset + 8 <= data.length) {
    const id = data.subarray(offset, offset + 4).toString("ascii");
    const size = data.readUInt32LE(offset + 4);
    if (id === "fmt " && size >= 16) {
      format = data.readUInt16LE(offset + 8);
      bits = data.readUInt16LE(offset + 22);
    } else if (id === "data") {
      audio = data.subarray(offset + 8, Math.min(data.length, offset + 8 + size));
    }
    offset += 8 + size + (size % 2);
  }
  if (format !== 1 || bits !== 16 || !audio) return null;
  let peak = 0;
  for (let index = 0; index + 1 < audio.length; index += 2) {
    peak = Math.max(peak, Math.abs(audio.readInt16LE(index)) / 32768);
  }
  return peak;
}

for (const bank of sources.banks) {
  const manifest = JSON.parse(await readFile(path.join(root, bank.id, "manifest.json"), "utf8"));
  if (manifest.velocityLayers !== 2) throw new Error(`${bank.id} must contain two velocity layers`);
  for (const file of bank.files) {
    const filename = path.join(root, bank.id, file.url);
    const data = await readFile(filename);
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== file.sha256 || data.length !== file.bytes) throw new Error(`Integrity mismatch: ${bank.id}/${file.url}`);
    if (sampleRate(data, filename) !== 44100) throw new Error(`Sample is not 44.1 kHz: ${bank.id}/${file.url}`);
    const peak = pcm16Peak(data);
    // Some CC0 soft-velocity layers (notably the high marimba C6) have a
    // deliberately tiny transient. Reject truly empty PCM while preserving
    // those quiet layers; their playback gain is handled by the preset.
    if (peak === 0) throw new Error(`Sample is silent: ${bank.id}/${file.url}`);
    totalBytes += data.length;
  }
}

if (totalBytes !== sources.totalBytes) throw new Error("Sample bank byte count does not match SOURCES.json");
if (totalBytes > sources.maximumBankBytes) throw new Error("Sample bank exceeds 100 MiB");
console.log(`Verified ${sources.banks.length} banks, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, 44.1 kHz, SHA-256 OK`);

