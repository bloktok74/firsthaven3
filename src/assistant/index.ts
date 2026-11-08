import { fields, labels, questions, sampleValues, emptyValues, validateAnswer, makeDraft, simulateSubmission, isField, containsSensitiveData, confirmationReply, INTRODUCTION, REVIEW_NOTICE, JESSICA_DAILY_SESSION_LIMIT, type IntakeField } from '../../shared/intake-model.ts';
import { CharacterAnimator, characterMarkup } from './character.ts';
import { VoiceController, prepareVoiceSDK, type VoiceEvents } from './voice.ts';
import { AnamController } from './anam.ts';

declare const __ANAM_PREVIEW__: boolean;
declare const __ANAM_PUBLIC_TEST__: boolean;
if (!__ANAM_PREVIEW__) prepareVoiceSDK();
const microphoneIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/><path class="fh-mic-slash" d="M3 3l18 18"/></svg>';

const root = document.createElement('aside');
root.className = 'fh-assistant' + (__ANAM_PREVIEW__ ? ' fh-anam-preview' : '');
root.setAttribute('aria-label', 'First Haven AI test assistant');
root.innerHTML = `<dialog class="fh-panel" id="fh-panel" aria-modal="true" aria-labelledby="fh-title" aria-describedby="fh-voice-disclosure" tabindex="-1" hidden>
<h2 class="fh-sr-only" id="fh-title">Jessica, your First Haven virtual representative</h2>
<button class="fh-test-indicator" type="button" data-action="privacy" aria-label="Privacy and accessibility options" aria-controls="fh-access-panel" aria-expanded="false">TEST ONLY</button>
<button class="fh-close" aria-label="Close assistant and clear test data" type="button">×</button>
<section class="fh-presence" aria-label="Jessica"><div class="fh-portrait-stage">${__ANAM_PREVIEW__ ? '<div class="fh-anam-stage"><video id="fh-anam-video" poster="images/anam-demo-portrait.webp" autoplay playsinline aria-label="Jessica AI assistant avatar"></video></div>' : characterMarkup('portrait')}</div><span class="fh-presence-status fh-sr-only" aria-hidden="true">Here when you’re ready</span></section>
<div class="fh-feedback" hidden><p class="fh-notice" role="alert" hidden></p><button class="fh-recovery" type="button" data-action="voice" hidden>Try again</button></div><p class="fh-connection fh-sr-only" role="status" aria-live="polite">Connecting to Jessica.</p>
${__ANAM_PUBLIC_TEST__ ? '<div class="fh-feedback fh-demo-consent" hidden><p class="fh-notice">This 30-second AI demo is for fictional details only. Anam and ElevenLabs process your conversation. Choose Start test call to continue.</p><button class="fh-recovery" type="button" data-action="accept-demo">Start test call</button></div>' : ''}
<p class="fh-captions" role="log" aria-live="polite" hidden></p>
<section class="fh-access-panel" id="fh-access-panel" aria-labelledby="fh-access-title" hidden><h3 id="fh-access-title" tabindex="-1">Privacy & accessibility</h3><p id="fh-voice-disclosure">This is a fictional test conversation with an AI avatar. ${__ANAM_PUBLIC_TEST__ ? 'Starting the test call requests microphone access. Anam renders the avatar with zero session data retention and ElevenLabs processes the conversation. Audio/video recording and stored transcripts are disabled.' : __ANAM_PREVIEW__ ? 'Opening Jessica requests microphone access. Anam renders the avatar and ElevenLabs processes the conversation. Audio/video recording and stored transcripts are disabled. Anam may keep other session reports for this temporary fictional test.' : 'Opening Jessica requests microphone access. ElevenLabs processes the audio; recording is disabled.'} Closing ends the call and clears the local draft.</p><label><input type="checkbox" name="captions"> Show live captions</label><button type="button" data-action="keyboard">Keyboard conversation</button><button type="button" data-action="reset">Clear conversation</button><button type="button" data-action="options-close">Done</button></section>
<form class="fh-input-form" hidden><label class="fh-sr-only" for="fh-answer">Your message</label><div class="fh-input-row"><input id="fh-answer" name="answer" autocomplete="off" maxlength="240" placeholder="Your message…"><button type="submit" aria-label="Send message">↑</button></div><p class="fh-field-error" role="alert"></p></form>
<footer class="fh-call-controls"><button class="fh-call-button" type="button" data-action="mute" aria-label="Mute microphone" aria-pressed="false" disabled>${microphoneIcon}</button><button class="fh-end-call" type="button" data-action="end" aria-label="End conversation">End call</button></footer>
<div class="fh-internal" hidden inert aria-hidden="true"><div class="fh-tabs"><button type="button" data-view="chat" aria-pressed="true">Conversation</button><button type="button" data-view="review" aria-pressed="false">Review request <span class="fh-count">0/6</span></button></div>
<div class="fh-chat"><div class="fh-log" role="log" aria-label="Test intake conversation" aria-live="polite" aria-relevant="additions"></div>
<div class="fh-start-actions"><button class="fh-primary" type="button" data-action="begin">Begin test intake <span aria-hidden="true">↗</span></button><button class="fh-quiet" type="button" data-action="example">Try a sample request</button></div>
<div class="fh-question-actions" hidden></div>
</div>
<div class="fh-review" tabindex="-1" hidden></div>
<button type="button" data-action="text-only">Use text instead</button><button type="button" data-action="ai-text">AI text</button></div></dialog>`;
document.body.append(root);

function element<T extends HTMLElement>(selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error('Missing assistant element: ' + selector);
  return found;
}
const panel = element<HTMLDialogElement>('.fh-panel');
const log = element<HTMLElement>('.fh-log');
const form = element<HTMLFormElement>('.fh-input-form');
const input = element<HTMLInputElement>('#fh-answer');
const choices = element<HTMLElement>('.fh-question-actions');
const review = element<HTMLElement>('.fh-review');
const status = element<HTMLElement>('.fh-connection');
const avatars = Array.from(root.querySelectorAll<HTMLElement>('.fh-character')).map(el => new CharacterAnimator(el));
let values = emptyValues();
let skipped: IntakeField[] = [];
let current: IntakeField | null = null;
let pending: { field: IntakeField; value: string } | null = null;
let voiceCandidate: { field: IntakeField; value: string } | null = null;
let humanConfirmed: { field: IntakeField; value: string } | null = null;
let editing = false;
let simulated = false;
let voiceStarting = false;
let publicDemoConsent = false;
let sessionMode: 'voice' | 'text' = 'voice';
let closeAnimation: ReturnType<typeof setTimeout> | undefined;
let returnFocus: HTMLElement | undefined;
let startGeneration = 0;
let captionsEnabled = false;

function message(role: 'agent' | 'user', text: string): void {
  if (role === 'agent' && text === INTRODUCTION && [...log.children].some(item => item.textContent?.includes(INTRODUCTION))) return;
  if (role === 'user' && voice.active && voiceCandidate) {
    const reply = confirmationReply(text);
    if (reply === 'yes') humanConfirmed = { ...voiceCandidate };
    else if (reply === 'no') { humanConfirmed = null; voiceCandidate = null; }
  }
  const item = document.createElement('p');
  item.className = 'fh-message fh-message-' + role;
  const label = document.createElement('span');
  label.className = 'fh-message-label';
  label.textContent = role === 'agent' ? 'FIRST HAVEN' : 'YOU · TEST DETAILS';
  item.append(label, document.createTextNode(text));
  log.append(item);
  element<HTMLElement>('.fh-captions').textContent = (role === 'agent' ? 'Jessica: ' : 'You: ') + text;
  while (log.children.length > 60) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
}
function setView(view: 'chat' | 'review'): void {
  element<HTMLElement>('.fh-chat').hidden = view !== 'chat';
  review.hidden = view !== 'review';
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-view]')) tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
  if (view === 'review') { renderReview(); review.focus({ preventScroll: true }); }
}
function updateCount(): void { element<HTMLElement>('.fh-count').textContent = `${fields.filter(field => values[field]).length}/6`; }
function actionButton(label: string, action: () => void, className = 'fh-choice'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className; button.textContent = label;
  button.addEventListener('click', action);
  return button;
}
function askNext(): void {
  pending = null;
  current = fields.find(field => !values[field] && !skipped.includes(field)) || null;
  if (!current) {
    form.hidden = true; choices.hidden = true;
    message('agent', 'That’s enough to make a useful beginning. Please review your test request. ' + REVIEW_NOTICE);
    setView('review'); return;
  }
  message('agent', questions[current]);
  showQuestionActions();
}
function showQuestionActions(): void {
  choices.replaceChildren();
  choices.hidden = false;
  form.hidden = sessionMode !== 'text' || !voice.active;
  if (!current) return;
  const field = current;
  choices.append(actionButton('Use sample answer', () => receive(sampleValues[field])));
  if (field === 'transactionType') for (const type of ['purchase', 'refinance', 'commercial', '1031 exchange', 'other']) choices.append(actionButton(type, () => receive(type)));
  if (field === 'purchaseAgreementAvailable') for (const answer of ['yes', 'no', 'not sure']) choices.append(actionButton(answer, () => receive(answer)));
  if (['agentPhone', 'purchaseAgreementAvailable'].includes(field)) choices.append(actionButton('Skip for now', skipCurrent));
  input.value = '';
  element<HTMLElement>('.fh-field-error').textContent = '';
}
function begin(): void {
  element<HTMLElement>('.fh-start-actions').hidden = true;
  setView('chat');
  if (!current) askNext();
}
function commitAnswer(field: IntakeField, value: string): void {
  values[field] = value;
  skipped = skipped.filter(item => item !== field);
  simulated = false;
  updateCount();
  if (editing) { editing = false; pending = null; current = null; setView('review'); return; }
  askNext();
}
function receive(text: string): void {
  if (voice.active && (confirmationReply(text) || /^(hi|hello|begin|yes,? begin|let’s begin|let's begin|please repeat|continue|stop|no thank you)[.!?]?$/i.test(text.trim()))) {
    message('user', text.trim()); input.value = '';
    element<HTMLElement>('.fh-field-error').textContent = '';
    voice.send(text.trim()); return;
  }
  if (!current) begin();
  if (!current) return;
  if (text.trim().toLowerCase() === 'skip') { skipCurrent(); return; }
  const result = validateAnswer(current, text);
  if (result.error) { element<HTMLElement>('.fh-field-error').textContent = result.error; return; }
  const value = result.value!;
  message('user', value);
  input.value = '';
  if (voice.active) {
    voiceCandidate = { field: current, value }; humanConfirmed = null;
    voice.send(value); return;
  }
  const field = current;
  if (['agentName', 'agentEmail', 'agentPhone', 'propertyAddress'].includes(field)) {
    pending = { field, value };
    message('agent', `Please confirm: ${value}. Is that correct?`);
    choices.replaceChildren(actionButton('Yes, that’s correct', () => { if (pending) commitAnswer(pending.field, pending.value); }), actionButton('Change it', () => { pending = null; showQuestionActions(); input.focus(); }));
    form.hidden = true;
  } else commitAnswer(field, value);
}
function skipCurrent(): void {
  if (!current || !['agentPhone', 'purchaseAgreementAvailable'].includes(current)) return;
  skipped.push(current); values[current] = ''; pending = null;
  message('user', 'Skip this optional question.');
  if (voice.active) voice.send('Please skip this optional question.');
  else if (editing) { editing = false; current = null; setView('review'); }
  else askNext();
}
function renderReview(): void {
  review.replaceChildren();
  const heading = document.createElement('h3'); heading.textContent = simulated ? 'Test request simulated.' : 'Your next chapter, in view.';
  const note = document.createElement('p'); note.textContent = simulated ? 'Nothing was sent. No order was opened and no escrow number was assigned.' : 'Review the made-up details below. Missing information is flagged for follow-up.';
  review.append(heading, note);
  const list = document.createElement('dl');
  for (const field of fields) {
    const row = document.createElement('div'); row.className = 'fh-review-row';
    const term = document.createElement('dt'); term.textContent = labels[field];
    const description = document.createElement('dd'); description.textContent = values[field] || (skipped.includes(field) ? 'Skipped · follow-up needed' : 'Missing · follow-up needed');
    row.append(term, description, actionButton('Edit', () => {
      void voice.end(); editing = true; simulated = false; current = field; pending = null;
      setView('chat'); element<HTMLElement>('.fh-start-actions').hidden = true;
      message('agent', questions[field]); showQuestionActions(); input.focus();
    }, 'fh-edit'));
    list.append(row);
  }
  const missing = makeDraft(values, skipped).missingFields;
  const missingNote = document.createElement('p'); missingNote.className = 'fh-missing';
  missingNote.textContent = missing.length ? 'Follow-up needed: ' + missing.map(field => labels[field]).join(', ') + '.' : 'The six introductory questions are complete. Additional transaction details would be collected by the escrow team.';
  const notice = document.createElement('p'); notice.className = 'fh-review-notice'; notice.textContent = REVIEW_NOTICE;
  const simulate = actionButton('Simulate test submission', () => {
    void voice.end();
    const draft = simulateSubmission(makeDraft(values, skipped));
    simulated = draft.status === 'simulated';
    renderReview();
    review.focus({ preventScroll: true });
  }, 'fh-primary');
  simulate.disabled = !fields.some(field => values[field]) || simulated;
  review.append(list, missingNote, notice, simulate);
  review.scrollTop = 0;
}
function voiceButtons(active: boolean): void {
  element<HTMLButtonElement>('[data-action="mute"]').disabled = !active || sessionMode === 'text';
  element<HTMLButtonElement>('[data-action="voice"]').disabled = active || voiceStarting;
  element<HTMLButtonElement>('[data-action="voice"]').hidden = active || voiceStarting || element<HTMLElement>('.fh-notice').hidden;
  element<HTMLButtonElement>('[data-action="ai-text"]').disabled = active || voiceStarting;
  input.disabled = sessionMode === 'text' && !active;
  element<HTMLButtonElement>('.fh-input-row button').disabled = input.disabled;
  if (sessionMode === 'text') form.hidden = !active;
}
const voiceEvents: VoiceEvents = {
  status: (text, kind) => {
    status.textContent = text;
    const notice = element<HTMLElement>('.fh-notice');
    const connecting = kind !== 'error' && text.startsWith('Connecting');
    const timedEnding = 'The three-minute';
    const ended = kind !== 'error' && (text.startsWith('Conversation ended.') || text.startsWith(timedEnding));
    element<HTMLElement>('.fh-feedback').hidden = kind !== 'error' && !connecting && !ended;
    panel.classList.toggle('fh-has-error', kind === 'error');
    notice.hidden = kind !== 'error' && !connecting && !ended;
    notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    notice.textContent = connecting ? 'Connecting…' : ended ? text.startsWith(timedEnding) ? 'This three-minute test conversation has ended.' : 'Conversation ended.' : kind !== 'error' ? '' : /daily test limit/.test(text) ? `Jessica has reached today’s ${__ANAM_PREVIEW__ ? 20 : JESSICA_DAILY_SESSION_LIMIT} test conversations. Please try again after the daily reset.` : /Microphone permission/.test(text) ? 'Allow microphone access, then try again.' : /another tester/.test(text) ? 'Jessica is with another tester. Please try again shortly.' : /test allowance/.test(text) ? 'The avatar test allowance is unavailable. Please try again later.' : /sensitive content/.test(text) ? 'Please use fictional details only. This conversation has ended.' : 'Jessica could not connect. Please try again.';
    voiceButtons(voice.active);
  },
  state: state => {
    avatars.forEach(avatar => avatar.setState(state));
    element<HTMLElement>('.fh-presence-status').textContent = {
      idle: 'Here when you’re ready', connecting: 'Connecting…', listening: 'Listening to you',
      speaking: sessionMode === 'voice' ? 'Speaking with you' : 'Writing a reply',
      thinking: 'A moment to think…', interrupted: 'Listening to you',
    }[state];
    voiceButtons(voice.active);
  },
  volume: value => avatars.forEach(avatar => avatar.setVolume(value)),
  message: (role, text) => message(role, text),
  update: parameters => {
    if (!parameters || typeof parameters !== 'object') return 'Rejected: invalid test update.';
    const item = parameters as Record<string, unknown>;
    if (!isField(item.field)) return 'Rejected: unknown intake field.';
    const field = item.field;
    if (item.skipped === true && ['agentPhone', 'purchaseAgreementAvailable'].includes(field)) {
      skipped = [...new Set([...skipped, field])]; values[field] = '';
      current = fields.find(value => !values[value] && !skipped.includes(value)) || null;
      updateCount(); showQuestionActions(); return 'Optional question skipped locally. Nothing was submitted.';
    }
    if (item.confirmed !== true) return 'Ask the user to confirm this value before saving it.';
    const result = validateAnswer(field, item.value);
    if (result.error) return result.error;
    if (['agentName', 'agentEmail', 'agentPhone', 'propertyAddress'].includes(field) &&
      (humanConfirmed?.field !== field || humanConfirmed.value !== result.value)) {
      voiceCandidate = { field, value: result.value! }; humanConfirmed = null;
      return 'The visitor has not confirmed this value yet. Read it back, ask whether it is correct, and wait for the visitor to say yes before calling again.';
    }
    values[field] = result.value!; skipped = skipped.filter(value => value !== field); simulated = false;
    voiceCandidate = null; humanConfirmed = null;
    updateCount(); current = fields.find(value => !values[value] && !skipped.includes(value)) || null;
    if (current) showQuestionActions(); else { choices.hidden = true; form.hidden = true; }
    return 'Confirmed synthetic value saved to the in-memory draft. No order was opened.';
  },
  review: () => { setView('review'); return REVIEW_NOTICE; },
  context: () => JSON.stringify(makeDraft(values, skipped)),
  ended: () => {
    voiceCandidate = null; humanConfirmed = null; voiceStarting = false;
    const mute = element<HTMLButtonElement>('[data-action="mute"]');
    mute.setAttribute('aria-pressed', 'false'); mute.setAttribute('aria-label', 'Mute microphone');
    voiceButtons(false);
  },
};
const voice = __ANAM_PREVIEW__ ? new AnamController(voiceEvents) : new VoiceController(voiceEvents);
if (__ANAM_PREVIEW__) {
  const video = element<HTMLVideoElement>('#fh-anam-video');
  video.addEventListener('playing', () => element<HTMLElement>('.fh-anam-stage').classList.add('fh-has-video'));
  video.addEventListener('emptied', () => element<HTMLElement>('.fh-anam-stage').classList.remove('fh-has-video'));
}
function reset(): void {
  if (__ANAM_PUBLIC_TEST__) {
    publicDemoConsent = false;
    element<HTMLElement>('.fh-demo-consent').hidden = true;
  }
  startGeneration++;
  void voice.end(); values = emptyValues(); skipped = []; current = null; pending = null; voiceCandidate = null; humanConfirmed = null; editing = false; simulated = false;
  log.replaceChildren(); review.replaceChildren(); choices.replaceChildren(); form.hidden = true; choices.hidden = true;
  input.value = ''; message('agent', INTRODUCTION); updateCount(); setView('chat');
  element<HTMLElement>('.fh-start-actions').hidden = false;
  element<HTMLElement>('.fh-notice').hidden = true;
  element<HTMLElement>('.fh-feedback').hidden = true; panel.classList.remove('fh-has-error');
  captionsEnabled = false; element<HTMLInputElement>('[name="captions"]').checked = false;
  element<HTMLElement>('.fh-captions').hidden = true;
  element<HTMLElement>('.fh-access-panel').hidden = true;
  panel.classList.remove('fh-keyboard-mode');
  element<HTMLButtonElement>('[data-action="privacy"]').setAttribute('aria-expanded', 'false');
  voiceButtons(false);
  status.textContent = __ANAM_PUBLIC_TEST__
    ? 'Choose Start test call to speak with Jessica.'
    : 'Jessica starts when you open this window. Text is available without a microphone.';
}
async function startConversation(mode: 'voice' | 'text'): Promise<void> {
  if (__ANAM_PUBLIC_TEST__ && !publicDemoConsent) return;
  if (voiceStarting || voice.active) return;
  const generation = ++startGeneration;
  sessionMode = mode; voiceStarting = true; voiceButtons(false);
  panel.classList.toggle('fh-keyboard-mode', mode === 'text');
  setView('chat'); element<HTMLElement>('.fh-start-actions').hidden = true;
  current ||= fields.find(field => !values[field] && !skipped.includes(field)) || null;
  if (current) showQuestionActions();
  // The visitor's entry/retry click explicitly requests this test conversation.
  // Native microphone permission and all server-side test gates still apply.
  try { await voice.start(mode, true); }
  finally {
    if (generation !== startGeneration) return;
    voiceStarting = false; voiceButtons(voice.active);
    if (!voice.active && !panel.hidden && !panel.classList.contains('fh-closing') && current) {
      element<HTMLElement>('.fh-start-actions').hidden = false;
      message('agent', questions[current]); showQuestionActions();
    }
  }
}
function close(): void {
  if (panel.hidden || panel.classList.contains('fh-closing')) return;
  panel.inert = true; panel.classList.add('fh-closing');
  clearTimeout(closeAnimation);
  closeAnimation = setTimeout(() => {
    if (panel.open) panel.close();
    panel.hidden = true; panel.classList.remove('fh-closing');
    root.classList.remove('is-open');
    document.body.classList.remove('fh-assistant-open');
    if (returnFocus?.getClientRects().length) returnFocus.focus({ preventScroll: true });
  }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
  reset();
}
function open(trigger: HTMLElement): void {
  document.dispatchEvent(new Event('first-haven:assistant-open'));
  const opening = panel.hidden || panel.classList.contains('fh-closing');
  returnFocus = trigger;
  clearTimeout(closeAnimation); panel.inert = false; panel.classList.remove('fh-closing');
  panel.hidden = false; root.classList.add('is-open');
  document.body.classList.add('fh-assistant-open');
  if (!panel.open) {
    if (typeof panel.showModal === 'function') panel.showModal();
    else panel.setAttribute('open', '');
  }
  element<HTMLButtonElement>('.fh-close').focus();
  if (opening && __ANAM_PUBLIC_TEST__) {
    element<HTMLElement>('.fh-demo-consent').hidden = false;
    element<HTMLButtonElement>('[data-action="accept-demo"]').focus();
  } else if (opening) {
    void startConversation('voice');
  }
}
// Keep the contact anchor fallback when the assistant build is disabled.
for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-open-escrow]')) {
  link.setAttribute('aria-controls', panel.id);
  link.setAttribute('aria-haspopup', 'dialog');
  link.setAttribute('aria-describedby', 'fh-voice-disclosure');
  link.title = 'Open Jessica’s voice test. Use made-up details only.';
  link.addEventListener('click', event => {
    if (!event.isTrusted || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(link);
  });
}
element<HTMLButtonElement>('.fh-close').addEventListener('click', close);
panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
panel.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.stopPropagation(); close(); }
  if (event.key === 'Tab') {
    const controls = [...panel.querySelectorAll<HTMLElement>('button, input, a[href], select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(control => control.getClientRects().length && !control.matches(':disabled') && !control.closest('[hidden], [inert]'));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !panel.hidden && !document.querySelector('.cinema[open]')) {
    event.preventDefault(); event.stopPropagation();
    if (!element<HTMLElement>('.fh-access-panel').hidden) setOptions(false); else close();
  }
}, { capture: true });
form.addEventListener('submit', event => { event.preventDefault(); receive(input.value); });
function setOptions(opened: boolean): void {
  element<HTMLElement>('.fh-access-panel').hidden = !opened;
  element<HTMLButtonElement>('[data-action="privacy"]').setAttribute('aria-expanded', String(opened));
  (opened ? element<HTMLElement>('#fh-access-title') : element<HTMLElement>('[data-action="privacy"]')).focus();
}
element<HTMLInputElement>('[name="captions"]').addEventListener('change', event => {
  captionsEnabled = (event.target as HTMLInputElement).checked;
  element<HTMLElement>('.fh-captions').hidden = !captionsEnabled;
});
root.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLButtonElement>('[data-action],[data-view]');
  if (!target) return;
  if (target.dataset.view) { setView(target.dataset.view === 'review' ? 'review' : 'chat'); return; }
  const action = target.dataset.action;
  if (__ANAM_PUBLIC_TEST__ && action === 'accept-demo') {
    publicDemoConsent = true;
    element<HTMLElement>('.fh-demo-consent').hidden = true;
    element<HTMLButtonElement>('[data-action="end"]').focus();
    void startConversation('voice');
  } else if (action === 'privacy') setOptions(element<HTMLElement>('.fh-access-panel').hidden === true);
  else if (action === 'options-close') setOptions(false);
  else if (action === 'keyboard') {
    captionsEnabled = true; element<HTMLInputElement>('[name="captions"]').checked = true;
    element<HTMLElement>('.fh-captions').hidden = false;
    setOptions(false); startGeneration++; voiceStarting = false;
    void voice.end().then(async () => {
      if (panel.hidden || panel.classList.contains('fh-closing')) return;
      await startConversation('text');
      if (voice.active && sessionMode === 'text' && !panel.hidden && !panel.classList.contains('fh-closing')) input.focus();
    });
  }
  else if (action === 'begin') begin();
  else if (action === 'reset') close();
  else if (action === 'example') {
    values = { ...sampleValues }; current = null; pending = null; simulated = false; updateCount();
    message('agent', 'Here is a complete made-up example to explore. You can edit any answer before simulating a submission.');
    setView('review');
  } else if (action === 'end') close();
  else if (action === 'text-only') {
    startGeneration++; voiceStarting = false; void voice.end();
    status.textContent = action === 'text-only' ? 'Guided text selected. No microphone is used. Type made-up details below.' : 'Conversation ended. Your local test draft is ready to review.';
    if (action === 'text-only') {
      element<HTMLElement>('.fh-notice').hidden = true;
      if (current) { message('agent', questions[current]); showQuestionActions(); } else begin();
    }
  }
  else if (action === 'mute') {
    const muted = voice.toggleMute(); target.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone'); target.setAttribute('aria-pressed', String(muted));
  } else if (action === 'voice' || action === 'ai-text') {
    void startConversation(action === 'voice' ? sessionMode : 'text');
  }
});
window.addEventListener('pagehide', () => { void voice.end(); });
document.addEventListener('visibilitychange', () => {
  if (__ANAM_PREVIEW__ && document.hidden && (voice.active || voiceStarting)) {
    void voice.end(); voiceEvents.status('Conversation ended while this tab was away.'); return;
  }
  if (document.hidden && voice.active) { void voice.end(); status.textContent = 'Conversation ended while this tab was away. Your local draft remains here.'; }
});
new MutationObserver(() => {
  if (document.body.classList.contains('film-open') && !panel.hidden) close();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
reset();
