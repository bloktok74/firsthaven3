import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createAnamQuota,ANAM_QUOTA_LEASE_SECONDS} from '../server/anam-quota.ts';

const env={VERCEL_ENV:'preview',ANAM_QUOTA_REDIS_REST_URL:'https://fixture-redis.upstash.io',ANAM_QUOTA_REDIS_REST_TOKEN:'fixture-private-token'};
const H=value=>createHash('sha256').update(String(value)).digest('hex');
const A=H('owner-a'),B=H('owner-b'),T=H('token-a'),U=H('token-b');
const S='12345678-1234-4234-8234-123456789abc',S2='22345678-1234-4234-8234-123456789abc';
const START=Date.UTC(2026,10,6,12);

// Atomic REST/Redis contract fixture, not a real Redis or Lua runtime. Each EVAL
// completes without interleaving. The tests exercise transport validation,
// ownership, expiry/replay/race behavior, and failure handling. Production still
// requires verification against the configured Redis service.
class AtomicRestFixture {
  now=START;data=new Map();calls=[];
  read(key){const row=this.data.get(key);if(row&&row.expires<=this.now){this.data.delete(key);return undefined;}return row?.value;}
  put(key,value,ttl){this.data.set(key,{value,expires:this.now+ttl*1000});}
  fetch=async(url,options)=>{
    assert.equal(url,'https://fixture-redis.upstash.io/');
    assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer fixture-private-token');
    const command=JSON.parse(options.body);this.calls.push(command);
    assert.equal(command[0],'EVAL');
    const script=command[1],n=command[2],keys=command.slice(3,3+n),args=command.slice(3+n);
    assert.ok(Number.isInteger(n)&&n>0);assert.ok(args.every(x=>typeof x==='string'));
    // Yield before, never within, the simulated atomic transaction.
    await new Promise(resolve=>setImmediate(resolve));
    const operation=script.match(/^-- anam-quota:([a-z-]+):v1/)[1];
    let result;const leaseKey=keys.at(-1),lease=this.read(leaseKey);
    if(operation==='reserve'){
      assert.equal(keys[0].match(/\{[^}]+\}/)[0],keys[1].match(/\{[^}]+\}/)[0]);
      const count=this.read(keys[0])??0;
      if(!Number.isInteger(count)||count<0)return Response.json({error:'Invalid quota counter'});
      result=count>=Number(args[1])?1:lease?2:0;
      if(result===0){this.put(keys[0],count+1,Number(args[2]));this.put(leaseKey,{owner:args[0],claimed:'0'},Number(args[3]));}
    }else if(operation==='bind-token'){
      result=0;
      if(lease?.owner===args[0]){
        if(lease.token){result=lease.token===args[1]&&lease.claimed==='0'&&!lease.session?1:0;}
        else if(lease.claimed==='0'&&!lease.session){lease.token=args[1];this.put(leaseKey,lease,Number(args[2]));result=1;}
      }
    }else if(operation==='claim-token'){
      result=null;if(lease?.owner&&lease.token===args[0]&&lease.claimed==='0'){lease.claimed='1';result=lease.owner;}
    }else if(operation==='bind-session'){
      result=0;if(lease?.owner===args[0]&&lease.token&&lease.claimed==='1'){
        if(lease.session)result=lease.session===args[1]?1:0;
        else{lease.session=args[1];result=1;}
      }
    }else if(operation==='lookup'){
      result=lease?.owner===args[0]?[lease.token||'',lease.session||'',lease.claimed||'']:null;
    }else if(operation==='release'){
      result=0;if(lease?.owner===args[0]&&(!lease.token||(args[1]==='1'&&lease.session&&lease.claimed==='1'))){this.data.delete(leaseKey);result=1;}
    }else throw Error('Unexpected fixture operation');
    return Response.json({result});
  };
}
function fixture(){const store=new AtomicRestFixture();return {store,quota:createAnamQuota(env,store.fetch)};}

test('Anam quota requires an authorized environment and an explicit HTTPS REST endpoint',()=>{
  let calls=0;const fetcher=async()=>{calls++;throw Error('must not connect')};
  for(const value of [{},{...env,VERCEL_ENV:'production'},{...env,ANAM_QUOTA_REDIS_REST_TOKEN:''},{...env,ANAM_QUOTA_REDIS_REST_TOKEN:'private\nkey'},...['http://fixture.example','https://name:private@fixture.example','https://fixture.example/?private=1','https://fixture.example/#private','not a URL'].map(url=>({...env,ANAM_QUOTA_REDIS_REST_URL:url}))])assert.throws(()=>createAnamQuota(value,fetcher),/^Error: Anam test quota storage is not configured\.$/);
  assert.doesNotThrow(()=>createAnamQuota({...env,ANAM_QUOTA_REDIS_REST_URL:'https://explicit-redis.example/redis-rest'},fetcher));
  assert.equal(calls,0);
});


test('Anam quota single global lease blocks duplicate and competing reservations without counting them',async()=>{
  const {store,quota}=fixture();assert.equal(await quota.reserve(A,store.now),'ok');
  assert.equal(await quota.reserve(A,store.now),'already_active');assert.equal(await quota.reserve(B,store.now),'already_active');
  assert.deepEqual(await quota.lookup(A),{claimed:false});assert.equal(await quota.lookup(B),null);
  assert.equal(await quota.release(B),false);assert.equal(await quota.release(A),true);
  assert.equal(await quota.reserve(B,store.now),'ok');
  assert.equal(store.read('{firsthaven3:anam:preview:v1}:daily:2026-11-06'),2);
});

test('Anam quota counts20 UTC issuances, never refunds failed starts, and expires counters after48hours',async()=>{
  const {store,quota}=fixture();
  for(let i=0;i<20;i++){const owner=H(i);assert.equal(await quota.reserve(owner,store.now),'ok');assert.equal(await quota.release(owner),true);}
  assert.equal(await quota.reserve(A,store.now),'daily_limit');
  const day='{firsthaven3:anam:preview:v1}:daily:2026-11-06';assert.equal(store.read(day),20);
  store.now+=48*3600000-1;assert.equal(store.read(day),20);
  store.now++;assert.equal(store.read(day),undefined);
});

test('Anam quota UTC day rolls independently of a lease and host timezone',async()=>{
  const {store,quota}=fixture();store.now=Date.UTC(2026,10,6,23,59,59,999);
  assert.equal(await quota.reserve(A,store.now),'ok');
  store.now++;assert.equal(await quota.reserve(B,store.now),'already_active');
  assert.equal(store.read('{firsthaven3:anam:preview:v1}:daily:2026-11-07'),undefined);
  assert.equal(await quota.release(A),true);assert.equal(await quota.reserve(B,store.now),'ok');
  assert.equal(store.read('{firsthaven3:anam:preview:v1}:daily:2026-11-06'),1);
  assert.equal(store.read('{firsthaven3:anam:preview:v1}:daily:2026-11-07'),1);
  const source=`import {createAnamQuota} from ${JSON.stringify(new URL('../server/anam-quota.ts',import.meta.url).href)};const keys=[];const quota=createAnamQuota(${JSON.stringify(env)},async(_url,o)=>{keys.push(JSON.parse(o.body)[3]);return Response.json({result:0})});await quota.reserve('${A}',${Date.UTC(2026,10,6,23,59,59,999)});await quota.reserve('${B}',${Date.UTC(2026,10,7)});console.log(JSON.stringify(keys));`;
  const outputs=['America/Los_Angeles','Asia/Tokyo','Pacific/Honolulu'].map(TZ=>execFileSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,TZ},encoding:'utf8'}));
  assert.equal(new Set(outputs).size,1);assert.deepEqual(JSON.parse(outputs[0]),['{firsthaven3:anam:preview:v1}:daily:2026-11-06','{firsthaven3:anam:preview:v1}:daily:2026-11-07']);
});

test('Anam bound unused token holds330seconds and repeated binds cannot extend its replay window',async()=>{
  const {store,quota}=fixture();assert.equal(ANAM_QUOTA_LEASE_SECONDS,330);
  await quota.reserve(A,store.now);store.now+=5000;assert.equal(await quota.bindToken(A,T),true);
  assert.equal(await quota.bindToken(A,U),false);assert.equal(await quota.release(A),false);assert.equal(await quota.release(A,true),false);
  assert.equal(await quota.bindSession(A,S),false);
  store.now+=329000;assert.equal(await quota.bindToken(A,T),true);assert.equal(await quota.reserve(B,store.now),'already_active');
  store.now+=1000;assert.equal(await quota.lookup(A),null);assert.equal(await quota.claimToken(T),null);assert.equal(await quota.reserve(B,store.now),'ok');
});

test('Anam token claim is one-use; verified session stop is required for early release',async()=>{
  const {store,quota}=fixture();await quota.reserve(A,store.now);await quota.bindToken(A,T);
  assert.equal(await quota.claimToken(U),null);assert.equal(await quota.claimToken(T),A);assert.equal(await quota.claimToken(T),null);
  assert.equal(await quota.bindToken(A,T),false);assert.equal(await quota.bindSession(B,S),false);
  assert.equal(await quota.bindSession(A,S),true);assert.equal(await quota.bindSession(A,S.toUpperCase()),true);assert.equal(await quota.bindSession(A,S2),false);
  assert.deepEqual(await quota.lookup(A),{tokenHash:T,sessionId:S,claimed:true});
  assert.equal(await quota.release(A),false);assert.equal(await quota.release(A,'true'),false);assert.equal(await quota.release(B,true),false);
  assert.equal(await quota.release(A,true),true);assert.equal(await quota.release(A,true),false);
  assert.equal(store.read('{firsthaven3:anam:preview:v1}:daily:2026-11-06'),1);
});

test('Anam stale owner and token cannot alter or release a replacement lease',async()=>{
  const {store,quota}=fixture();await quota.reserve(A,store.now);await quota.bindToken(A,T);await quota.claimToken(T);await quota.bindSession(A,S);
  store.now+=330000;assert.equal(await quota.reserve(B,store.now),'ok');await quota.bindToken(B,U);
  assert.equal(await quota.bindToken(A,T),false);assert.equal(await quota.bindSession(A,S),false);assert.equal(await quota.release(A,true),false);assert.equal(await quota.claimToken(T),null);
  assert.deepEqual(await quota.lookup(B),{tokenHash:U,claimed:false});
});

test('Anam atomic contract fixtures allow one racing reserve/claim/release winner',async()=>{
  const {store,quota}=fixture();
  const reservations=await Promise.all(Array.from({length:32},(_,i)=>quota.reserve(H(i),store.now)));
  assert.equal(reservations.filter(x=>x==='ok').length,1);assert.equal(reservations.filter(x=>x==='already_active').length,31);
  const owner=H(reservations.indexOf('ok'));await quota.bindToken(owner,T);
  const claims=await Promise.all(Array.from({length:32},()=>quota.claimToken(T)));
  assert.equal(claims.filter(x=>x===owner).length,1);assert.equal(claims.filter(x=>x===null).length,31);
  await quota.bindSession(owner,S);
  const releases=await Promise.all(Array.from({length:32},()=>quota.release(owner,true)));
  assert.equal(releases.filter(Boolean).length,1);assert.equal(store.read('{firsthaven3:anam:preview:v1}:daily:2026-11-06'),1);
});

test('Anam corrupt counters cannot turn into extra quota or an issued lease',async()=>{
  for(const value of [-1,1.5,'private-corrupt-counter']){
    const {store,quota}=fixture();store.put('{firsthaven3:anam:preview:v1}:daily:2026-11-06',value,172800);
    await assert.rejects(quota.reserve(A,store.now),/Anam test quota storage is unavailable/);
    assert.equal(await quota.lookup(A),null);
  }
});

test('Anam malformed identifiers or clocks never leave the server',async()=>{
  const {store,quota}=fixture();
  for(const run of [()=>quota.reserve('real@example.com',START),()=>quota.reserve(A,NaN),()=>quota.reserve(A,-1),()=>quota.reserve(A,START+.5),()=>quota.reserve(A,Infinity),()=>quota.reserve(A,253402300800000),()=>quota.bindToken(A,'secret token'),()=>quota.claimToken('secret token'),()=>quota.bindSession(A,'customer@example.com'),()=>quota.lookup('customer@example.com'),()=>quota.release('customer@example.com')])await assert.rejects(run,/Anam quota input is invalid/);
  assert.equal(store.calls.length,0);
});

test('Anam transport, malformed JSON and Redis errors fail closed without credential/provider excerpts',async()=>{
  for(const fetcher of [async()=>{throw Error('fixture-private-token private transport')},async()=>new Response('private-upstream',{status:500}),async()=>new Response('private-upstream',{status:200}),async()=>Response.json({error:'private-upstream'}),async()=>Response.json({result:0,error:'private-upstream'}),async()=>Response.json({unexpected:'private-upstream'})]){
    const quota=createAnamQuota(env,fetcher);await assert.rejects(quota.reserve(A,START),error=>{assert.equal(String(error),'Error: Anam test quota storage is unavailable.');assert.equal(error.cause,undefined);return true;});
  }
});

test('Anam malformed Redis result types cannot masquerade as permission or release',async()=>{
  for(const [method,args,result] of [['reserve',[A,START],'0'],['reserve',[A,START],3],['bindToken',[A,T],true],['bindSession',[A,S],'1'],['release',[A,true],'1'],['claimToken',[T],'real@example.com'],['lookup',[A],[]],['lookup',[A],[T,'','yes']],['lookup',[A],['',S,'1']],['lookup',[A],[T,S,'0']]]){
    const quota=createAnamQuota(env,async()=>Response.json({result}));await assert.rejects(quota[method](...args),/Anam test quota storage is unavailable/);
  }
});
