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

for (const bank of sources.banks) {
  const manifest = JSON.parse(await readFile(path.join(root, bank.id, "manifest.json"), "utf8"));
  if (manifest.velocityLayers !== 2) throw new Error(`${bank.id} must contain two velocity layers`);
  for (const file of bank.files) {
    const filename = path.join(root, bank.id, file.url);
    const data = await readFile(filename);
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== file.sha256 || data.length !== file.bytes) throw new Error(`Integrity mismatch: ${bank.id}/${file.url}`);
    if (sampleRate(data, filename) !== 44100) throw new Error(`Sample is not 44.1 kHz: ${bank.id}/${file.url}`);
    totalBytes += data.length;
  }
}

if (totalBytes !== sources.totalBytes) throw new Error("Sample bank byte count does not match SOURCES.json");
if (totalBytes > sources.maximumBankBytes) throw new Error("Sample bank exceeds 100 MiB");
console.log(`Verified ${sources.banks.length} banks, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, 44.1 kHz, SHA-256 OK`);

