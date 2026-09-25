import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';

export function exportSimulation(directory, filename = 'Enclave-Simulation-FullHD.mp4') {
  const output = path.resolve(directory);
  if (path.basename(filename) !== filename || !filename.endsWith('.mp4') || existsSync(path.join(output, filename))) throw Error('Choose a new MP4 filename.');
  const v = JSON.parse(readFileSync(path.join(output, 'verification.json'), 'utf8'));
  if (!v.passed || v.mode !== 'simulation' || v.provider !== 'echo' || v.chainId !== 31337 || v.paymentMode !== 'mock' || v.realUsdcSpent !== 0 || v.gpuInferenceCalls !== 0 || v.errors.length) throw Error('Only a successful local simulation may be exported.');
  const { scenes, durationSeconds } = v;
  // Initial Chromium screencast frames may precede the requested viewport size.
  // Start at the connected workspace, after layout and capture have settled.
  const trimStart = scenes.find(s => s.title === 'Connected to the local backend')?.seconds;
  if (!Number.isFinite(trimStart) || trimStart <= 0 || trimStart >= durationSeconds) throw Error('Missing stable workspace scene.');
  const time = seconds => { const n=Math.floor(seconds*100); return `${Math.floor(n/360000)}:${String(Math.floor(n/6000)%60).padStart(2,'0')}:${String(Math.floor(n/100)%60).padStart(2,'0')}.${String(n%100).padStart(2,'0')}`; };
  const safe = s => s.replace(/[{}\\\r\n]/g, ' ');
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,25,&H00FFFFFF,&H00FFFFFF,&H00292019,&H00292019,0,0,0,0,100,100,0,0,1,0,0,2,70,70,26,1\nStyle: Disclosure,Arial,23,&H005BCCFF,&H005BCCFF,&H00292019,&H00292019,-1,0,0,0,100,100,0,0,3,10,0,8,40,40,12,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const cues = scenes.flatMap((s,i) => {
    const end = scenes[i+1]?.seconds ?? durationSeconds;
    if (end <= trimStart) return [];
    return [`Dialogue: 0,${time(Math.max(0, s.seconds-trimStart))},${time(end-trimStart)},Default,,0,0,0,,{\\an2\\pos(960,1054)\\b1\\fs30}${safe(s.title)}{\\b0\\fs25}\\N${safe(s.detail)}`];
  });
  // Always visible, including scene changes and UI waits. Cannot export without it.
  cues.push(`Dialogue: 1,0:00:00.00,${time(durationSeconds-trimStart+10)},Disclosure,,0,0,0,,{\\an8\\pos(960,12)}SIMULATION | No GPU inference | Test tokens only | Local chain 31337`);
  writeFileSync(path.join(output, 'captions-fullhd.ass'), header+cues.join('\n'));
  const result = spawnSync(ffmpeg, ['-hide_banner','-loglevel','warning','-nostdin','-i','source.webm','-vf',`trim=start=${trimStart}:end=${durationSeconds},setpts=PTS-STARTPTS,pad=1920:1080:0:50:color=0x192029,ass=captions-fullhd.ass`,'-c:v','libx264','-preset','medium','-crf','19','-pix_fmt','yuv420p','-r','30','-movflags','+faststart','-an',filename], { cwd: output, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error(result.stderr || 'Video export failed.');
  writeFileSync(path.join(output, 'fullhd-export.json'), JSON.stringify({ source: 'source.webm', trimStart, trimEnd: durationSeconds, width: 1920, height: 1080, filename }, null, 2));
  return path.join(output, filename);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node export-simulation.mjs <recording-directory>');
  console.log(JSON.stringify({ output: exportSimulation(process.argv[2]) }));
}
