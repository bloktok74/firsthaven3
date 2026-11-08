import { isDeepStrictEqual } from 'node:util';
import { AGENT_PROMPT } from '../shared/agent-policy.ts';
import { createAssistantHandler } from '../server/assistant-api.ts';

const env = process.env;
const id = 'agent_0601m6pwks2ffjwtw76g0ppwk0ym';
const name = 'firsthaven3-synthetic-names';
if (env.VERCEL_ENV !== 'preview' || env.VERCEL_PROJECT_ID !== 'prj_uEwPrskHA8j8rMIEDTEAxuvim8X4'
    || env.FIRSTHAVEN3_PREPARE_INTAKE !== 'true' || !env.ELEVENLABS_API_KEY) {
  throw Error('Run only as an explicitly requested FirstHaven3 Preview setup with server credentials.');
}
const base = 'https://api.elevenlabs.io/v1/convai/agents/' + id;
async function request(path = '', payload) {
  const response = await fetch(base + path, {
    method: payload ? 'POST' : 'GET',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, ...(payload && { 'Content-Type': 'application/json' }) },
    ...(payload && { body: JSON.stringify(payload) }),
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = (await response.text()).toLowerCase();
    const signals = ['versioning is not enabled', 'versioning is not supported', 'versioning is disabled', 'agent_versioning_not_enabled', 'branching', 'upgrade', 'permission', 'subscription', 'not allowed', 'validation', 'name already', 'parent version', 'requires', 'not enabled'].filter(signal => body.includes(signal));
    throw Error('ElevenLabs ' + (payload ? 'branch creation' : 'configuration check') + ' failed (HTTP ' + response.status + ')' + (signals.length ? ' [' + signals.join(', ') + ']' : '') + '.');
  }
  return response.json();
}

const main = await request();
if (!/^agtvrsn_[a-zA-Z0-9]+$/.test(main.version_id || '')) throw Error('Existing agent version unavailable.');
const expected = structuredClone(main.conversation_config);
const previousPrompt = expected.agent?.prompt?.prompt;
if (typeof previousPrompt !== 'string') throw Error('Existing intake prompt unavailable.');
const onlyAllowedChange = previousPrompt
  .replace('FIRST_HAVEN_TEST_INTAKE_V1', 'FIRST_HAVEN3_TEST_INTAKE_V1')
  .replace('names beginning with Test or ending with Example', 'fictional first and last names without any required prefix or suffix')
  .replace('Test Jordan Example', 'Jordan Smith');
if (onlyAllowedChange.replace(/\r\n/g, '\n').trim() !== AGENT_PROMPT.replace(/\r\n/g, '\n').trim()) {
  throw Error('Existing intake prompt has drifted. No agent changes were made.');
}
expected.agent.prompt.prompt = AGENT_PROMPT;
const branches = await request('/branches');
if (!Array.isArray(branches.results)) throw Error('ElevenLabs branch list unavailable.');
let branch = branches.results.find(item => item.name === name && !item.is_archived);
if (!branch) {
  const created = await request('/branches', {
    parent_version_id: main.version_id, name,
    description: 'FirstHaven3 protected fictional-name intake only. Do not route default traffic here.',
    conversation_config: { agent: { prompt: { prompt: AGENT_PROMPT } } },
  });
  branch = (await request('/branches')).results.find(item => item.id === created.created_branch_id);
}
if (!branch || branch.id === main.branch_id || branch.current_live_percentage !== 0) {
  throw Error('FirstHaven3 branch must have zero default traffic.');
}
const candidate = await request('?' + new URLSearchParams({ branch_id: branch.id }));
if (!/^agtvrsn_[a-zA-Z0-9]+$/.test(candidate.version_id || '') || candidate.version_id === main.version_id
    || !isDeepStrictEqual(candidate.conversation_config, expected)
    || ['platform_settings','workflow','procedures','phone_numbers','whatsapp_accounts'].some(key => !isDeepStrictEqual(candidate[key], main[key]))) {
  throw Error('Branch configuration differs beyond the approved prompt. Do not deploy it.');
}
const origin = 'https://firsthaven3.vercel.app';
const check = await createAssistantHandler({
  ...env, FIRST_HAVEN_ANAM_PREVIEW: 'false',
  ELEVENLABS_AGENT_ID: id, ELEVENLABS_AGENT_VERSION_ID: candidate.version_id,
})(new Request(origin + '/api/anam-session', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'start', mode: 'voice', testConsent: true }),
}));
if (!check.ok) throw Error('Pinned branch safety and signed URL check failed (HTTP ' + check.status + ').');
const after = await request();
if (after.version_id !== main.version_id || after.branch_id !== main.branch_id) {
  throw Error('Default ElevenLabs version changed during setup. Investigate before deployment.');
}
console.log(JSON.stringify({ firstHaven3Version: candidate.version_id, zeroDefaultTraffic: true, originalVersionPreserved: true }));
