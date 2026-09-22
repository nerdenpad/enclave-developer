import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node scripts/export-demo.mjs <recording-directory> <output.mp4>");
const folder = path.resolve(source);
const output = path.resolve(destination);
const verification = JSON.parse(readFileSync(path.join(folder, "verification.json"), "utf8"));
if (!verification.passed || verification.pageErrors.length || !verification.liveProviderRequests) {
  throw new Error("Only a successful, verified live browser recording may be exported.");
}
if (path.extname(output).toLowerCase() !== ".mp4") throw new Error("The output must be an MP4 file.");
if (existsSync(output)) throw new Error("Output already exists; choose a new filename.");
mkdirSync(path.dirname(output), { recursive: true });
const assTime = (seconds) => {
  const total = Math.floor(seconds * 100);
  return `${Math.floor(total / 360000)}:${String(Math.floor(total / 6000) % 60).padStart(2, "0")}:${String(Math.floor(total / 100) % 60).padStart(2, "0")}.${String(total % 100).padStart(2, "0")}`;
};
const safe = (text) => String(text).replace(/[{}\\\r\n]/g, " ");
const wrap = (text, width = 115) => {
  const lines = [""];
  for (const word of safe(text).split(/\s+/)) {
    if (lines.at(-1).length + word.length + 1 > width) lines.push(word);
    else lines[lines.length - 1] += `${lines.at(-1) ? " " : ""}${word}`;
  }
  return lines.join("\\N");
};
const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1600
PlayResY: 1120
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,21,&H00FFFFFF,&H00FFFFFF,&H00292019,&H00292019,0,0,0,0,100,100,0,0,1,0,0,2,60,60,18,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
const cues = verification.scenes.map((scene, index) => {
  const end = verification.scenes[index + 1]?.seconds ?? verification.durationSeconds;
  return `Dialogue: 0,${assTime(scene.seconds)},${assTime(end)},Default,,0,0,0,,{\\b1\\fs25}${safe(scene.title)}{\\b0\\fs21}\\N${wrap(scene.detail)}`;
});
writeFileSync(path.join(folder, "captions.ass"), header + cues.join("\n") + "\n");
const result = spawnSync(ffmpeg, [
  "-hide_banner", "-loglevel", "warning", "-nostdin",
  "-i", path.join(folder, "Enclave-Demo.webm"),
  "-vf", "pad=1600:1120:0:0:color=0x192029,ass=captions.ass",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18",
  "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", "-an", output,
], { cwd: folder, encoding: "utf8", windowsHide: true });
if (result.status !== 0) throw new Error(result.stderr || "Video export failed.");
console.log(JSON.stringify({ output, captions: verification.scenes.length, durationSeconds: verification.durationSeconds }));
