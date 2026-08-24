import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleRoot = path.join(projectRoot, "public", "samples");
const sourcesPath = path.join(sampleRoot, "SOURCES.json");
const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

const probe = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" });
if (probe.status !== 0) throw new Error("ffmpeg is required to create iOS-compatible sample banks");

let totalBytes = 0;
for (const bank of sources.banks) {
  const bankDirectory = path.join(sampleRoot, bank.id);
  const manifestPath = path.join(bankDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sourceFiles = bank.sourceFiles || bank.files;
  const files = [];
  const samples = [];

  for (const sample of manifest.samples) {
    const sourceUrl = sample.url;
    const inputPath = path.join(bankDirectory, sourceUrl);
    const outputUrl = sourceUrl.replace(/\.[^.]+$/i, ".wav");
    const outputPath = path.join(bankDirectory, outputUrl);
    const temporaryPath = `${outputPath}.browser.wav`;
    const conversion = spawnSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-map_metadata", "-1",
      "-ac", "1",
      "-ar", "44100",
      "-c:a", "pcm_s16le",
      temporaryPath,
    ], { stdio: "inherit" });
    if (conversion.status !== 0) throw new Error(`Unable to optimize ${bank.id}/${sourceUrl}`);

    if (inputPath === outputPath) await rm(inputPath);
    else await rm(inputPath, { force: true });
    await rename(temporaryPath, outputPath);
    const data = await readFile(outputPath);
    const file = {
      ...sample,
      url: outputUrl,
      derivedFrom: sourceUrl,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    files.push(file);
    samples.push({
      note: sample.note,
      velocity: sample.velocity,
      url: outputUrl,
      derivedFrom: sourceUrl,
    });
    totalBytes += data.length;
  }

  manifest.samples = samples;
  manifest.audioFormat = "WAV PCM 16-bit mono";
  manifest.processing = "ffmpeg: 44.1 kHz, mono, pcm_s16le, metadata removed";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  bank.sourceFiles = sourceFiles;
  bank.files = files;
  bank.bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  bank.processing = manifest.processing;
}

if (totalBytes > sources.maximumBankBytes) throw new Error("Optimized sample bank exceeds 100 MiB");
sources.totalBytes = totalBytes;
sources.browserFormat = "WAV PCM 16-bit mono";
sources.optimizedAt = new Date().toISOString();
await writeFile(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
console.log(`iOS-compatible sample bank ready: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);
