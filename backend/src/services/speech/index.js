// Speech-to-text for voice commands, behind one small interface so the provider is configuration.
//
//   google   Cloud Speech-to-Text v1 speech:recognize (synchronous, up to ~60 s of audio), API key in
//            the X-Goog-Api-Key header (never in the URL or logs). SPEECH_PROVIDER=google + SPEECH_API_KEY.
//   (none)   no server-side speech: the browser's own speech recognition is used where available,
//            and the assistant still accepts typed text.
// Audio is transcribed and discarded; it is never stored.
import { config } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export const MAX_AUDIO_BYTES = 1_000_000;
const ENCODINGS = { 'audio/webm': 'WEBM_OPUS', 'audio/ogg': 'OGG_OPUS', 'audio/wav': 'LINEAR16', 'audio/x-wav': 'LINEAR16', 'audio/flac': 'FLAC' };

let settings = { ...config.features.speech, fetch: undefined };
/** Tests only. */
export const configureSpeech = (o) => Object.assign(settings, o);
export const resetSpeech = () => {
  settings = { ...config.features.speech, fetch: undefined };
};

export const speechProblem = () => (!settings.provider ? 'SPEECH_PROVIDER is not set' : !settings.apiKey ? 'SPEECH_API_KEY is not set' : null);
export const speechInfo = () => ({ provider: settings.provider ?? null, configured: speechProblem() === null, language: settings.language, maxBytes: MAX_AUDIO_BYTES, contentTypes: Object.keys(ENCODINGS) });

/** Transcribes one short recording. Returns { text, confidence }. */
export async function transcribe(audio, contentType, { language } = {}) {
  const problem = speechProblem();
  if (problem) throw new AppError(503, 'SPEECH_NOT_CONFIGURED', `Server speech-to-text is not configured (${problem})`);
  const base = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const encoding = ENCODINGS[base];
  if (!encoding) throw new AppError(415, 'UNSUPPORTED_AUDIO', `Unsupported audio type ${base || '(none)'}`);
  if (!audio?.length) throw new AppError(400, 'EMPTY_AUDIO', 'No audio received');
  if (audio.length > MAX_AUDIO_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Recording is too long (about one minute at most)');
  const doFetch = settings.fetch ?? globalThis.fetch;
  let res;
  try {
    res = await doFetch(`${settings.apiUrl}/v1/speech:recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': settings.apiKey },
      body: JSON.stringify({
        config: { encoding, ...(encoding === 'WEBM_OPUS' || encoding === 'OGG_OPUS' ? { sampleRateHertz: 48000 } : {}), languageCode: language ?? settings.language, enableAutomaticPunctuation: true, model: 'latest_short' },
        audio: { content: Buffer.from(audio).toString('base64') },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new AppError(502, 'SPEECH_UNAVAILABLE', 'The speech service did not answer');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    logger.warn('speech-to-text failed', { status: res.status, reason: body?.error?.status ?? null });
    throw new AppError(502, 'SPEECH_FAILED', res.status === 400 || res.status === 403 ? 'The speech service refused the request (check SPEECH_API_KEY and audio format)' : 'The speech service failed');
  }
  const alts = (body?.results ?? []).map((r) => r.alternatives?.[0]).filter(Boolean);
  const text = alts.map((a) => a.transcript.trim()).join(' ').trim();
  const confidence = alts.length ? alts.reduce((s, a) => s + (a.confidence ?? 0), 0) / alts.length : null;
  return { text, confidence };
}
