import {createHash,randomBytes} from 'node:crypto';
import {createAssistantHandler} from './assistant-api.ts';
import {createAnamQuota} from './anam-quota.ts';
import {ANAM_DEMO_AVATAR_ID,ANAM_DEMO_MAX_SECONDS,isAnamDemo} from '../shared/anam-demo.ts';

type Environment=Record<string,string|undefined>;
type Quota=ReturnType<typeof createAnamQuota>;
type Dependencies={fetcher?:typeof fetch;quota?:Quota;now?:()=>number;nonce?:()=>string};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const JESSICA_AGENT_ID='agent_0601m6pwks2ffjwtw76g0ppwk0ym';
function containsProviderSecret(value:unknown,env:Environment):boolean{
 const text=JSON.stringify(value);
 return [env.ANAM_API_KEY,env.ELEVENLABS_API_KEY,env.ANAM_QUOTA_REDIS_REST_TOKEN].some(key=>Boolean(key&&text.includes(key)))||/wss:\/\/api\.elevenlabs\.io|conversation_signature|xi-api-key/i.test(text);
}
function validSessionToken(value:unknown,env:Environment):value is string{
 if(typeof value!=='string'||value.length>32768||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)||containsProviderSecret(value,env))return false;
 try{return !containsProviderSecret(JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString('utf8')),env);}catch{return false;}
}
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'}});
async function bodyOf(request:Request,limit=2048):Promise<Record<string,unknown>|null>{
 if(!request.headers.get('content-type')?.startsWith('application/json')||Number(request.headers.get('content-length')||0)>limit)return null;
 try{const raw=await request.text();if(raw.length>limit)return null;const value=JSON.parse(raw);return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}
}
function sameOrigin(request:Request):boolean{return request.headers.get('origin')===new URL(request.url).origin&&request.headers.get('sec-fetch-site')!=='cross-site';}
function providers(env:Environment):boolean{
 return Boolean(env.ANAM_API_KEY&&env.ELEVENLABS_API_KEY&&env.ELEVENLABS_AGENT_ID===JESSICA_AGENT_ID&&/^agtvrsn_[a-zA-Z0-9]+$/.test(env.ELEVENLABS_AGENT_VERSION_ID||'')
  &&env.ANAM_AVATAR_ID===ANAM_DEMO_AVATAR_ID);
}
async function stop(id:string,env:Environment,fetcher:typeof fetch):Promise<boolean>{
 try{const response=await fetcher('https://api.anam.ai/v1/sessions/'+id+'/stop',{method:'POST',headers:{Authorization:'Bearer '+env.ANAM_API_KEY},redirect:'error',signal:AbortSignal.timeout(10000)});return response.status===200;}catch{return false;}
}

export function createAnamHandler(env:Environment,{fetcher=fetch,quota,now=Date.now,nonce=()=>randomBytes(32).toString('hex')}:Dependencies={}){
 return async(request:Request):Promise<Response>=>{
  if(!isAnamDemo(env))return json({error:'preview_only'},404);
  if(request.method==='GET')return json({provider:'anam',configured:providers(env)&&Boolean(env.ANAM_QUOTA_REDIS_REST_URL&&env.ANAM_QUOTA_REDIS_REST_TOKEN),syntheticOnly:true,voiceName:'Jessica',model:'cara-4.1-express',dailyLimit:20,maxSeconds:ANAM_DEMO_MAX_SECONDS});
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!sameOrigin(request))return json({error:'same_origin_required'},403);
  const body=await bodyOf(request);if(!body)return json({error:'invalid_request'},400);
  const end=body.action==='end';
  if(end?(typeof body.leaseToken!=='string'||!/^[a-f0-9]{64}$/.test(body.leaseToken)||Object.keys(body).some(key=>!['action','leaseToken'].includes(key))):(body.action!=='start'||body.testConsent!==true||!['voice','text'].includes(String(body.mode))||Object.keys(body).some(key=>!['action','mode','testConsent'].includes(key))))return json({error:'consent_required'},400);
  let ledger:Quota;
  try{ledger=quota||createAnamQuota(env,fetcher);}catch{return json({error:'quota_store_required'},503);}
  if(end){
   try{
    const owner=hash(String(body.leaseToken)),lease=await ledger.lookup(owner);
    if(!lease)return json({ended:true});
    if(lease.sessionId){if(!UUID.test(lease.sessionId)||!await stop(lease.sessionId,env,fetcher))return json({error:'session_stop_pending'},502);await ledger.release(owner,true);return json({ended:true});}
    const released=await ledger.release(owner,false);
    return json({ended:true,leaseHeldUntilExpiry:!released},released?200:202);
   }catch{return json({error:'session_stop_pending'},503);}
  }
  if(!providers(env))return json({error:'anam_not_configured'},503);
  const leaseToken=nonce(),owner=hash(leaseToken);
  try{
   const reservation=await ledger.reserve(owner,now());
   if(reservation!=='ok')return json({error:reservation},429);
   // The external legacy endpoint is disabled for Anam deployments. This
   // internal call still applies all of the existing Jessica policy checks.
   const verified=await createAssistantHandler({...env,FIRST_HAVEN_ANAM_PREVIEW:'false'},fetcher)(new Request(request.url,{method:'POST',headers:{Origin:new URL(request.url).origin,'Content-Type':'application/json'},body:JSON.stringify({action:'start',mode:body.mode,testConsent:true})}));
   if(!verified.ok){await ledger.release(owner,false);return json({error:'jessica_setup_required'},412);}
   const signed=await verified.json();
   const avatarResponse=await fetcher('https://api.anam.ai/v1/avatars/'+env.ANAM_AVATAR_ID,{headers:{Authorization:'Bearer '+env.ANAM_API_KEY},redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!avatarResponse.ok){await ledger.release(owner,false);return json({error:'anam_setup_required'},412);}
   const avatar=await avatarResponse.json();
   if(!Array.isArray(avatar.availableVersions)||!avatar.availableVersions.includes('cara-4.1-express')){await ledger.release(owner,false);return json({error:'avatar_model_required'},412);}
   const response=await fetcher('https://api.anam.ai/v1/auth/session-token',{
    method:'POST',headers:{Authorization:'Bearer '+env.ANAM_API_KEY,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),
    body:JSON.stringify({maxSessions:1,expiresInSeconds:120,clientLabel:'first-haven3-fictional-preview',
     personaConfig:{name:'Jessica — TEST',avatarId:env.ANAM_AVATAR_ID,avatarModel:'cara-4.1-express',maxSessionLengthSeconds:ANAM_DEMO_MAX_SECONDS,zeroDataRetention:env.VERCEL_ENV!=='preview'||env.ANAM_TEST_REPORT_RETENTION!=='approved',directorNotes:{presetStyle:'warm',expressivity:0.5}},
     environment:{elevenLabsAgentSettings:{agentId:env.ELEVENLABS_AGENT_ID,signedUrl:signed.signedUrl}},
     sessionOptions:{dataRetention:{recording:false,transcripts:false},videoWidth:768,videoHeight:1152,videoQuality:'auto'},
    }),
   });
   if(!response.ok){await ledger.release(owner,false);return json({error:response.status===403?'privacy_setup_required':'anam_session_not_available'},503);}
   const data=await response.json();
   if(!validSessionToken(data.sessionToken,env))throw Error('Invalid provider token');
   if(!await ledger.bindToken(owner,hash(data.sessionToken)))throw Error('Lease expired');
   return json({sessionToken:data.sessionToken,leaseToken,syntheticOnly:true,maxSeconds:ANAM_DEMO_MAX_SECONDS});
  }catch{try{await ledger.release(owner,false);}catch{/* Store remains fail-closed. */}return json({error:'session_not_available'},503);}
 };
}

// Only this one fixed upstream endpoint is proxied. No arbitrary target URL,
// persona, environment, retention or conversation overrides are accepted.
export function createAnamEngineHandler(env:Environment,{fetcher=fetch,quota}:Dependencies={}){
 return async(request:Request):Promise<Response>=>{
  if(!isAnamDemo(env))return json({error:'preview_only'},404);
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!sameOrigin(request))return json({error:'same_origin_required'},403);
  const body=await bodyOf(request,4096);if(!body||Object.keys(body).some(key=>!['clientMetadata','sessionOptions'].includes(key))||(body.sessionOptions!==undefined&&(!body.sessionOptions||typeof body.sessionOptions!=='object'||Array.isArray(body.sessionOptions)||Object.keys(body.sessionOptions).length)))return json({error:'invalid_request'},400);
  const bearer=request.headers.get('authorization')||'';
  if(!bearer.startsWith('Bearer ')||bearer.length>32775)return json({error:'invalid_session'},403);
  let ledger:Quota;try{ledger=quota||createAnamQuota(env,fetcher);}catch{return json({error:'quota_store_required'},503);}
  try{
   const token=bearer.slice(7),owner=await ledger.claimToken(hash(token));
   if(!owner)return json({error:'invalid_session'},403);
   const response=await fetcher('https://api.anam.ai/v1/engine/session',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(45000)});
   if(!response.ok)return json({error:response.status===429?'already_active':'session_not_available'},response.status===429?429:503);
   const data=await response.json();
   if(typeof data.sessionId!=='string'||!UUID.test(data.sessionId))return json({error:'session_not_available'},503);
   if(!await ledger.bindSession(owner,data.sessionId)){await stop(data.sessionId,env,fetcher);return json({error:'invalid_session'},403);}
   const client=Object.fromEntries(['sessionId','clientConfig','engineHost','engineProtocol','signallingEndpoint','region'].filter(key=>key in data).map(key=>[key,data[key]]));
   if(containsProviderSecret(client,env)){if(await stop(data.sessionId,env,fetcher))await ledger.release(owner,true);return json({error:'session_not_available'},503);}
   return json(client);
  }catch{return json({error:'session_not_available'},503);}
 };
}
