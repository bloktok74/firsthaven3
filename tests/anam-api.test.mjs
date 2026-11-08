import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAnamHandler,createAnamEngineHandler} from '../server/anam-api.ts';
import {AGENT_SETUP,TESTER_AGENT_PROMPT,TEST_WEBHOOK_NAME,TEST_WEBHOOK_URL} from '../shared/agent-policy.ts';
import {TESTER_INTRODUCTION} from '../shared/intake-model.ts';
import {ANAM_DEMO_AVATAR_ID} from '../shared/anam-demo.ts';

const BASE='https://test-preview.vercel.app';
const AGENT='agent_0601m6pwks2ffjwtw76g0ppwk0ym';
const AVATAR=ANAM_DEMO_AVATAR_ID;
const VERSION='agtvrsn_FH3Fixture';
const SESSION='22345678-1234-4234-8234-123456789abc';
const OTHER_SESSION='32345678-1234-4234-8234-123456789abc';
const LEASE='a'.repeat(64);
const TOKEN='eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uSWQiOiIyMjM0NTY3OC0xMjM0LTQyMzQtODIzNC0xMjM0NTY3ODlhYmMifQ.fixture-signature';
const SIGNED='wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=fixture-private-signature';
const H=value=>createHash('sha256').update(value).digest('hex');
const NOW=Date.UTC(2026,10,6,23,59,59,999);
const START={action:'start',mode:'voice',testConsent:true};
const ENV={VERCEL_ENV:'preview',FIRST_HAVEN_ANAM_PREVIEW:'true',ANAM_API_KEY:'anam-private-key-never-client',ELEVENLABS_API_KEY:'eleven-private-key-never-client',ELEVENLABS_AGENT_ID:AGENT,ELEVENLABS_AGENT_VERSION_ID:VERSION,ANAM_AVATAR_ID:AVATAR,ANAM_QUOTA_REDIS_REST_URL:'https://fixture-redis.upstash.io',ANAM_QUOTA_REDIS_REST_TOKEN:'redis-private-key-never-client'};

function request(body=START,{path='/api/anam-assistant',method='POST',origin=BASE,headers={},raw}={}){
  return new Request(BASE+path,{method,headers:{...(origin?{Origin:origin}:{}),'Content-Type':'application/json',...headers},...(method==='POST'?{body:raw??JSON.stringify(body)}:{})});
}
function engine(body={},options={}){return request(body,{...options,path:'/api/anam-engine',headers:{Authorization:'Bearer '+TOKEN,...options.headers}});}
function fixture(overrides={}){
  const env={...ENV,...overrides};
  const agent=structuredClone(AGENT_SETUP);agent.conversation_config.agent.prompt.tool_ids=['tool_update','tool_review'];
  const state={events:[],calls:[],lease:null,issuances:0,forcedReservation:null,releaseCalls:[],bindCalls:[],stopOk:true,bindSessionOk:true,avatarVersions:['cara-4.1-express'],tokenResponse:{sessionToken:TOKEN,unexpectedPrivateField:'private-upstream'},engineResponse:{sessionId:SESSION,clientConfig:{iceServers:[]},engineHost:'engine.fixture.anam.ai',engineProtocol:'https',signallingEndpoint:'wss://signalling.fixture.anam.ai',region:'eu',unexpectedPrivateField:'private-upstream',signedUrl:SIGNED,apiKey:ENV.ANAM_API_KEY},fault:null,agent};
  const quota={
    async reserve(owner,now){state.events.push('reserve');assert.equal(now,NOW);if(state.forcedReservation)return state.forcedReservation;if(state.lease)return 'already_active';state.issuances++;state.lease={owner,claimed:false};return 'ok';},
    async bindToken(owner,tokenHash){state.events.push('bindToken');assert.match(tokenHash,/^[a-f0-9]{64}$/);if(state.lease?.owner!==owner||state.lease.tokenHash)return false;state.lease.tokenHash=tokenHash;return true;},
    async claimToken(tokenHash){state.events.push('claimToken');if(state.lease?.tokenHash!==tokenHash||state.lease.claimed)return null;state.lease.claimed=true;return state.lease.owner;},
    async bindSession(owner,id){state.bindCalls.push({owner,id});if(!state.bindSessionOk||state.lease?.owner!==owner||!state.lease.claimed)return false;state.lease.sessionId=id;return true;},
    async lookup(owner){if(state.lease?.owner!==owner)return null;const {owner:_,...lease}=state.lease;return {...lease};},
    async release(owner,stopConfirmed=false){state.releaseCalls.push({owner,stopConfirmed});if(state.lease?.owner!==owner||state.lease.tokenHash&&!(stopConfirmed&&state.lease.sessionId))return false;state.lease=null;return true;},
  };
  const hooks=[{webhook_id:AGENT_SETUP.platform_settings.workspace_overrides.webhooks.post_call_webhook_id,is_disabled:true,name:TEST_WEBHOOK_NAME,webhook_url:TEST_WEBHOOK_URL}];
  const fetcher=async(url,options={})=>{
    const target=String(url),method=options.method||'GET';state.calls.push({url:target,method,options});state.events.push('provider:'+new URL(target).pathname);
    assert.equal(options.redirect,'error');
    if(state.fault){const response=state.fault(target,options);if(response)return response;}
    if(target.startsWith('https://api.elevenlabs.io/')){
      assert.equal(options.headers['xi-api-key'],env.ELEVENLABS_API_KEY);
      if(target.includes('/convai/agents/')){assert.equal(new URL(target).searchParams.get('version_id'),VERSION);return Response.json({...agent,version_id:state.versionId||VERSION});}
      if(target.includes('/convai/tools/'))return Response.json({tool_config:{type:'client',name:target.endsWith('tool_update')?'update_test_intake':'show_test_review'}});
      if(target.endsWith('/convai/settings'))return Response.json({webhooks:{post_call_webhook_id:'existing-live-hook'}});
      if(target.endsWith('/workspace/webhooks'))return Response.json({webhooks:hooks});
      if(target.includes('/conversation/get-signed-url?')){assert.match(target,/include_conversation_id=true/);assert.equal(new URL(target).searchParams.get('version_id'),VERSION);return Response.json({signed_url:SIGNED});}
    }
    if(target.startsWith('https://api.anam.ai/')){
      assert.equal(options.headers.Authorization,'Bearer '+(target.endsWith('/engine/session')?TOKEN:env.ANAM_API_KEY));
      if(target==='https://api.anam.ai/v1/avatars/'+env.ANAM_AVATAR_ID)return Response.json({id:env.ANAM_AVATAR_ID,availableVersions:state.avatarVersions});
      if(target==='https://api.anam.ai/v1/auth/session-token')return Response.json(state.tokenResponse);
      if(target==='https://api.anam.ai/v1/engine/session')return Response.json(state.engineResponse);
      if(target==='https://api.anam.ai/v1/sessions/'+SESSION+'/stop')return new Response('',{status:state.stopOk?200:500});
    }
    throw Error('Unexpected fixture provider request');
  };
  const dependencies={fetcher,quota,now:()=>NOW,nonce:()=>LEASE};
  return {env,state,quota,fetcher,dependencies,start:createAnamHandler(env,dependencies),engine:createAnamEngineHandler(env,dependencies),hooks};
}
function minted(state){return state.calls.filter(call=>call.url==='https://api.anam.ai/v1/auth/session-token');}
function engineCalls(state){return state.calls.filter(call=>call.url==='https://api.anam.ai/v1/engine/session');}
async function safe(response){const text=await response.text();for(const value of [ENV.ANAM_API_KEY,ENV.ELEVENLABS_API_KEY,ENV.ANAM_QUOTA_REDIS_REST_TOKEN,SIGNED,'private-upstream','fixture-private-signature'])assert.ok(!text.includes(value),'Private provider content must not reach client');return JSON.parse(text);}

test('Anam API and engine are disabled without the matching environment opt-in',async()=>{
  for(const overrides of [{VERCEL_ENV:'production',FIRST_HAVEN_PUBLIC_TEST:'true'},{VERCEL_ENV:'production',FIRST_HAVEN_ANAM_PUBLIC_TEST:'true'},{VERCEL_ENV:'development',INTAKE_LOCAL_TEST:'true'},{FIRST_HAVEN_ANAM_PREVIEW:'false'}]){
    const f=fixture(overrides);for(const handler of [f.start,f.engine])for(const method of ['GET','POST'])assert.equal((await handler(request(undefined,{method}))).status,404);
    assert.equal(f.state.calls.length,0);assert.equal(f.state.issuances,0);
  }
});

test('Public URL tester access is verified before reserving quota or contacting providers', async () => {
  const code='Z'.repeat(43);
  const f=fixture({VERCEL_ENV:'production',FIRST_HAVEN_ANAM_TESTER_DEMO:'true',ANAM_TESTER_ACCESS_CODE_SHA256:H(code),ANAM_TEST_REPORT_RETENTION:'approved'});
  const verify={action:'verify_tester',accessCode:code};
  assert.equal((await f.start(request(verify,{origin:'https://outside.example'}))).status,403);
  assert.equal((await f.start(request({...verify,mode:'voice'}))).status,403);
  assert.equal((await f.start(request({...verify,accessCode:'x'.repeat(43)}))).status,403);
  assert.equal((await f.start(request(START))).status,403);
  assert.equal((await f.start(request({...START,accessCode:'x'.repeat(43)}))).status,403);
  assert.equal((await f.engine(engine())).status,403);
  assert.deepEqual(await safe(await f.start(request(verify))),{authorized:true});
  assert.equal(f.state.issuances,0);assert.equal(f.state.calls.length,0);
  const unconfigured=fixture({VERCEL_ENV:'production',FIRST_HAVEN_ANAM_TESTER_DEMO:'true'});
  assert.equal((await unconfigured.start(request(verify))).status,503);
  assert.equal((await unconfigured.start(request({...START,accessCode:code}))).status,503);
  assert.equal(unconfigured.state.calls.length,0);

  assert.equal((await f.start(request({...START,accessCode:code}))).status,412);
  assert.equal(minted(f.state).length,0,'Old agent greeting is rejected');
  f.state.agent.conversation_config.agent.first_message=TESTER_INTRODUCTION;
  f.state.agent.conversation_config.agent.prompt.prompt=TESTER_AGENT_PROMPT;
  assert.equal((await f.start(request({...START,accessCode:code}))).status,200);
  const body=JSON.parse(minted(f.state)[0].options.body);
  assert.equal(body.clientLabel,'first-haven3-fictional-tester');
  assert.equal(body.personaConfig.zeroDataRetention,false);
  assert.deepEqual(body.sessionOptions.dataRetention,{recording:false,transcripts:false});
  assert.ok(!JSON.stringify(body).includes(code));
});

test('A mismatched ElevenLabs version never signs or mints an Anam session', async () => {
  const f = fixture();
  f.state.versionId = 'agtvrsn_Different';
  assert.equal((await f.start(request())).status, 412);
  assert.equal(minted(f.state).length, 0);
  assert.ok(!f.state.calls.some(call => call.url.includes('get-signed-url')));
});
test('Anam request gates reject malformed, cross-origin and data-bearing input before quotas or providers',async()=>{
  const f=fixture();
  for(const [input,status]of [[request(START,{origin:'https://evil.example'}),403],[request(START,{origin:''}),403],[request(START,{headers:{'Sec-Fetch-Site':'cross-site'}}),403],[request({...START,testConsent:false}),400],[request({...START,mode:'other'}),400],[request({...START,customerEmail:'person@example.com'}),400],[request({...START,personaConfig:{name:'Override'}}),400],[request({...START,environment:{}}),400],[request({}, {raw:'private-upstream-not-json'}),400],[request([]),400],[request(START,{headers:{'Content-Type':'text/plain'}}),400],[request(START,{raw:' '.repeat(2049)}),400],[request(START,{headers:{'Content-Length':'2049'}}),400]])assert.equal((await f.start(input)).status,status);
  assert.equal((await f.start(request(undefined,{method:'OPTIONS'}))).status,405);
  assert.equal(f.state.calls.length,0);assert.equal(f.state.issuances,0);
});

test('Anam missing durable store or provider configuration fails closed without minting',async()=>{
  const f=fixture();const env={...f.env,ANAM_QUOTA_REDIS_REST_URL:'',ANAM_QUOTA_REDIS_REST_TOKEN:''};
  const handler=createAnamHandler(env,{fetcher:f.fetcher,now:()=>NOW,nonce:()=>LEASE});
  assert.equal((await handler(request())).status,503);assert.equal((await createAnamEngineHandler(env,{fetcher:f.fetcher})(engine())).status,503);
  assert.equal(f.state.calls.length,0);
  const missing=fixture({ANAM_API_KEY:''});assert.equal((await missing.start(request())).status,503);assert.equal(missing.state.calls.length,0);
});

test('Anam reserves before provider requests and busy/daily rejections never mint tokens',async()=>{
  for(const status of ['daily_limit','already_active']){
    const f=fixture();f.state.forcedReservation=status;const response=await f.start(request());assert.equal(response.status,429);assert.deepEqual(await response.json(),{error:status});assert.equal(f.state.calls.length,0);
  }
  const f=fixture();assert.equal((await f.start(request())).status,200);assert.equal(f.state.events[0],'reserve');assert.equal(f.state.issuances,1);
});

test('Anam mint binds model, portrait, strict retention, duration and single-use expiry server-side',async()=>{
  const f=fixture({ANAM_PRIVACY_MODE:'synthetic_reports_approved'});const response=await f.start(request());assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store, private');
  assert.deepEqual(await safe(response),{sessionToken:TOKEN,leaseToken:LEASE,syntheticOnly:true,maxSeconds:180});
  assert.equal(minted(f.state).length,1);const body=JSON.parse(minted(f.state)[0].options.body);
  assert.equal(body.maxSessions,1);assert.equal(body.expiresInSeconds,120);
  assert.deepEqual(body.personaConfig,{name:'Jessica — TEST',avatarId:AVATAR,avatarModel:'cara-4.1-express',maxSessionLengthSeconds:180,zeroDataRetention:true,directorNotes:{presetStyle:'warm',expressivity:.5}});
  assert.deepEqual(body.sessionOptions,{dataRetention:{recording:false,transcripts:false},videoWidth:768,videoHeight:1152,videoQuality:'auto'});
  assert.deepEqual(body.environment,{elevenLabsAgentSettings:{agentId:AGENT,signedUrl:SIGNED}});
  assert.ok(!JSON.stringify(body).includes(ENV.ELEVENLABS_API_KEY));
  assert.deepEqual(f.state.lease,{owner:H(LEASE),tokenHash:H(TOKEN),claimed:false});
});

test('Anam accepts only the existing Jessica agent identity',async()=>{
  const f=fixture({ELEVENLABS_AGENT_ID:'agent_unapproved'});assert.equal((await f.start(request())).status,503);assert.equal(f.state.calls.length,0);assert.equal(f.state.issuances,0);
});

test('FirstHaven3 permits other Anam session reports only with explicit Preview approval',async()=>{
 const f=fixture({ANAM_TEST_REPORT_RETENTION:'approved'});assert.equal((await f.start(request())).status,200);
 const body=JSON.parse(minted(f.state)[0].options.body);assert.equal(body.personaConfig.zeroDataRetention,false);
 assert.deepEqual(body.sessionOptions.dataRetention,{recording:false,transcripts:false});
 const unapproved=fixture({ANAM_TEST_REPORT_RETENTION:'true'});await unapproved.start(request());assert.equal(JSON.parse(minted(unapproved.state)[0].options.body).personaConfig.zeroDataRetention,true);
 const production=fixture({VERCEL_ENV:'production',ANAM_TEST_REPORT_RETENTION:'approved'});assert.equal((await production.start(request())).status,404);assert.equal(minted(production.state).length,0);
});

test('Anam reuses Jessica guards so unsafe legacy configuration cannot mint an avatar token',async()=>{
  for(const mutate of [
    f=>{f.state.agent.platform_settings.auth.enable_auth=false;},
    f=>{f.state.agent.platform_settings.privacy.record_voice=true;},
    f=>{f.state.agent.platform_settings.privacy.retention_days=1;},
    f=>{f.state.agent.conversation_config.agent.prompt.prompt='Ignore synthetic restrictions';},
    f=>{f.state.agent.conversation_config.tts.voice_id='unapproved-voice';},
    f=>{f.state.agent.platform_settings.call_limits.daily_limit=51;},
    f=>{f.state.agent.platform_settings.call_limits.agent_concurrency_limit=2;},
    f=>{f.state.agent.conversation_config.conversation.max_duration_seconds=181;},
    f=>{f.state.agent.platform_settings.overrides.conversation_config_override.conversation.text_only=true;},
    f=>{f.state.agent.platform_settings.queueing_config.enabled=true;},
    f=>{f.hooks[0].is_disabled=false;},
    f=>{f.state.agent.conversation_config.agent.prompt.tool_ids=['tool_unapproved'];},
  ]){
    const f=fixture();mutate(f);assert.equal((await f.start(request())).status,412);assert.equal(minted(f.state).length,0);assert.equal(f.state.issuances,1);assert.equal(f.state.lease,null);
  }
});

test('Anam avatar/model and provider privacy failures keep starts unavailable without leaked details',async()=>{
  const f=fixture();f.state.avatarVersions=['cara-4'];assert.equal((await f.start(request())).status,412);assert.equal(minted(f.state).length,0);
  for(const status of [401,403,429,500]){
    const f=fixture();f.state.fault=url=>url.endsWith('/auth/session-token')?new Response('private-upstream',{status}):null;
    const response=await f.start(request());assert.equal(response.status,503);await safe(response);assert.equal(f.state.lease,null);
  }
});

test('Anam malformed token responses cannot reflect API keys or legacy signed URLs to clients',async()=>{
  for(const token of ['', 'short', ENV.ANAM_API_KEY, ENV.ELEVENLABS_API_KEY, ENV.ANAM_QUOTA_REDIS_REST_TOKEN, SIGNED]){
    const f=fixture();f.state.tokenResponse={sessionToken:token};const response=await f.start(request());assert.equal(response.status,503);await safe(response);
  }
});

test('Anam JWT-shaped configured API keys cannot be mistaken for session tokens',async()=>{
  for(const key of ['ANAM_API_KEY','ELEVENLABS_API_KEY','ANAM_QUOTA_REDIS_REST_TOKEN']){
    const f=fixture({[key]:TOKEN});const response=await f.start(request());assert.equal(response.status,503);assert.ok(!(await response.text()).includes(TOKEN));
  }
});

test('Anam engine gateway claims once, uses one fixed URL, binds its session and whitelists response',async()=>{
  const f=fixture();await f.start(request());
  const response=await f.engine(engine({clientMetadata:{url:'https://evil.example',private:'not-forwarded'},sessionOptions:{}}));assert.equal(response.status,200);
  const data=await safe(response);assert.deepEqual(Object.keys(data).sort(),['clientConfig','engineHost','engineProtocol','region','sessionId','signallingEndpoint']);assert.equal(data.sessionId,SESSION);
  assert.equal(engineCalls(f.state).length,1);assert.equal(engineCalls(f.state)[0].options.body,'{}');
  assert.deepEqual(f.state.bindCalls,[{owner:H(LEASE),id:SESSION}]);
  assert.equal((await f.engine(engine())).status,403);assert.equal(engineCalls(f.state).length,1);
});

test('Anam engine rejects override/target/session input before claiming a token or reaching providers',async()=>{
  const f=fixture();await f.start(request());const calls=f.state.calls.length;
  for(const [input,status]of [[engine({personaConfig:{}}),400],[engine({environment:{}}),400],[engine({url:'https://evil.example'}),400],[engine({sessionId:OTHER_SESSION}),400],[engine({sessionOptions:{dataRetention:{recording:true}}}),400],[engine({sessionOptions:[]}),400],[engine({}, {origin:'https://evil.example'}),403],[engine({}, {origin:''}),403],[engine({}, {headers:{Authorization:'Basic private'}}),403],[engine({}, {raw:'not-json'}),400],[engine({}, {raw:' '.repeat(4097)}),400]])assert.equal((await f.engine(input)).status,status);
  assert.equal(f.state.calls.length,calls);assert.equal(f.state.lease.claimed,false);
});

test('Anam engine rejects unknown tokens and safely stops any session that cannot bind its lease',async()=>{
  const f=fixture();assert.equal((await f.engine(engine())).status,403);assert.equal(f.state.calls.length,0);
  await f.start(request());f.state.bindSessionOk=false;
  assert.equal((await f.engine(engine())).status,403);assert.ok(f.state.calls.some(call=>call.url.endsWith('/sessions/'+SESSION+'/stop')));assert.equal(f.state.lease.tokenHash,H(TOKEN));
});

test('Anam engine racing claims can create only one upstream session',async()=>{
  const f=fixture();await f.start(request());
  const replies=await Promise.all(Array.from({length:24},()=>f.engine(engine())));
  assert.equal(replies.filter(response=>response.status===200).length,1);
  assert.equal(replies.filter(response=>response.status===403).length,23);
  assert.equal(engineCalls(f.state).length,1);assert.equal(f.state.bindCalls.length,1);
});

test('Anam engine nested client configuration cannot expose provider secrets or the legacy signed URL',async()=>{
  for(const privateValue of [ENV.ANAM_API_KEY,ENV.ELEVENLABS_API_KEY,ENV.ANAM_QUOTA_REDIS_REST_TOKEN,SIGNED]){
    const f=fixture();await f.start(request());
    f.state.engineResponse.clientConfig={iceServers:[],unexpectedNestedProviderField:{value:privateValue}};
    const response=await f.engine(engine());assert.ok([200,503].includes(response.status));await safe(response);
  }
});

test('Anam end is scoped to its lease, holds unused bound tokens and never accepts a client session ID',async()=>{
  const f=fixture();await f.start(request());
  assert.equal((await f.start(request({action:'end',leaseToken:'b'.repeat(64)}))).status,200);assert.ok(f.state.lease);assert.equal(f.state.calls.filter(call=>call.url.endsWith('/stop')).length,0);
  assert.equal((await f.start(request({action:'end',leaseToken:LEASE,sessionId:OTHER_SESSION}))).status,400);
  const held=await f.start(request({action:'end',leaseToken:LEASE}));assert.equal(held.status,202);assert.deepEqual(await held.json(),{ended:true,leaseHeldUntilExpiry:true});assert.ok(f.state.lease);
  await f.engine(engine());const ended=await f.start(request({action:'end',leaseToken:LEASE}));assert.equal(ended.status,200);assert.deepEqual(await ended.json(),{ended:true});assert.equal(f.state.lease,null);
  assert.deepEqual(f.state.releaseCalls.at(-1),{owner:H(LEASE),stopConfirmed:true});
});

test('Anam failed provider stop retains the lease and returns only a safe pending error',async()=>{
  const f=fixture();await f.start(request());await f.engine(engine());f.state.stopOk=false;
  const response=await f.start(request({action:'end',leaseToken:LEASE}));assert.equal(response.status,502);assert.deepEqual(await safe(response),{error:'session_stop_pending'});assert.ok(f.state.lease);assert.equal(f.state.releaseCalls.length,0);
});

test('Anam unexpected successful HTTP statuses cannot confirm provider termination or release its lease',async()=>{
  for(const status of [202,204]){
    const f=fixture();assert.equal((await f.start(request())).status,200);assert.equal((await f.engine(engine())).status,200);
    const held=structuredClone(f.state.lease),releases=f.state.releaseCalls.length;
    f.state.fault=url=>url==='https://api.anam.ai/v1/sessions/'+SESSION+'/stop'?new Response(null,{status}):null;
    const response=await f.start(request({action:'end',leaseToken:LEASE}));
    assert.equal(response.status,502);assert.deepEqual(await safe(response),{error:'session_stop_pending'});
    assert.deepEqual(f.state.lease,held);assert.equal(f.state.releaseCalls.length,releases);
  }
});

test('Anam failed engine starts retain the claimed lease and malformed IDs never become stop targets',async()=>{
  for(const status of [401,429,500]){
    const f=fixture();await f.start(request());f.state.fault=url=>url.endsWith('/engine/session')?new Response('private-upstream',{status}):null;
    const response=await f.engine(engine());assert.equal(response.status,status===429?429:503);await safe(response);assert.equal(f.state.lease.claimed,true);assert.equal(f.state.releaseCalls.length,0);
  }
  const f=fixture();await f.start(request());f.state.engineResponse.sessionId='https://evil.example/terminate';
  const response=await f.engine(engine());assert.equal(response.status,503);assert.equal(f.state.bindCalls.length,0);assert.equal(f.state.calls.filter(call=>call.url.endsWith('/stop')).length,0);assert.equal(f.state.lease.claimed,true);
});

test('Anam start and engine sanitize malformed provider JSON and thrown transport/header errors',async()=>{
  for(const stage of ['avatar','mint','engine'])for(const fault of ['malformed','throw']){
    const f=fixture();if(stage==='engine')await f.start(request());
    f.state.fault=url=>{
      if((stage==='avatar'&&url.includes('/v1/avatars/'))||(stage==='mint'&&url.endsWith('/auth/session-token'))||(stage==='engine'&&url.endsWith('/engine/session'))){if(fault==='throw')throw Error(ENV.ANAM_API_KEY+' private-upstream');return new Response('private-upstream-not-json',{status:200});}return null;
    };
    const response=await(stage==='engine'?f.engine(engine()):f.start(request()));assert.equal(response.status,503);await safe(response);
    if(stage==='engine')assert.ok(f.state.lease);else assert.equal(f.state.lease,null);
  }
});
