export type CharacterState = 'idle' | 'listening' | 'speaking' | 'thinking' | 'interrupted' | 'connecting';

// Playback-level animation, not phoneme/viseme lip-sync. No oscillator, text
// clock, network-arrival clock, or repeating speaking animation drives a mouth.
export class SpeechEnvelope {
  private level = 0;
  private silence = 0;
  private frame = 0;
  reset(): number { this.level = 0; this.silence = 0; this.frame = 0; return 0; }
  sample(input: number, elapsed = 32): number {
    const raw = Number.isFinite(input) ? Math.max(0, Math.min(1, input)) : 0;
    const delta = Math.max(1, Math.min(64, elapsed));
    this.silence = raw < .035 ? this.silence + delta : 0;
    if (this.silence >= 64) return this.reset();
    const target = Math.min(1, Math.max(0, (raw - .035) / .32));
    const duration = target > this.level ? 22 : 45;
    this.level += (target - this.level) * (1 - Math.exp(-delta / duration));
    const boundaries = [.10, .34, .66];
    while (this.frame < 3 && this.level > boundaries[this.frame] + .035) this.frame++;
    while (this.frame > 0 && this.level < boundaries[this.frame - 1] - .035) this.frame--;
    return this.frame;
  }
}

export class CharacterAnimator {
  private envelope = new SpeechEnvelope();
  private state: CharacterState = 'idle';
  constructor(private root: HTMLElement) { this.setState('idle'); }
  setState(state: CharacterState): void {
    this.state = state;
    this.root.dataset.characterState = state;
    if (state !== 'speaking') this.render(this.envelope.reset());
  }
  setVolume(volume: number): void {
    this.render(this.state === 'speaking' ? this.envelope.sample(volume) : this.envelope.reset());
  }
  private render(frame: number): void {
    this.root.dataset.mouth = ['closed', 'parted', 'half', 'open'][frame];
    this.root.dataset.mouthFrame = String(frame);
  }
}

export function characterMarkup(size: 'large' | 'small' | 'portrait' = 'large'): string {
  return `<span class="fh-character fh-character-${size}" aria-hidden="true" data-character-state="idle" data-mouth="closed" data-mouth-frame="0"><span class="fh-character-art"><span class="fh-character-sprite"></span><span class="fh-character-eyes"></span><span class="fh-character-mouth"></span></span></span>`;
}
