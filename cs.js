/* CS 관리 탭 — 고객 문의를 붙여 넣으면 홍제점 점주 말투로 카톡 답장 초안을 만든다.
   서버는 Supabase Edge Function 'cs' (api와 분리). 답장은 사람이 확인하고 직접 카톡에 붙여 넣는다.
   점주 전용 (서버도 점주 PIN일 때만 응답). 기록은 두 점주가 함께 본다. */
(function(){
 'use strict';
 let ctx;
 const st={loaded:false,loading:false,err:'',items:[],tone:'',info:'',defaultTone:'',ready:true,me:'',
   q:'',extra:'',busy:false,result:null,again:'',open:null,showMenu:false,filter:'',ck:{},learning:false};
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const TA='text'+'area';

 // 카톡 채널 '채팅방 메뉴 > 리스트 메뉴'(최대 10개)에 넣을 홍제점용 자동응답 문구
 const MENU=[
  ['👋 카공족 홍제점은 이런 곳이에요',`안녕하세요, 카공족 홍제점입니다 😊

카공족은 카페처럼 편안한 '라운지형 워크스페이스'예요.
칸막이 없는 열린 공간에서 노트북 작업, 공부, 가벼운 대화까지 자유롭게 하실 수 있어요.

✔ 24시간 무인 운영
✔ 자유석 (빈자리 어디든 앉으시면 돼요)
✔ 커피·차 셀프 이용

궁금한 점은 이 채팅방으로 편하게 남겨 주세요 :)`],
  ['💳 결제·이용 방법',`카공족 이용 방법을 알려드릴게요 😊

1. 매장 입구 키오스크 상단 '카공족' 메뉴를 눌러 주세요
2. 24시간 이용권 '바로결제' → 결제하기
3. 연락처를 입력해 주세요 (쿠폰·선불권 조회에 꼭 필요해요!)

⏰ 24시간 이용권은 결제한 시간부터 다음날 같은 시간까지 이용하실 수 있어요.
결제 후에는 빈자리 어디든 편하게 앉으시면 돼요 🙏`],
  ['🎫 선불권 사용(차감) 방법',`선불권 사용 방법이에요 😊

키오스크 '선불권' 탭은 선불권을 '구매'하는 곳이라 여기서는 차감이 안 돼요!

✔ 사용할 때는
1. 상단 '카공족' 메뉴 → 24시간 이용권 '바로결제'
2. 결제하기 → 연락처 입력
3. '횟수를 차감할까요?'에서 '1회 차감'

남은 횟수는 영수증 하단과 토스 알림에서 확인하실 수 있어요.
선불권은 구매하신 지점에서만, 본인만 사용 가능해요 (공유·양도 불가) 🙏`],
  ['⏰ 외출하면 이용권은 어떻게 되나요?',`외출 규칙 안내드려요 🙏

식사 등 2시간 이내의 간단한 외출은 괜찮아요!

다만 2시간 이상 자리를 비우시거나 완전히 퇴실하시면
이용 중인 24시간 이용권은 소멸돼요.
다시 이용하실 때는 입장 시 재결제 부탁드려요 😊`],
  ['📶 와이파이가 안 돼요',`이용에 불편을 드려 죄송합니다 😭

와이파이 정보는 영수증 하단이나 주변 벽면에서 확인하실 수 있어요.

연결이 안 되면, 괜찮으시다면
공유기 뒤쪽 검은색 전원 케이블을 뽑았다가 다시 꽂아 주실 수 있을까요? 🙏
3~5분 뒤 다시 연결해 보시면 대부분 해결돼요.

그래도 안 되면 이 채팅방으로 공유기 사진을 보내 주세요. 빠르게 확인할게요!`],
  ['🌡️ 매장이 추워요 / 더워요',`매장 온도는 고객님이 직접 조절하실 수 있어요 😊

에어컨·난방 리모컨이 준비되어 있으니
편하게 온도와 바람 세기를 맞춰 주세요.
사용 후에는 리모컨을 제자리에 놓아 주시면 감사하겠습니다 🙏`],
  ['🔊 소음·음악 안내',`카공족은 카페 같은 라운지형 공간이에요 😊

대화나 노트북 작업은 자유롭게 하셔도 되고,
큰 소리나 긴 통화는 다른 분들을 위해 잠시 밖에서 부탁드려요 🙏

매장 음악은 집중을 돕는 잔잔한 배경음으로 유지하고 있어요.
소리가 너무 크게 느껴지시면 채팅으로 알려 주세요. 확인 후 조정할게요!`],
  ['🍰 음식·주차·분실물',`자주 물어보시는 내용이에요 😊

🍰 음식: 냄새가 나지 않는 간단한 간식·디저트는 괜찮아요. 식사류나 냄새가 많이 나는 음식은 어려워요.
🚗 주차: 별도 주차 공간이 없어요. 인근 공영주차장을 이용해 주세요.
🎒 분실물: 확인 후 키오스크 하단 분실함에 보관하고 있어요. 방문하실 때 확인해 주세요.
💺 자리: 자유석이라 예약·자리 맡기는 운영하지 않아요. 빈자리에 편하게 앉으세요!`],
  ['📝 네이버 리뷰 이벤트',`네이버 영수증 리뷰 이벤트 안내드려요 💚

리뷰를 남겨 주시고 이 채팅방으로
리뷰 캡처 + 연락처 뒷번호 4자리를 보내 주세요.

확인 후 24시간 이용권 1장을 보내드릴게요!
📌 사용: 키오스크 '[네이버리뷰 이벤트용] 24시간 이용권' 선택 → 연락처 입력
📌 받은 날부터 7일 이내 사용해 주세요 😊`],
  ['💬 그 밖의 문의',`카공족 홍제점은 전화 상담 대신 카카오톡 채널로 문의를 받고 있어요 😊

궁금하신 점이나 불편하신 점을 이 채팅방에 남겨 주시면
확인하는 대로 빠르게 답변드릴게요.
불편한 상황은 사진을 함께 보내 주시면 더 빨리 도와드릴 수 있어요 🙏`]
 ];

 async function csCall(action,payload){
  let r;
  try{
   r=await fetch(ctx.url+'/functions/v1/cs',{method:'POST',headers:{'Content-Type':'application/json',apikey:ctx.key,Authorization:'Bearer '+ctx.key},
    body:JSON.stringify({action,p:Object.assign(ctx.auth(),payload||{})})});
  }catch(e){throw new Error('인터넷 연결을 확인해 주세요.');}
  let j;try{j=await r.json();}catch(e){throw new Error('요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.');}
  if(!j.ok)throw new Error(j.error||'요청을 처리하지 못했어요.');
  return j.result;
 }
 async function load(silent){
  if(st.loading)return;st.loading=true;if(!silent)st.err='';
  try{const d=await csCall('csList');Object.assign(st,{items:d.items,tone:d.tone,info:d.info,defaultTone:d.defaultTone,ready:d.ready,me:d.me,loaded:true,err:''});}
  catch(e){st.err=e.message;}
  finally{st.loading=false;rerender();}
 }
 function rerender(){
  if(ctx.tab()!=='cs')return;
  const ae=document.activeElement;
  if(ae&&ae.closest&&ae.closest('#main')&&/^(INPUT|TEXTAREA)$/.test(ae.tagName)&&ae.value)return; // 입력 중이면 그대로 둔다
  if(!document.querySelector('.scrim'))ctx.render();
 }
 async function copy(text,btn){
  try{await navigator.clipboard.writeText(text);}
  catch(e){const t=document.createElement(TA);t.value=text;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();try{document.execCommand('copy');}catch(_){}t.remove();}
  if(btn){const l=btn.dataset.label||btn.textContent;btn.dataset.label=l;btn.textContent='✓ 복사됐어요';setTimeout(()=>{btn.textContent=l;},1600);}
  ctx.toast('복사했어요. 카톡에 붙여 넣어 주세요');
 }
 const when=iso=>{if(!iso)return'';const d=new Date(iso);const f=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});return f.format(d);};
 const short=(s,n)=>{s=String(s||'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s;};

 function resultCard(r){
  return `<div class="card cs-result" id="cs-result">
   <div class="spread"><h3 style="margin:0">답장 초안</h3><span class="faint" style="font-size:12.5px">${esc(r.name||'')} · ${when(r.at)}</span></div>
   ${r.reply?`<div class="cs-bubble" id="cs-reply">${esc(r.reply)}</div>`:''}
   ${r.memo?`<div class="cs-memo"><b>직원 메모</b> ${esc(r.memo)}</div>`:''}
   ${checksBox(r)}
   <div class="acts cs-acts">
    ${r.reply?`<button class="btn primary" data-cs="copy" data-id="${esc(r.id)}">📋 답장 복사</button>`:''}
   </div>
   <div class="cs-again">
    <div class="faint" style="font-size:12.5px;margin-bottom:6px">마음에 안 들면 고쳐 달라고 해 보세요</div>
    <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">${['더 짧게','더 정중하게','더 친근하게','이용권 1장 서비스 드린다고','사과를 더 진심으로'].map(x=>`<button class="chip" data-cs="again-chip" data-v="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <div class="row"><input id="cs-again" style="flex:1;min-width:160px" placeholder="예: 내일 오전에 방문해서 고친다고 해 줘" value="${esc(st.again)}" autocomplete="off"><button class="btn" data-cs="again" data-id="${esc(r.id)}" ${st.busy?'disabled':''}>다시 만들기</button></div>
   </div>
  </div>`;
 }
 // 점주만 아는 매장 정보가 필요할 때: 그 자리에서 답하면 홍제점 정보에 쌓이고 답장을 다시 만든다
 function checksBox(r){
  const cs=(r.checks||[]);
  if(!cs.length)return '';
  return `<div class="cs-check"><div class="cs-check-h">❓ 확인이 필요해요 <span class="faint">답을 적으면 홍제점 정보에 저장돼서 다음부터 바로 써요</span></div>
   ${cs.map((q,i)=>`<div class="field" style="margin-top:8px"><label for="cs-ck-${i}">${esc(q)}</label><input id="cs-ck-${i}" data-q="${esc(q)}" value="${esc(st.ck[q]||'')}" placeholder="예: 누적 합산 / 없음 / 5,900원" autocomplete="off"></div>`).join('')}
   <div class="acts" style="margin-top:10px;display:flex;justify-content:flex-end"><button class="btn primary small" data-cs="learn" data-id="${esc(r.id)}" ${st.learning||st.busy?'disabled':''}>${st.learning?'저장 중…':'저장하고 답장 다시 만들기'}</button></div>
  </div>`;
 }
 async function learn(id){
  const r=st.result&&st.result.id===id?st.result:null;if(!r)return;
  const items=(r.checks||[]).map(q=>({q,a:(st.ck[q]||'').trim()})).filter(x=>x.a);
  if(!items.length){ctx.toast('답을 하나 이상 적어 주세요.');return;}
  st.learning=true;ctx.render();
  try{
   const d=await csCall('csLearn',{id,items});
   st.info=d.info;
   items.forEach(x=>delete st.ck[x.q]);
   const done=new Set(items.map(x=>x.q));
   r.checks=(r.checks||[]).filter(q=>!done.has(q));
   st.items.forEach(x=>{if(x.id===id)x.checks=r.checks;});
   ctx.toast(`홍제점 정보에 ${d.added}개 저장했어요. 답장을 다시 만들게요`);
   st.learning=false;
   st.again='방금 추가된 홍제점 정보를 반영해서 다시 써 줘';
   await make({question:r.question,id});
  }catch(e){ctx.toast(e.message);st.learning=false;ctx.render();}
 }
 function histItem(r){
  const open=st.open===r.id,canDel=true;
  return `<div class="card cs-hist${open?' open':''}">
   <button class="cs-hhead" data-cs="toggle" data-id="${esc(r.id)}"><span class="cs-hq">${esc(short(r.question,70))}</span><span class="faint num" style="font-size:12px;white-space:nowrap">${esc(r.name||'')} · ${when(r.at)}</span></button>
   ${open?`<div class="cs-hbody">
     <div class="cs-label">고객 문의</div><div class="cs-q">${esc(r.question)}</div>
     ${r.extra?`<div class="faint" style="font-size:12.5px;margin-top:6px">요청: ${esc(r.extra)}</div>`:''}
     <div class="cs-label" style="margin-top:10px">답장</div>${r.reply?`<div class="cs-bubble">${esc(r.reply)}</div>`:'<div class="faint">답장 없음</div>'}
     ${r.memo?`<div class="cs-memo"><b>직원 메모</b> ${esc(r.memo)}</div>`:''}
     <div class="acts" style="justify-content:flex-start;flex-wrap:wrap;margin-top:10px">
      ${r.reply?`<button class="btn small primary" data-cs="copy" data-id="${esc(r.id)}">📋 복사</button>`:''}
      <button class="btn small ghost" data-cs="reuse" data-id="${esc(r.id)}">이 문의로 다시 쓰기</button>
      ${canDel?`<button class="btn small ghost danger" data-cs="del" data-id="${esc(r.id)}">삭제</button>`:''}
     </div></div>`:''}
  </div>`;
 }
 function view(c){
  ctx=c;
  if(!ctx.isOwner())return `<div class="card empty"><b>CS 관리는 점주 전용이에요</b>점주 PIN으로 로그인하면 고객 문의 답장 초안을 만들 수 있어요.<div style="margin-top:12px"><button class="btn primary" data-act="login">로그인</button></div></div>`;
  if(!st.loaded&&!st.loading&&!st.err)setTimeout(()=>load(),0);
  let h=`<section><div class="spread"><h2>CS 답장 도우미</h2>${ctx.isOwner()?`<button class="btn small ghost" data-cs="settings">⚙️ 말투·매장 정보</button>`:''}</div>
   <p class="faint" style="margin:2px 0 12px;font-size:13.5px">카톡으로 온 고객 문의를 붙여 넣으면, 본사 매뉴얼에 맞춰 홍제점 말투로 답장 초안을 써 드려요. 보내기 전에 꼭 한 번 읽어 봐 주세요.</p>`;
  if(st.loaded&&!st.ready)h+=`<div class="note" style="margin-bottom:12px"><b>AI 답장 기능이 아직 꺼져 있어요.</b> Supabase에 Claude API 키(ANTHROPIC_API_KEY)를 넣으면 바로 켜져요.</div>`;
  h+=`<div class="card">
    <div class="field"><label for="cs-q">고객 문의</label><${TA} id="cs-q" rows="5" placeholder="카톡 채팅방에서 고객 메시지를 복사해 붙여 넣어 주세요.&#10;여러 메시지는 한꺼번에 붙여 넣어도 돼요.">${esc(st.q)}</${TA}></div>
    <div class="field" style="margin-top:10px"><label for="cs-extra">추가로 전할 말 (선택)</label><input id="cs-extra" placeholder="예: 쿠폰 1장 드린다고 해 줘 / 내일 오전에 방문 예정" value="${esc(st.extra)}" autocomplete="off"></div>
    <div class="acts" style="margin-top:12px;justify-content:space-between;display:flex;gap:8px;flex-wrap:wrap">
     <button class="btn ghost small" data-cs="clear">지우기</button>
     <button class="btn primary" data-cs="make" ${st.busy?'disabled':''}>${st.busy?'답장 쓰는 중… (10~20초)':'✍️ 답장 만들기'}</button>
    </div>
  </div>`;
  if(st.result)h+=resultCard(st.result);
  // 기록
  const f=st.filter.trim();
  const items=st.items.filter(r=>!f||(r.question+' '+r.reply).includes(f));
  h+=`<div class="spread" style="margin-top:22px"><h2 style="margin:0">최근 기록</h2><input id="cs-filter" style="max-width:180px" class="cs-search" placeholder="🔍 기록 검색" value="${esc(st.filter)}" autocomplete="off"></div>
   <p class="faint" style="margin:2px 0 10px;font-size:12.5px">두 점주가 함께 봐요. 비슷한 문의는 예전 답장을 다시 써도 돼요.</p>`;
  if(st.err)h+=`<div class="card empty"><b>기록을 불러오지 못했어요</b>${esc(st.err)}<div style="margin-top:10px"><button class="btn small" data-cs="reload">다시 시도</button></div></div>`;
  else if(!st.loaded)h+=`<div class="card empty">불러오는 중…</div>`;
  else if(!items.length)h+=`<div class="card empty">${f?'검색 결과가 없어요.':'아직 기록이 없어요. 첫 문의를 붙여 넣어 보세요.'}</div>`;
  else h+=`<div class="cs-list">${items.map(histItem).join('')}</div>`;
  // 카톡 자동응답 문구
  h+=`<div class="card" style="margin-top:22px">
   <button class="cs-hhead" data-cs="menu"><span><b>카톡 채널 자동응답 문구</b> <span class="pill s-accent">${MENU.length}개</span></span><span class="faint">${st.showMenu?'접기 ▲':'펼치기 ▼'}</span></button>
   ${st.showMenu?`<div class="note" style="margin:10px 0">카카오톡 채널 관리자 → 비즈니스 도구 → 채팅방 메뉴 → <b>리스트 메뉴 수정하기</b> → +메뉴 추가에서 메뉴명과 응답 메시지를 붙여 넣어 주세요. 메시지 버튼은 ‘없음’, 저장은 ‘메뉴 저장하기’와 아래 노란 ‘저장하기’ 두 번이에요.</div>
    ${MENU.map(([t,b],i)=>`<div class="cs-menu"><div class="spread"><b>${i+1}. ${esc(t)}</b><span class="row" style="gap:4px"><button class="btn small ghost" data-cs="menu-title" data-i="${i}">메뉴명 복사</button><button class="btn small" data-cs="menu-copy" data-i="${i}">문구 복사</button></span></div><div class="cs-bubble small">${esc(b)}</div></div>`).join('')}`:''}
  </div>`;
  return h+'</section>';
 }
 async function make(again){
  const q=(st.q||'').trim();
  if(!again&&q.length<2){ctx.toast('고객 문의를 붙여 넣어 주세요.');return;}
  if(st.busy)return;
  st.busy=true;ctx.render();
  try{
   const payload=again?{question:again.question,id:again.id,extra:st.again.trim()}:{question:q,extra:st.extra.trim()};
   const r=await csCall('csReply',payload);
   st.result=r;st.again='';
   if(!again){st.q='';st.extra='';}
   st.items=[r,...st.items.filter(x=>x.id!==r.id)];
  }catch(e){ctx.toast(e.message);}
  finally{st.busy=false;ctx.render();setTimeout(()=>document.getElementById('cs-result')?.scrollIntoView({behavior:'smooth',block:'start'}),50);}
 }
 function settingsSheet(){
  ctx.openSheet(`<h3>말투·홍제점 정보</h3>
   <div class="field"><label for="cs-tone">말투 (AI가 따라 쓰는 기준)</label><${TA} id="cs-tone" rows="8" placeholder="${esc(st.defaultTone)}">${esc(st.tone)}</${TA}>
    <span class="faint" style="font-size:12.5px">비워 두면 기본 말투를 써요. 실제로 보냈던 답장 2~3개를 ‘예시:’로 붙여 넣으면 말투가 훨씬 비슷해져요.</span></div>
   <div class="field" style="margin-top:10px"><label for="cs-info">홍제점 정보 (본사 매뉴얼보다 우선)</label><${TA} id="cs-info" rows="10" placeholder="예:&#10;- 24시간 이용권 5,900원 / 선불권 10회 ○○원&#10;- 짐 보관: 키오스크 옆 바구니&#10;- 주차: 홍제역 공영주차장 (도보 3분)&#10;- 담당자 방문 시간: 평일 오전">${esc(st.info)}</${TA}>
    <span class="faint" style="font-size:12.5px">가격, 시설, 주변 정보처럼 홍제점에만 해당하는 내용이에요. 답장의 ‘❓ 확인이 필요해요’에 답하면 여기에 한 줄씩 자동으로 쌓여요. 틀린 줄은 여기서 고치거나 지우면 돼요.</span></div>
   <div role="alert" style="color:var(--bad);font-size:13px"></div>
   <div class="acts"><button class="btn" data-close>취소</button><button class="btn primary" id="cs-save">저장</button></div>`,sh=>{
    const go=sh.querySelector('#cs-save');
    go.addEventListener('click',async()=>{
     go.disabled=true;go.textContent='저장 중…';
     try{const tone=sh.querySelector('#cs-tone').value,info=sh.querySelector('#cs-info').value;await csCall('csSettingsSave',{tone,info});st.tone=tone.trim();st.info=info.trim();ctx.closeSheet();ctx.toast('저장했어요. 다음 답장부터 반영돼요');}
     catch(e){sh.querySelector('[role=alert]').textContent=e.message;go.disabled=false;go.textContent='저장';}
    });
   });
 }
 function bind(main){
  const qEl=main.querySelector('#cs-q'),xEl=main.querySelector('#cs-extra'),aEl=main.querySelector('#cs-again'),fEl=main.querySelector('#cs-filter');
  qEl&&qEl.addEventListener('input',()=>{st.q=qEl.value;});
  xEl&&xEl.addEventListener('input',()=>{st.extra=xEl.value;});
  xEl&&xEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();make();}});
  qEl&&qEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();make();}});
  aEl&&aEl.addEventListener('input',()=>{st.again=aEl.value;});
  main.querySelectorAll('[id^="cs-ck-"]').forEach(inp=>{inp.addEventListener('input',()=>{st.ck[inp.dataset.q]=inp.value;});inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();main.querySelector('[data-cs="learn"]')?.click();}});});
  aEl&&aEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();main.querySelector('[data-cs="again"]')?.click();}});
  fEl&&fEl.addEventListener('input',()=>{st.filter=fEl.value;const pos=fEl.selectionStart;ctx.render();const n=document.getElementById('cs-filter');if(n){n.focus();n.setSelectionRange(pos,pos);}});
  const find=id=>st.items.find(x=>x.id===id)||(st.result&&st.result.id===id?st.result:null);
  main.querySelectorAll('[data-cs]').forEach(el=>el.addEventListener('click',async()=>{
   const a=el.dataset.cs,id=el.dataset.id;
   if(a==='make')make();
   else if(a==='clear'){st.q='';st.extra='';st.result=null;ctx.render();document.getElementById('cs-q')?.focus();}
   else if(a==='copy'){const r=find(id);if(r)copy(r.reply,el);}
   else if(a==='again-chip'){st.again=st.again?st.again+', '+el.dataset.v:el.dataset.v;const r=st.result;if(r)make({question:r.question,id:r.id});}
   else if(a==='again'){const r=find(id);if(!r)return;if(!st.again.trim()){ctx.toast('어떻게 고칠지 적거나 위 버튼을 눌러 주세요.');return;}make({question:r.question,id:r.id});}
   else if(a==='toggle'){st.open=st.open===id?null:id;ctx.render();}
   else if(a==='reuse'){const r=find(id);if(!r)return;st.q=r.question;st.extra='';st.result=r;ctx.render();window.scrollTo({top:0,behavior:'smooth'});}
   else if(a==='del'){
    if(!el.dataset.armed){el.dataset.armed='1';el.textContent='한 번 더 누르면 삭제';return;}
    try{await csCall('csDelete',{id});st.items=st.items.filter(x=>x.id!==id);if(st.result&&st.result.id===id)st.result=null;ctx.toast('기록을 지웠어요');ctx.render();}catch(e){ctx.toast(e.message);}
   }
   else if(a==='learn')learn(id);
   else if(a==='settings')settingsSheet();
   else if(a==='reload'){st.err='';load();}
   else if(a==='menu'){st.showMenu=!st.showMenu;ctx.render();}
   else if(a==='menu-copy')copy(MENU[+el.dataset.i][1],el);
   else if(a==='menu-title')copy(MENU[+el.dataset.i][0],el);
  }));
 }
 // 다른 기기에서 기록이 바뀌면(실시간 신호) 목록만 다시 불러온다
 function changed(){if(ctx&&st.loaded&&ctx.isOwner())load(true);}
 function reset(){Object.assign(st,{loaded:false,items:[],result:null,q:'',extra:'',again:'',err:'',open:null});}
 window.HongjeCS={view,bind,changed,reset,MENU};
})();
