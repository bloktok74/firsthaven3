"""Anam UI/lifecycle contract tests in Chromium. Provider SDK/API are fixtures.

Uses a fake microphone and local video stream, never a live avatar conversation.
Real Anam speech, interruption and lip synchronization need separate live QA.
"""
from pathlib import Path
import json, os, subprocess, time, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
BASE='http://127.0.0.1:4185'
ENV={**os.environ,'VERCEL_ENV':'preview','FIRST_HAVEN_ANAM_PREVIEW':'true'}
TESTER=ENV.get('FIRST_HAVEN_ANAM_TESTER_DEMO')=='true'
TESTER_CODE='Z'*43
SDK='''
const names=['CONNECTION_ESTABLISHED','SESSION_READY','DATA_CHANNEL_OPEN','VIDEO_PLAY_STARTED','MESSAGE_STREAM_EVENT_RECEIVED','USER_SPEECH_STARTED','USER_SPEECH_ENDED','TALK_STREAM_INTERRUPTED','MIC_PERMISSION_DENIED','MESSAGE_DELIVERY_FAILED','CONNECTION_CLOSED','INPUT_AUDIO_STREAM_STARTED','AUDIO_STREAM_STARTED','VIDEO_STREAM_STARTED'];
export const AnamEvent=Object.fromEntries(names.map(n=>[n,n]));
export function createClient(token,options){
 window.qaStarts=(window.qaStarts||0)+1;window.qaOptions=options;
 const callbacks=new Map(),tools=new Map();let media,frames;
 window.qaEmit=(name,...args)=>callbacks.get(name)?.(...args);
 window.qaTools=tools;
 return {
 addListener(name,fn){callbacks.set(name,fn)},removeListener(name,fn){if(callbacks.get(name)===fn)callbacks.delete(name)},
 registerToolCallHandler(name,handler){tools.set(name,handler);return()=>tools.delete(name)},
 async streamToVideoElement(id,input){
  window.qaInput=input;window.qaClientListeners=callbacks;
  if(window.qaPendingSDK)await new Promise(resolve=>window.qaResolveSDK=resolve);
  const video=document.getElementById(id),canvas=document.createElement('canvas');canvas.width=768;canvas.height=1152;
  const image=new Image();image.src=video.poster;await image.decode();canvas.getContext('2d').drawImage(image,0,0,768,1152);
  media=canvas.captureStream(10);frames=setInterval(()=>canvas.getContext('2d').drawImage(image,0,0,768,1152),80);video.srcObject=media;await video.play();
  qaEmit('VIDEO_STREAM_STARTED',media);qaEmit('CONNECTION_ESTABLISHED');qaEmit('SESSION_READY','qa-session');qaEmit('DATA_CHANNEL_OPEN');
  video.requestVideoFrameCallback(()=>qaEmit('VIDEO_PLAY_STARTED'));
 },
 async stopStreaming(){window.qaStops=(window.qaStops||0)+1;clearInterval(frames);media?.getTracks().forEach(t=>t.stop());window.qaInput?.getTracks().forEach(t=>t.stop())},
 muteInputAudio(){window.qaMuted=true},unmuteInputAudio(){window.qaMuted=false},
 interruptPersona(){window.qaInterrupts=(window.qaInterrupts||0)+1},
 sendUserMessage(message){window.qaSent=message},addContext(message){window.qaContext=message}
 };
}
'''

subprocess.run(['node','scripts/build.mjs'],cwd=ROOT,env=ENV,check=True,stdout=subprocess.DEVNULL)
chunks=[p.name for p in (ROOT/'dist/assistant').glob('chunk-*.js') if 'VIDEO_PLAY_STARTED' in p.read_text() and 'createClient' in p.read_text()]
assert len(chunks)==1, chunks
server=subprocess.Popen(['node','scripts/serve.mjs'],cwd=ROOT,env={**ENV,'PORT':'4185'},stdout=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
report=[]
def unlock(page, check_wrong=False):
 if not TESTER:return
 gate=page.locator('.fh-demo-consent')
 expect(gate).to_be_visible()
 before=page.evaluate('({mic:qaMicCalls,starts:window.qaStarts||0})')
 assert 'fictional details' in gate.inner_text()
 if check_wrong:
  page.get_by_label('Tester access code').fill('wrong')
  page.get_by_role('button',name='Start test call').click()
  expect(gate.get_by_role('alert')).to_contain_text('code did not match')
  assert page.evaluate('({mic:qaMicCalls,starts:window.qaStarts||0})')==before
 page.get_by_label('Tester access code').fill(TESTER_CODE)
 page.get_by_role('button',name='Start test call').click()
 expect(gate).not_to_be_visible()

def circular_avatar(page):
 panel=page.locator('#fh-panel');stage=page.locator('.fh-anam-stage')
 bounds=stage.bounding_box();assert bounds
 viewport=page.viewport_size
 assert abs(bounds['width']-bounds['height'])<.8,bounds
 assert bounds['width']>=235,bounds
 assert abs(bounds['x']+bounds['width']/2-viewport['width']/2)<1,bounds
 assert abs(bounds['y']+bounds['height']/2-viewport['height']/2)<1,bounds
 assert panel.evaluate('(el)=>getComputedStyle(el).backgroundColor')=='rgba(0, 0, 0, 0)'
 assert stage.evaluate('(el)=>getComputedStyle(el).borderRadius')=='50%'
 assert stage.evaluate('(el)=>getComputedStyle(el).overflow')=='hidden'
 assert stage.evaluate('(el)=>getComputedStyle(el).borderTopWidth')=='1px'
 for button in ['.fh-close','[data-action="mute"]','.fh-end-call']:
  box=panel.locator(button).bounding_box();assert box
  assert box['width']>=44 and box['height']>=44,(button,box)
  assert box['x']>=-1 and box['y']>=-1 and box['x']+box['width']<=viewport['width']+1 and box['y']+box['height']<=viewport['height']+1,(button,box)
  if button=='.fh-close':assert box['y']+box['height']<=bounds['y']
  else:assert box['y']>=bounds['y']+bounds['height']
 return bounds

def inside_portrait(page,selector):
 box=page.locator(selector).bounding_box();portrait=page.locator('#fh-anam-video').bounding_box()
 assert box and portrait
 assert box['x']>=portrait['x']-.8 and box['y']>=portrait['y']-.8 and box['x']+box['width']<=portrait['x']+portrait['width']+.8 and box['y']+box['height']<=portrait['y']+portrait['height']+.8,(selector,box,portrait)

try:
 for _ in range(60):
  try:urllib.request.urlopen(BASE,timeout=1).close();break
  except OSError:time.sleep(.1)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  for width,height in [(1440,1000),(1024,900),(768,1000),(390,844),(320,740),(844,390)]:
   touch=width<=520 or height<=390
   context=browser.new_context(viewport={'width':width,'height':height},has_touch=touch,permissions=['microphone'],reduced_motion='reduce')
   context.add_init_script('''window.qaMicCalls=0;window.qaAudioContexts=[];window.qaCarrierStarts=0;
    const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(...args)=>{qaMicCalls++;return gum(...args)};
    const AC=AudioContext;window.AudioContext=class extends AC{constructor(...args){super(...args);qaAudioContexts.push(this)}createOscillator(){const n=super.createOscillator(),start=n.start.bind(n);n.start=(...args)=>{qaCarrierStarts++;return start(...args)};return n}};''')
   page=context.new_page();calls=[];errors=[];legacy=[];fail=[False];failed_starts=[]
   page.on('pageerror',lambda error:errors.append(str(error)))
   page.route('**/assistant/'+chunks[0],lambda route:route.fulfill(content_type='text/javascript',body=SDK))
   def api(route):
    body=route.request.post_data_json;calls.append(body)
    if TESTER and body['action']=='verify_tester':
     approved=body['accessCode']==TESTER_CODE
     route.fulfill(status=200 if approved else 403,content_type='application/json',body=json.dumps({'authorized':True} if approved else {'error':'tester_access_required'}));return
    if TESTER and body['action']=='start':assert body['accessCode']==TESTER_CODE
    if body['action']=='start' and fail[0]:
     failed_starts.append(body);route.fulfill(status=503,content_type='application/json',body='{"error":"session_not_available"}');return
    route.fulfill(content_type='application/json',body=json.dumps({'sessionToken':'fixture-token','leaseToken':'a'*64} if body['action']=='start' else {'ended':True}))
   page.route('**/api/anam-session',api)
   page.route('**/api/assistant',lambda route:(legacy.append(route.request.url),route.abort()))
   page.route('https://fonts.googleapis.com/**',lambda route:route.abort())
   page.goto(BASE+'/#top')
   page.wait_for_function('window.scrollY === 0')
   assert page.locator('header').bounding_box()['y']==0
   page.evaluate('window.scrollTo({top:500,behavior:"instant"})')
   assert page.evaluate('window.scrollY')>0
   page.reload()
   page.wait_for_function('window.scrollY === 0')
   page.goto(BASE+'/#process')
   page.wait_for_function('window.scrollY > 500')
   page.goto(BASE+'/#top')
   page.wait_for_function('window.scrollY === 0')
   page.goto(BASE);page.wait_for_timeout(200)
   disclosure=page.locator('#fh-voice-disclosure').text_content()
   if ENV.get('ANAM_TEST_REPORT_RETENTION')=='approved':
    assert 'Anam may retain other session report data' in disclosure
    assert 'recording and stored transcripts are disabled' in disclosure
   else:
    assert 'zero session data retention' in disclosure
   assert not calls and not page.evaluate('window.qaStarts||0')
   ctas=[page.locator('header a[data-open-escrow]'),page.locator('.hero a[data-open-escrow]')]
   panel=page.locator('#fh-panel');panel.evaluate('(dialog) => { window.qaEscrowDialog = dialog; }')
   for index,cta in enumerate(ctas):
    expect(cta).to_be_visible()
    assert cta.get_attribute('aria-controls')=='fh-panel'
    starts_before=sum(call['action']=='start' for call in calls)
    sdk_starts_before=page.evaluate('window.qaStarts||0')
    if touch:
     bounds=cta.bounding_box();assert bounds['height']>=44
     cta.tap();page.touchscreen.tap(bounds['x']+bounds['width']/2,bounds['y']+bounds['height']/2)
    else:
     cta.dblclick()
    expect(panel).to_be_visible()
    unlock(page,index==0)
    assert panel.evaluate('(dialog) => dialog === window.qaEscrowDialog')
    expect(page.locator('.fh-connection')).to_contain_text('Connected to Jessica')
    expect(page.locator('#fh-anam-video')).to_be_visible()
    assert page.locator('#fh-panel .fh-character-portrait').count()==0
    bounds=circular_avatar(page)
    assert page.url==BASE+'/' or page.url.startswith(BASE+'/#')
    assert page.evaluate('qaOptions.api.retry.maxAttempts')==1
    assert page.evaluate('qaInput.getAudioTracks().length')==1
    page.get_by_role('button',name='Mute microphone',exact=True).click();assert page.evaluate('qaMuted')
    page.get_by_role('button',name='Unmute microphone',exact=True).click();assert not page.evaluate('qaMuted')
    expect(page.locator('.fh-input-form')).not_to_be_visible()
    assert not page.locator('.fh-internal').is_visible()
    if index==0:
     page.screenshot(path=str(ROOT/f'qa/anam-circular-{width}x{height}.png'))
    page.get_by_role('button',name='End conversation',exact=True).click()
    expect(page.locator('#fh-panel')).not_to_be_visible()
    page.wait_for_function('qaInput.getTracks().every(t=>t.readyState==="ended")')
    assert page.evaluate('qaTools.size')==0
    assert sum(call['action']=='start' for call in calls)==starts_before+1
    assert page.evaluate('qaStarts')==sdk_starts_before+1
   page.locator('.hero [data-open-escrow]').click();unlock(page);expect(page.locator('.fh-connection')).to_contain_text('Connected')
   # Exercise the same confirmation and client tool path as a spoken intake.
   page.evaluate("""async () => {
    const update = qaTools.get('update_test_intake');
    const args = {field:'agentName',value:'John Smith',confirmed:true};
    const pre = await update.onStart({arguments:args});
    if (!pre.includes('not confirmed')) throw new Error(pre);
    qaEmit('MESSAGE_STREAM_EVENT_RECEIVED',{id:'confirm-name',role:'user',content:'Yes',endOfSpeech:true});
    const result = await update.onStart({arguments:args});
    if (!result.includes('saved to the in-memory draft')) throw new Error(result);
   }""")
   expect(page.locator('.fh-count')).to_have_text('1/6')
   microphones=page.evaluate('qaMicCalls')
   page.get_by_role('button',name='Privacy and accessibility options').click()
   inside_portrait(page,'.fh-access-panel')
   page.get_by_role('checkbox',name='Show live captions').check()
   page.get_by_role('button',name='Done',exact=True).click()
   inside_portrait(page,'.fh-captions')
   page.get_by_role('button',name='Privacy and accessibility options').click()
   page.get_by_role('button',name='Keyboard conversation',exact=True).click()
   expect(page.locator('.fh-input-form')).to_be_visible();assert calls[-1]['mode']=='text'
   inside_portrait(page,'.fh-input-form');inside_portrait(page,'.fh-captions')
   assert not page.evaluate('qaOptions.disableInputAudio')
   assert page.evaluate('qaMicCalls')==microphones
   assert page.evaluate('qaCarrierStarts===1 && qaAudioContexts.length===1 && qaAudioContexts[0].state==="running"')
   page.locator('#fh-answer').fill('Hello');page.get_by_role('button',name='Send message',exact=True).click()
   assert page.evaluate('qaSent')=='Hello' and page.evaluate('qaInterrupts')>=1
   page.get_by_role('button',name='Close assistant and clear test data').click();expect(page.locator('#fh-panel')).not_to_be_visible()
   page.wait_for_function('qaAudioContexts.every(ac=>ac.state==="closed") && qaInput.getTracks().every(t=>t.readyState==="ended")')
   fail[0]=True;page.locator('.hero [data-open-escrow]').click();unlock(page)
   expect(page.locator('.fh-feedback:not(.fh-demo-consent) .fh-notice')).to_contain_text('could not connect')
   expect(page.get_by_role('button',name='Try again',exact=True)).to_be_visible()
   error_bounds=circular_avatar(page);inside_portrait(page,'.fh-feedback:not(.fh-demo-consent)')
   assert abs(error_bounds['width']-bounds['width'])<.8 and abs(error_bounds['height']-bounds['height'])<.8
   page.screenshot(path=str(ROOT/f'qa/anam-circular-error-{width}x{height}.png'))
   page.get_by_role('button',name='Close assistant and clear test data').click();expect(page.locator('#fh-panel')).not_to_be_visible()
   assert not legacy and not errors,errors
   assert len([c for c in calls if c['action']=='start'])-len(failed_starts)==len([c for c in calls if c['action']=='end'])
   assert not page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
   report.append({'viewport':[width,height],'allOpenEscrowButtons':len(ctas),'singleStartPerRepeatedActivation':True,'centered':True,'avatarDiameter':round(bounds['width'],2),'portraitAspect':'1:1','errorGeometryUnchanged':True,'overlaysInsidePortrait':True,'voiceTextMuteEndFixture':True,'noPageLoadSession':True,'noLegacyConnection':True})
   context.close()
  browser.close()
 (ROOT/'qa/anam-browser-results.json').write_text(json.dumps({'provider':'fixtures only','liveConversationVerified':False,'cases':report},indent=2))
 print(json.dumps({'anamUIFixtureTests':'PASS','liveAnamSessions':0,'cases':report}),flush=True)
finally:
 server.terminate();server.wait(timeout=5)
 subprocess.run(['node','scripts/build.mjs'],cwd=ROOT,env={**os.environ,'VERCEL_ENV':'preview','FIRST_HAVEN_ANAM_PREVIEW':'','FIRST_HAVEN_ANAM_TESTER_DEMO':''},check=True,stdout=subprocess.DEVNULL)
