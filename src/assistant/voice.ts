import type { Conversation as ConversationSession, PartialOptions } from '@elevenlabs/client';
import { containsSensitiveData, JESSICA_DAILY_SESSION_LIMIT } from '../../shared/intake-model.ts';
import type { CharacterState } from './character.ts';

type SDK = { Conversation: { startSession(options: PartialOptions): Promise<ConversationSession> } };
let preparedSDK: Promise<SDK> | undefined;
function loadVoiceSDK(): Promise<SDK> {
  preparedSDK ||= import('@elevenlabs/client').then(({ Conversation, TextConversation }) => ({ Conversation: {
    startSession: (options: PartialOptions) => options.textOnly
      ? TextConversation.startSession({ ...options, textOnly: undefined })
      : Conversation.startSession(options),
  } })).catch(error => { preparedSDK = undefined; throw error; });
  return preparedSDK;
}
// Importing installs the SDK's iOS user-gesture audio-unlock listener before
// the first Open Escrow click. It opens no microphone, WebSocket or session.
export function prepareVoiceSDK(): void { void loadVoiceSDK().catch(() => {}); }

export interface VoiceEvents {
  status(message: string, kind?: 'info' | 'error'): void;
  state(state: CharacterState): void;
  message(role: 'user' | 'agent', message: string): void;
  update(parameters: unknown): string;
  review(): string;
  ended(): void;
  volume(value: number): void;
  context(): string;
}

// Classify provider/device failures, but never render raw upstream text or URLs.
export function connectionFailure(error: unknown): string {
  const details = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown; closeReason?: unknown } : {};
  const text = [details.message, details.closeReason].filter(value => typeof value === 'string').join(' ').toLowerCase();
  if (/daily.{0,50}(limit|quota)|daily_limit/.test(text)) return `Jessica’s ${JESSICA_DAILY_SESSION_LIMIT}-session daily test limit has been reached. Voice and AI text will be available after it resets. You can use guided text below.`;
  if (/concurren|capacity|already.{0,20}(call|session)|too_many/.test(text)) return 'Jessica is already speaking with another tester. Please try again shortly, or use guided text below.';
  if (details.name === 'NotAllowedError' || /permission denied/.test(text)) return 'Microphone permission was not granted. Allow microphone access in your browser and retry, or use text instead.';
  if (details.name === 'NotFoundError') return 'No microphone was found. Connect a microphone and retry, or use text instead.';
  if (details.name === 'NotReadableError') return 'Your browser could not open the microphone. Check whether another app is using it, or use text instead.';
  if (text.startsWith('the test voice agent needs setup')) return 'The test voice agent needs setup. Guided text intake is available below.';
  if (text.startsWith('voice is not connected yet')) return 'Jessica is temporarily unavailable. You can use guided text below.';
  return 'Jessica could not connect. Retry voice or use guided text below.';
}

export class VoiceController {
  private session: ConversationSession | null = null;
  private attempt = 0;
  private request: AbortController | null = null;
  private meter: ReturnType<typeof setInterval> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private muted = false;
  private playbackSpeaking = false;
  private playbackBlocked = false;
  active = false;

  constructor(
    private events: VoiceEvents,
    private loadSDK: () => Promise<SDK> = loadVoiceSDK,
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async start(mode: 'voice' | 'text', consent: boolean): Promise<void> {
    if (!consent) { this.events.status('Please confirm you are using made-up test details before starting.', 'error'); return; }
    if (this.active || this.request) return;
    const attempt = ++this.attempt;
    this.request = new AbortController();
    this.playbackSpeaking = false; this.playbackBlocked = false;
    this.events.volume(0);
    this.events.state('connecting');
    this.events.status(mode === 'voice' ? 'Connecting to Jessica… Microphone access starts only with your permission.' : 'Connecting to ElevenLabs text chat…');
    try {
      const response = await this.fetcher('/api/assistant', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', mode, testConsent: true }), signal: this.request.signal,
      });
      const data = await response.json();
      if (!response.ok) {
        const message = data.error === 'test_agent_setup_required' ? 'The test voice agent needs setup. Guided text intake is available below.' : 'Voice is not connected yet. You can still use guided test chat below.';
        throw new Error(message);
      }
      if (attempt !== this.attempt) return;
      // Open Escrow is the explicit voice-start action; page load never starts it.
      const { Conversation } = await this.loadSDK();
      if (attempt !== this.attempt) return;
      const session = await Conversation.startSession({
        signedUrl: data.signedUrl, connectionType: 'websocket', textOnly: mode === 'text',
        clientTools: {
          update_test_intake: parameters => attempt === this.attempt && this.active ? this.events.update(parameters) : 'Session closed. No draft was changed.',
          show_test_review: () => attempt === this.attempt && this.active ? this.events.review() : 'Session closed. No review was opened.',
        },
        onConversationCreated: created => {
          if (attempt === this.attempt) this.session = created;
          else void created.endSession();
        },
        onConnect: () => {
          if (attempt !== this.attempt) return;
          this.active = true;
          this.events.status(mode === 'voice' ? 'Connected to Jessica. Use made-up test details only.' : 'ElevenLabs text chat connected. No microphone is used.');
          this.events.state(mode === 'voice' ? 'listening' : 'idle');
        },
        onModeChange: ({ mode: state }) => {
          if (attempt !== this.attempt) return;
          this.playbackSpeaking = mode === 'voice' && state === 'speaking';
          if (!this.playbackSpeaking) this.events.volume(0);
          this.events.state(mode === 'text' ? 'idle' : this.playbackBlocked ? 'listening' : state);
        },
        onAudio: () => {
          // The SDK filters stale, interrupted audio events before this callback.
          // Receiving bytes never moves the mouth; the output analyser does.
          if (attempt === this.attempt && mode === 'voice') {
            this.playbackBlocked = false; this.playbackSpeaking = true;
            this.events.state('speaking');
          }
        },
        onInterruption: () => {
          if (attempt !== this.attempt) return;
          this.playbackSpeaking = false; this.playbackBlocked = true;
          this.events.volume(0); this.events.state('interrupted');
        },
        onAgentTyping: ({ is_typing }) => {
          if (attempt === this.attempt && is_typing && !this.playbackSpeaking) this.events.state('thinking');
        },
        onMessage: ({ role, message }) => {
          if (attempt !== this.attempt) return;
          if (role === 'user') {
            this.playbackSpeaking = false;
            this.events.volume(0); this.events.state('thinking');
          }
          if (containsSensitiveData(message)) {
            this.events.status('Please use made-up test details only. The conversation has been ended; sensitive content was not added to the local transcript.', 'error');
            void this.end();
            return;
          }
          this.events.message(role, message.slice(0, 600));
        },
        onDisconnect: details => {
          if (attempt === this.attempt) {
            this.attempt++;
            if (details.reason === 'error') this.events.status(connectionFailure(details), 'error');
            else this.events.status('Conversation ended. Your local test draft is still available.');
            this.finish();
          }
        },
        onError: message => {
          if (attempt !== this.attempt) return;
          this.events.status(connectionFailure({ message }), 'error');
          void this.end();
        },
        // No MCP approval or external tool is supported by this client.
        onMCPToolApprovalRequest: () => false,
      });
      if (attempt !== this.attempt) { await session.endSession(); return; }
      this.session = session;
      session.sendContextualUpdate('Current synthetic test draft; use these confirmed values and do not ask for them again: ' + this.events.context());
      this.request = null;
      if (mode === 'voice') this.meter = setInterval(() => {
        if (attempt !== this.attempt || !this.session) return;
        this.events.volume(this.playbackSpeaking && !this.playbackBlocked ? this.session.getOutputVolume() : 0);
      }, 32);
      this.expiry = setTimeout(() => { this.events.status('The three-minute test session has ended. Your local draft is still available.'); void this.end(); }, 180000);
    } catch (error) {
      if (attempt !== this.attempt) return;
      this.events.status(connectionFailure(error), 'error');
      await this.end();
    }
  }

  send(message: string): void {
    if (this.session && this.active && !containsSensitiveData(message)) {
      this.playbackSpeaking = false; this.events.volume(0); this.events.state('thinking');
      this.session.sendUserMessage(message);
    }
  }
  toggleMute(): boolean {
    this.muted = !this.muted;
    this.session?.setMicMuted(this.muted);
    return this.muted;
  }
  private finish(): void {
    clearInterval(this.meter);
    clearTimeout(this.expiry);
    this.active = false;
    this.muted = false;
    this.playbackSpeaking = false; this.playbackBlocked = true;
    this.request = null;
    this.session = null;
    this.events.state('idle');
    this.events.volume(0);
    this.events.ended();
  }
  async end(): Promise<void> {
    this.attempt++;
    this.request?.abort();
    const session = this.session;
    this.finish();
    if (session) { try { await session.endSession(); } catch { /* Already disconnected. */ } }
  }
}
