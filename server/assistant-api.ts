import { AGENT_PROMPT, TEST_WEBHOOK_NAME, TEST_WEBHOOK_URL } from '../shared/agent-policy.ts';
import { INTRODUCTION, JESSICA_VOICE_ID, JESSICA_DAILY_SESSION_LIMIT } from '../shared/intake-model.ts';
import { isAnamDemo } from '../shared/anam-demo.ts';

type Json = Record<string, unknown>;
type Environment = Record<string, string | undefined>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const active = (value: unknown): boolean => value !== null && value !== undefined && value !== false && value !== '' && !(Array.isArray(value) && !value.length) && !(typeof value === 'object' && !Object.keys(object(value)).length);

export function hasExternalWebhook(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const destination = (entry: unknown): boolean => {
    if (!entry || typeof entry !== 'object') return active(entry);
    return Object.entries(entry).some(([key, child]) => !['events', 'transcript_format', 'exclude_transcript', 'send_audio'].includes(key) && destination(child));
  };
  return Object.entries(value).some(([key, child]) => (/webhook/i.test(key) && destination(child)) || hasExternalWebhook(child));
}

function unsafeOverride(value: unknown, path = '', allowPriorTextPool = false): boolean {
  if (value && typeof value === 'object') return Object.entries(value).some(([key, child]) => unsafeOverride(child, path ? path + '.' + key : key, allowPriorTextPool));
  return active(value) && !(allowPriorTextPool && path === 'conversation_config_override.conversation.text_only' && value === true);
}

function testWebhookConfigured(agent: unknown): boolean {
  const hooks = object(object(object(object(agent).platform_settings).workspace_overrides).webhooks);
  return typeof hooks.post_call_webhook_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(hooks.post_call_webhook_id) && Array.isArray(hooks.events) && hooks.events.length === 1 && hooks.events[0] === 'transcript' && hooks.send_audio === false;
}

export function checkWorkspacePolicy(workspace: unknown, agent: unknown, webhooks: unknown[] = []): string[] {
  const settings = { ...object(workspace) };
  // ElevenLabs normalizes an empty event list back to transcript events. Require
  // an explicit agent override to our disabled test sink instead of inheriting.
  delete settings.webhooks;
  if (hasExternalWebhook(settings)) return ['workspace_webhooks'];
  if (!testWebhookConfigured(agent)) return ['disabled_test_webhook'];
  const id = object(object(object(object(agent).platform_settings).workspace_overrides).webhooks).post_call_webhook_id;
  const selected = webhooks.map(object).find(hook => hook.webhook_id === id);
  if (!selected || selected.is_disabled !== true || selected.name !== TEST_WEBHOOK_NAME || selected.webhook_url !== TEST_WEBHOOK_URL) return ['disabled_test_webhook'];
  return [];
}

export function checkPublicTestLimits(agent: unknown): string[] {
  const data = object(agent);
  const duration = object(object(data.conversation_config).conversation).max_duration_seconds;
  const limits = object(object(data.platform_settings).call_limits);
  return typeof duration === 'number' && duration > 0 && duration <= 180 &&
    typeof limits.daily_limit === 'number' && Number.isSafeInteger(limits.daily_limit) && limits.daily_limit > 0 && limits.daily_limit <= JESSICA_DAILY_SESSION_LIMIT &&
    limits.agent_concurrency_limit === 1 && limits.bursting_enabled === false ? [] : ['public_test_limits'];
}

function hasExecutableWorkflow(value: unknown): boolean {
  if (!active(value)) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const workflow = object(value);
  if (Object.entries(workflow).some(([key, child]) => !['edges', 'nodes', 'subgraphs', 'prevent_subagent_loops'].includes(key) && active(child))) return true;
  if (active(workflow.edges) || active(workflow.subgraphs)) return true;
  const nodes = Object.values(object(workflow.nodes)).map(object);
  if (nodes.length > 1) return true;
  return nodes.some(node => node.type !== 'start' || active(node.edge_order) || node.parent_subgraph_id != null || Object.keys(node).some(key => !['type', 'position', 'edge_order', 'label', 'parent_subgraph_id'].includes(key)));
}

export function checkAgentPolicy(agent: unknown, tools: unknown[], allowPriorTextPool = false): string[] {
  const data = object(agent);
  const config = object(data.conversation_config);
  const persona = object(config.agent);
  const prompt = object(persona.prompt);
  const platform = object(data.platform_settings);
  const privacy = object(platform.privacy);
  const problems: string[] = [];
  const normalized = (value: unknown) => typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (normalized(prompt.prompt) !== normalized(AGENT_PROMPT)) problems.push('test_prompt');
  if (persona.first_message !== INTRODUCTION) problems.push('first_message');
  if (object(config.tts).voice_id !== JESSICA_VOICE_ID) problems.push('jessica_voice');
  const duration = object(config.conversation).max_duration_seconds;
  if (typeof duration !== 'number' || duration <= 0 || duration > 600) problems.push('duration_limit');
  if (object(platform.auth).enable_auth !== true) problems.push('private_agent');
  if (privacy.record_voice !== false || privacy.retention_days !== 0) problems.push('privacy');
  const outsideSink = { ...data, platform_settings: { ...platform, workspace_overrides: { ...object(platform.workspace_overrides), webhooks: null } } };
  if (hasExternalWebhook(outsideSink)) problems.push('webhooks');
  if (!testWebhookConfigured(data)) problems.push('webhook_isolation');
  if (unsafeOverride(platform.overrides, '', allowPriorTextPool)) problems.push('unsafe_overrides');
  // Setup migration alone may inspect the prior chat-pool configuration. All
  // request handlers use the strict default; clients cannot select that pool.
  if (!allowPriorTextPool && object(config.conversation).text_only !== false) problems.push('shared_session_pool');
  if (!allowPriorTextPool && object(platform.queueing_config).enabled !== false) problems.push('session_queue');
  if (hasExecutableWorkflow(data.workflow) || active(data.procedures) || active(data.phone_numbers) || active(data.whatsapp_accounts) || active(config.language_presets) || active(prompt.knowledge_base) || active(prompt.custom_llm) || active(prompt.native_mcp_server_ids)) problems.push('extra_integrations');
  const builtins = object(prompt.built_in_tools);
  if (Object.entries(builtins).some(([name, value]) => name !== 'end_call' && active(value))) problems.push('external_system_tools');
  const ids = Array.isArray(prompt.tool_ids) ? prompt.tool_ids : [];
  if (ids.length !== 2 || tools.length !== 2) problems.push('client_tools');
  const names = tools.map(tool => {
    const config = object(object(tool).tool_config);
    if (config.type !== 'client') problems.push('external_tools');
    return config.name;
  }).sort();
  if (names.join(',') !== 'show_test_review,update_test_intake') problems.push('client_tools');
  return [...new Set(problems)];
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store, private', 'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
  } });
}

export function createAssistantHandler(env: Environment, fetcher: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    // Production requires a separately approved explicit opt-in and verified
    // provider limits. A key or a local-test flag alone never enables it.
    if (isAnamDemo(env) && request.method !== 'GET') return json({ error: 'anam_preview_only' }, 403);
    if (env.VERCEL_ENV !== 'preview') return json({ error: 'preview_only' }, 404);
    const versionId = env.ELEVENLABS_AGENT_VERSION_ID || '';
    const configured = Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID && /^agtvrsn_[a-zA-Z0-9]+$/.test(versionId));
    if (request.method === 'GET') return json({ configured, syntheticOnly: true, voiceName: 'Jessica' });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const url = new URL(request.url);
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'same_origin_required' }, 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'json_required' }, 415);
    if (Number(request.headers.get('content-length') || 0) > 1024) return json({ error: 'request_too_large' }, 413);
    let body: Json;
    try {
      const raw = await request.text();
      if (raw.length > 1024) return json({ error: 'request_too_large' }, 413);
      body = object(JSON.parse(raw));
    } catch { return json({ error: 'invalid_request' }, 400); }
    if (body.action !== 'start' || body.testConsent !== true || !['voice', 'text'].includes(String(body.mode)) || Object.keys(body).some(key => !['action', 'mode', 'testConsent'].includes(key))) return json({ error: 'test_consent_required' }, 400);
    if (!configured) return json({ error: 'voice_not_configured' }, 503);
    const agentId = env.ELEVENLABS_AGENT_ID!;
    if (!/^agent_[a-zA-Z0-9]+$/.test(agentId)) return json({ error: 'invalid_agent_configuration' }, 503);
    const upstream = async (path: string, section: 'convai' | 'workspace' = 'convai') => {
      const response = await fetcher('https://api.elevenlabs.io/v1/' + section + '/' + path, {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY! }, signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) throw new Error('provider_request_failed');
      return object(await response.json());
    };
    try {
      const agent = await upstream('agents/' + encodeURIComponent(agentId) + '?' + new URLSearchParams({ version_id: versionId }));
      if (agent.version_id !== versionId) return json({ error: 'test_agent_setup_required', checks: ['agent_version'] }, 412);
      const ids = object(object(object(agent.conversation_config).agent).prompt).tool_ids;
      if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id => typeof id !== 'string' || !/^tool_[a-zA-Z0-9]+$/.test(id))) return json({ error: 'test_agent_setup_required', checks: ['client_tools'] }, 412);
      const tools = await Promise.all(ids.map(id => upstream('tools/' + encodeURIComponent(String(id)))));
      const problems = checkAgentPolicy(agent, tools);
      problems.push(...checkPublicTestLimits(agent));
      if (problems.length) return json({ error: 'test_agent_setup_required', checks: problems }, 412);
      // Workspace webhooks are inherited even when the agent has no endpoint.
      // Inspect them read-only; never modify the owner's existing integrations.
      const workspace = await upstream('settings');
      const webhookList = await upstream('webhooks', 'workspace');
      const workspaceProblems = checkWorkspacePolicy(workspace, agent, Array.isArray(webhookList.webhooks) ? webhookList.webhooks : []);
      if (workspaceProblems.length) return json({ error: 'test_agent_setup_required', checks: workspaceProblems }, 412);
      const signed = await upstream('conversation/get-signed-url?' + new URLSearchParams({ agent_id: agentId, include_conversation_id: 'true', version_id: versionId }));
      const signedUrl = typeof signed.signed_url === 'string' ? new URL(signed.signed_url) : null;
      if (!signedUrl || signedUrl.protocol !== 'wss:' || signedUrl.hostname !== 'api.elevenlabs.io' || !signedUrl.pathname.startsWith('/v1/convai/conversation')) throw new Error('invalid_provider_response');
      return json({ signedUrl: signedUrl.href, syntheticOnly: true, voiceName: 'Jessica' });
    } catch {
      // Never log upstream bodies, signed URLs, API keys, or transcripts.
      return json({ error: 'voice_temporarily_unavailable' }, 502);
    }
  };
}
