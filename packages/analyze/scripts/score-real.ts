import { whisperOptionsFromEnv } from '../src/whisper.js';
import { formatReal, realTargetsMet, runReal, type WhisperStats } from './real.js';

/**
 * Phase 0 on real speech (fixtures/real): `npm run score:real` transcribes with the local
 * whisper provider; `-- --truth` uses the recordings' ground-truth transcript instead, which
 * separates decider errors from transcription errors. `--only <regex>`, `--verbose`.
 */
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const truth = args.includes('--truth');
const o = args.indexOf('--only');
const stats: WhisperStats = { files: 0, cached: 0, audioSec: 0, wallSec: 0, cpuSec: 0 };
const rs = await runReal({ transcriber: truth ? 'truth' : 'whisper', stats, ...(o >= 0 ? { only: new RegExp(args[o + 1] ?? '') } : {}) });
const label = truth
  ? 'ground truth (the forced-aligner words embedded in each recording, read by the fixture transcriber)'
  : `whisper (${process.env.KILO_WHISPER_MODEL || 'base.en'}, local CPU${process.env.KILO_WHISPER_ALIGN === 'none' ? '' : ', CTC check'})`;
console.log(formatReal(rs, label, verbose));
if (!truth) {
  const speed = stats.audioSec ? ` Transcribed ${stats.audioSec.toFixed(1)} s of audio in ${stats.wallSec.toFixed(1)} s (${(stats.wallSec / stats.audioSec).toFixed(3)} s per audio second, model load included; ${((stats.cpuSec ?? 0) / stats.audioSec).toFixed(3)} CPU s per audio second, all threads, load excluded; ${whisperOptionsFromEnv().threads} threads).` : '';
  const all = stats.allAudioSec ? ` In all, as recorded when each was transcribed: ${((stats.allCpuSec ?? 0) / stats.allAudioSec).toFixed(3)} CPU s per audio second over ${stats.allAudioSec.toFixed(0)} s, second looks included.` : '';
  const ctc = stats.allAudioSec && stats.ctcCpuSec ? ` CTC check (KILO_WHISPER_ALIGN=ctc): ${(stats.ctcCpuSec / stats.allAudioSec).toFixed(3)} CPU s per audio second more.` : '';
  console.log(`\nWhisper: ${stats.files} clip(s), ${stats.cached} from the transcript cache; ${stats.excerpts ?? 0} stretch(es) transcribed again on their own.${speed}${all}${ctc}`);
}
process.exitCode = realTargetsMet(rs) ? 0 : 1;
