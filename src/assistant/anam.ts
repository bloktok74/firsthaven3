import type { AnamClient, AnamEvent, EventCallbacks, MessageStreamEvent } from '@anam-ai/js-sdk';
import type { VoiceEvents } from './voice.ts';
import { containsSensitiveData } from '../../shared/intake-model.ts';
import { ANAM_DEMO_MAX_SECONDS } from '../../shared/anam-demo.ts';

type SDK = Pick<typeof import('@anam-ai/js-sdk'), 'createClient' | 'AnamEvent'>;
type TextInput = { stream: MediaStream; resume: () => Promise<void>; close: () => Promise<void> };
function createTextInput(): TextInput {
  // Anam's ElevenLabs bridge ends input-less sessions after 20 seconds. Keep
  // its media transport alive for typed turns without opening a microphone.
  // This tiny carrier is never connected to the computer's audio output.
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const carrier = context.createOscillator(), gain = context.createGain();
  gain.gain.value = 0.0001;
  carrier.connect(gain); gain.connect(destination); carrier.start();
  return { stream: destination.stream, resume: () => context.resume(), close: async () => {
    try { carrier.stop(); carrier.disconnect(); gain.disconnect(); destination.disconnect(); } catch { /* Already stopped. */ }
    if (context.state !== 'closed') await context.close();
  } };
}
type Attempt = {
  mode: 'voice' | 'text'; request: AbortController; cancelled: boolean;
  client: AnamClient | null; lease: string | null; released: boolean;
  releasing?: Promise<void>; expiry?: ReturnType<typeof setTimeout>; startup?: ReturnType<typeof setTimeout>;
  connected: boolean; ready: boolean; dataReady: boolean; videoReady: boolean; contextSent: boolean;
  remove: Array<() => void>; streams: Set<MediaStream>;
  messages: Map<string, { text: string; chunks: Map<number, string> }>;
  completed: Set<string>; settle?: () => void;
  closeTextInput?: () => Promise<void>;
};

// Classify internally, but never display upstream messages, URLs or credentials.
export function anamFailure(error: unknown): string {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const details = [value.name, value.message, value.error, value.code].filter(item => typeof item === 'string').join(' ').toLowerCase();
  if (/quota_store_required|privacy_setup_required|preview_only|consent_required|invalid_session/.test(details)) return 'Jessica is temporarily unavailable. Please try again.';
  if (/quota_store_required|privacy_setup_required|not_configured|setup|preview_only/.test(details)) return 'Jessica is temporarily unavailable. Please try again.';
  if (/daily|session_limit/.test(details)) return 'Jessica’s daily test limit has been reached. Please try again after the daily reset.';
  if (/usage_limit|spend_cap|no_plan/.test(details)) return 'The avatar service’s test allowance is unavailable. Please try again later.';
  if (/concurren|capacity|busy|already_active/.test(details)) return 'Jessica is already speaking with another tester. Please try again shortly.';
  if (/notallowed|permission|microphone_denied/.test(details)) return 'Microphone permission was not granted. Allow microphone access and try again.';
  if (/notfound|no_microphone/.test(details)) return 'No microphone was found. Connect a microphone and try again.';
  if (/not_configured|setup|preview_only|not_available/.test(details)) return 'Jessica is temporarily unavailable. Please try again.';
  return 'Jessica could not connect. Please try again.';
}

export class AnamController {
  private attempt: Attempt | null = null;
  private muted = false;
  active = false;

  constructor(
    private events: VoiceEvents,
    private videoElementId = 'fh-anam-video',
    private loadSDK: () => Promise<SDK> = () => import('@anam-ai/js-sdk'),
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
    private getUserMedia: () => Promise<MediaStream> = () => navigator.mediaDevices.getUserMedia({ audio: true }),
    private makeTextInput: () => TextInput = createTextInput,
  ) {}

  private current(attempt: Attempt): boolean { return this.attempt === attempt && !attempt.cancelled; }

  async start(mode: 'voice' | 'text', consent: boolean, accessCode = ''): Promise<void> {
    if (!consent) { this.events.status('Please use made-up test details before starting.', 'error'); return; }
    if (this.attempt || this.active) return;
    const attempt: Attempt = {
      mode, request: new AbortController(), cancelled: false, client: null,
      lease: null, released: false, connected: false, ready: false, dataReady: false, videoReady: false,
      contextSent: false, remove: [], streams: new Set(), messages: new Map(), completed: new Set(),
    };
    const readiness = new Promise<void>(resolve => { attempt.settle = resolve; });
    this.attempt = attempt;
    this.events.volume(0); this.events.state('connecting');
    this.events.status(mode === 'voice' ? 'Connecting to Jessica… Microphone access requires your permission.' : 'Connecting to Jessica text chat…');
    try {
      let input: MediaStream | undefined;
      // Permission comes before minting a paid session/lease. Anam receives this
      // owned stream and must not open a second microphone capture.
      if (mode === 'voice') {
        input = await this.getUserMedia(); attempt.streams.add(input);
        if (!this.current(attempt)) { await this.cleanup(attempt); return; }
      } else {
        const textInput = this.makeTextInput();
        input = textInput.stream; attempt.streams.add(input); attempt.closeTextInput = textInput.close;
        await textInput.resume();
        if (!this.current(attempt)) { await this.cleanup(attempt); return; }
      }
      const response = await this.fetcher('/api/anam-session', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', mode, testConsent: true, ...(accessCode ? { accessCode } : {}) }), signal: attempt.request.signal,
      });
      const data = await response.json();
      if (typeof data.leaseToken === 'string' && data.leaseToken.length > 0 && data.leaseToken.length <= 4096) attempt.lease = data.leaseToken;
      if (!this.current(attempt)) { await this.cleanup(attempt); return; }
      if (!response.ok) throw { error: typeof data.error === 'string' ? data.error : 'connection_failed' };
      if (!attempt.lease || typeof data.sessionToken !== 'string' || !data.sessionToken || data.sessionToken.length > 32768) throw new Error('Invalid session configuration');
      const sdk = await this.loadSDK();
      if (!this.current(attempt)) { await this.cleanup(attempt); return; }
      const client = sdk.createClient(data.sessionToken, {
        disableInputAudio: false,
        api: { baseUrl: (typeof location === 'undefined' ? 'http://localhost' : location.origin) + '/api/anam', retry: { maxAttempts: 1 } },
        metrics: { disableClientMetrics: true },
      });
      attempt.client = client;
      const listen = <K extends AnamEvent>(event: K, callback: EventCallbacks[K]): void => {
        client.addListener(event, callback);
        attempt.remove.push(() => client.removeListener(event, callback));
      };
      const checkReady = (): void => {
        if (!this.current(attempt) || !attempt.connected || !attempt.ready || !attempt.dataReady || !attempt.videoReady || this.active) return;
        clearTimeout(attempt.startup);
        this.active = true;
        attempt.expiry = setTimeout(() => {
          if (!this.current(attempt)) return;
          this.events.status('The three-minute demo session has ended.');
          void this.end();
        }, ANAM_DEMO_MAX_SECONDS * 1000);
        this.events.status(mode === 'voice' ? 'Connected to Jessica. Use made-up test details only.' : 'Jessica text chat connected. No microphone is used.');
        this.events.state(mode === 'voice' ? 'listening' : 'idle');
        if (!attempt.contextSent) {
          attempt.contextSent = true;
          try { client.addContext('Current synthetic test draft; use these confirmed values and do not ask for them again: ' + this.events.context()); }
          catch { this.fail(attempt, {}); }
        }
        attempt.settle?.();
      };
      listen(sdk.AnamEvent.CONNECTION_ESTABLISHED, () => { attempt.connected = true; checkReady(); });
      listen(sdk.AnamEvent.SESSION_READY, () => { attempt.ready = true; checkReady(); });
      listen(sdk.AnamEvent.DATA_CHANNEL_OPEN, () => { attempt.dataReady = true; checkReady(); });
      listen(sdk.AnamEvent.VIDEO_PLAY_STARTED, () => { attempt.videoReady = true; checkReady(); });
      listen(sdk.AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, message => this.receive(attempt, message));
      listen(sdk.AnamEvent.USER_SPEECH_STARTED, () => { if (this.current(attempt)) { this.events.volume(0); this.events.state('listening'); } });
      listen(sdk.AnamEvent.USER_SPEECH_ENDED, () => { if (this.current(attempt)) this.events.state('thinking'); });
      listen(sdk.AnamEvent.TALK_STREAM_INTERRUPTED, () => { if (this.current(attempt)) { this.events.volume(0); this.events.state('interrupted'); } });
      listen(sdk.AnamEvent.MIC_PERMISSION_DENIED, () => this.fail(attempt, { name: 'NotAllowedError' }));
      listen(sdk.AnamEvent.MESSAGE_DELIVERY_FAILED, () => this.fail(attempt, {}));
      listen(sdk.AnamEvent.CONNECTION_CLOSED, (reason, details) => {
        if (!this.current(attempt)) return;
        if (/NORMAL/.test(reason)) { this.events.status('Conversation ended.'); void this.end(); }
        else if (/SERVER_CLOSED_CONNECTION/.test(reason) && typeof details === 'string' && /max(?:imum)?[_ -]+(?:session[_ -]+)?(?:duration|length)|(?:duration|length|time)[_ -]+limit/i.test(details)) {
          this.events.status('The three-minute demo session has ended.'); void this.end();
        }
        else this.fail(attempt, { code: reason, message: details });
      });
      for (const event of [sdk.AnamEvent.INPUT_AUDIO_STREAM_STARTED, sdk.AnamEvent.AUDIO_STREAM_STARTED, sdk.AnamEvent.VIDEO_STREAM_STARTED]) {
        listen(event, (stream: MediaStream) => {
          if (this.current(attempt)) attempt.streams.add(stream);
          else stream.getTracks().forEach(track => track.stop());
        });
      }
      attempt.remove.push(client.registerToolCallHandler('update_test_intake', {
        onStart: async payload => {
          if (!this.current(attempt) || !this.active) return 'Session closed. No draft was changed.';
          try { return this.events.update(payload.arguments); } catch { return 'Rejected: the local test draft could not be updated.'; }
        },
      }));
      attempt.remove.push(client.registerToolCallHandler('show_test_review', {
        onStart: async () => {
          if (!this.current(attempt) || !this.active) return 'Session closed. No review was opened.';
          try { return this.events.review(); } catch { return 'The local test review could not be opened. Nothing was submitted.'; }
        },
      }));
      // A connected transport with an unplayed video is not a working avatar.
      // End a stalled/autoplay-blocked connection rather than showing success.
      attempt.startup = setTimeout(() => { if (this.current(attempt) && !this.active) this.fail(attempt, {}); }, 60000);
      // This resolves before RTC/video readiness. Only the events above mark active.
      await client.streamToVideoElement(this.videoElementId, input);
      if (!this.current(attempt)) await this.cleanup(attempt);
      else await readiness;
    } catch (error) {
      if (this.current(attempt)) this.fail(attempt, error);
      await this.cleanup(attempt);
    }
  }

  private receive(attempt: Attempt, event: MessageStreamEvent): void {
    if (!this.current(attempt) || !event || typeof event.id !== 'string' || typeof event.content !== 'string' || !['user', 'persona'].includes(event.role)) return;
    const key = event.role + ':' + event.id;
    if (attempt.completed.has(key)) return;
    const message = attempt.messages.get(key) || { text: '', chunks: new Map<number, string>() };
    if (Number.isSafeInteger(event.contentIndex) && event.contentIndex! >= 0) {
      if (!message.chunks.has(event.contentIndex!) && message.chunks.size >= 512) { this.fail(attempt, {}); return; }
      message.chunks.set(event.contentIndex!, event.content);
    }
    else message.text += event.content;
    const text = (message.text + [...message.chunks].sort(([a], [b]) => a - b).map(([, value]) => value).join('')).slice(0, 2400);
    message.text = message.text.slice(0, 2400);
    attempt.messages.set(key, message);
    if (attempt.messages.size > 80) attempt.messages.delete(attempt.messages.keys().next().value!);
    if (containsSensitiveData(text)) {
      this.events.status('Please use fictional details only. The conversation has ended; sensitive content was not added to the local transcript.', 'error');
      void this.end(); return;
    }
    if (event.role === 'persona') this.events.state(event.interrupted ? 'interrupted' : event.endOfSpeech ? 'listening' : 'speaking');
    if (!event.endOfSpeech) return;
    attempt.messages.delete(key); attempt.completed.add(key);
    if (attempt.completed.size > 160) attempt.completed.delete(attempt.completed.values().next().value!);
    if (text.trim()) this.events.message(event.role === 'user' ? 'user' : 'agent', text.slice(0, 600));
  }

  private fail(attempt: Attempt, error: unknown): void {
    if (!this.current(attempt)) return;
    this.events.status(anamFailure(error), 'error');
    void this.end();
  }

  send(message: string): void {
    const attempt = this.attempt;
    if (!attempt || !this.active || !attempt.dataReady || containsSensitiveData(message)) return;
    try {
      attempt.client?.interruptPersona();
      attempt.client?.sendUserMessage(message);
      this.events.volume(0); this.events.state('thinking');
    } catch (error) { this.fail(attempt, error); }
  }

  toggleMute(): boolean {
    const attempt = this.attempt;
    if (!attempt || !this.active || attempt.mode === 'text') return false;
    this.muted = !this.muted;
    if (this.muted) attempt.client?.muteInputAudio(); else attempt.client?.unmuteInputAudio();
    return this.muted;
  }

  private async cleanup(attempt: Attempt): Promise<void> {
    clearTimeout(attempt.expiry);
    clearTimeout(attempt.startup);
    for (const remove of attempt.remove.splice(0)) { try { remove(); } catch { /* Already detached. */ } }
    for (const stream of attempt.streams) {
      try { stream.getTracks().forEach(track => { try { track.stop(); } catch { /* Already stopped. */ } }); } catch { /* SDK stream already disposed. */ }
    }
    attempt.streams.clear(); attempt.messages.clear(); attempt.completed.clear();
    const closeTextInput = attempt.closeTextInput; attempt.closeTextInput = undefined;
    if (closeTextInput) { try { await closeTextInput(); } catch { /* Already closed. */ } }
    // Keep the client reference: a cancelled SDK start can allocate RTC resources
    // after an earlier stop, so the late completion must stop it a second time.
    if (attempt.client) { try { await attempt.client.stopStreaming(); } catch { /* Best effort; lease still ends. */ } }
    if (typeof document !== 'undefined' && !this.attempt) {
      const video = document.getElementById(this.videoElementId) as HTMLVideoElement | null;
      if (video) { try { video.pause(); video.srcObject = null; } catch { /* Element was already removed. */ } }
    }
    if (!attempt.lease || attempt.released) return;
    if (attempt.releasing) { await attempt.releasing; return; }
    attempt.releasing = (async () => {
      try {
        const response = await this.fetcher('/api/anam-session', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'end', leaseToken: attempt.lease }), keepalive: true, signal: AbortSignal.timeout(10000),
        });
        attempt.released = response.ok;
      } catch { /* Server lease expiry bounds a failed disconnect request. */ }
    })();
    await attempt.releasing; attempt.releasing = undefined;
  }

  async end(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = null; attempt.cancelled = true; attempt.request.abort();
    attempt.settle?.();
    this.active = false; this.muted = false;
    this.events.volume(0); this.events.state('idle'); this.events.ended();
    await this.cleanup(attempt);
  }
}
