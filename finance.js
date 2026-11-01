/* 매출·비용 탭 (점주 전용). 데이터는 서버 load 응답의 finance에서 받고, 저장은 모두 서버로 보낸다.
   브라우저에는 장부를 저장하지 않는다. */
(function(){
 'use strict';
 const C=window.FinanceCore;
 const labels={sale:'매출',refund:'매출 취소·환불',expense:'운영비',expenseRefund:'비용 환급',transfer:'입출금·이체 (손익 제외)',review:'분류 대기 (손익 제외)'};
 const sources={manual:'직접 입력',toss:'토스 POS',hyundai:'현대카드',kb:'국민은행'};
 const txSources={manual:'직접 입력',hyundai:'현대카드',kb:'국민은행'};
 const cats=['소모품','원두·음료','공과금','결제수수료','광고비','로열티','매출','기타'];
 let ctx, filter='all', draft=null;
 const won=n=>Number(n).toLocaleString('ko-KR')+'원';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const md=d=>{const [,m,dd]=d.split('-');return `${Number(m)}/${Number(dd)}`;};
 function options(map,v){return Object.entries(map).map(([k,l])=>`<option value="${esc(k)}" ${k===v?'selected':''}>${esc(l)}</option>`).join('');}
 const catOptions=v=>options(Object.fromEntries((cats.includes(v)||!v?cats:[...cats,v]).map(x=>[x,x])),v||'기타');
 function data(){return ctx.finance()||null;}
 function config(f,ym){
   const m=f.months||{};
   if(m[ym])return m[ym];
   const d=m.default;
   return {fixed:d?d.fixed:[],royaltyRate:d?d.royaltyRate:0,confirmed:false,excludedPurchases:[],fromDefault:!!d};
 }
 function download(name,body,type){const u=URL.createObjectURL(new Blob([body],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
 // 시트 안 저장 버튼: 두 번 눌리지 않게 막고, 실패하면 시트 안에 이유를 보여 준다
 async function submit(sh,btn,fn,okMsg){
   const err=sh.querySelector('[role=alert]');if(err)err.textContent='';
   if(btn){if(btn.disabled)return;btn.disabled=true;btn.dataset.label=btn.textContent;btn.textContent='저장 중…';}
   try{const r=await fn();ctx.closeSheet();await ctx.refresh();if(okMsg)ctx.toast(typeof okMsg==='function'?okMsg(r):okMsg);}
   catch(e){if(err)err.textContent=e.message||'저장하지 못했어요.';else ctx.toast(e.message);if(btn){btn.disabled=false;btn.textContent=btn.dataset.label;}}
 }

 function view(c){
   ctx=c;if(!ctx.isOwner())return '<div class="card empty">점주만 볼 수 있어요.</div>';
   const ym=ctx.month(), f=data();
   if(!f)return '<section class="card"><h2>매출·비용</h2><p>서버에 재무 기능이 아직 준비되지 않았어요. 서버 배포 뒤에 쓸 수 있어요.</p></section>';
   if(f.month!==ym)return `<section class="card"><h2>${esc(ctx.monthLabel(ym))} 장부를 불러오는 중</h2></section>`;
   const cfg=config(f,ym),pay=ctx.payroll(ym),s=C.summarize(f.tx,ym,cfg,pay,ctx.purchases(),ctx.today());
   const daily=C.dailyTotals(f.tx,ym), dayList=Object.entries(daily).sort((a,b)=>b[0].localeCompare(a[0]));
   const others=f.tx.filter(r=>!C.isDayRow(r));
   const rows=others.filter(r=>filter==='all'||r.kind===filter).sort((a,b)=>b.date.localeCompare(a.date));
   const buys=ctx.purchases().filter(p=>(p.date||'').startsWith(ym));
   const warn=[];
   if(s.missingDays.length)warn.push(`매출 안 넣은 날 ${s.missingDays.length}일`);
   if(!cfg.confirmed)warn.push('월 비용 설정 확인 전');
   if(s.review)warn.push(`분류 대기 ${s.review}건`);
   if(!s.hasRoyalty&&!s.royaltyRate)warn.push('로열티 비율 미설정');
   const royaltyLabel=s.hasRoyalty?'로열티 (실제 지출로 대체됨)':`로열티 ${s.royaltyRate}% · ${s.final?`${md(s.lastDay)} 말일 매출 기준`:`말일(${md(s.lastDay)}) 기준 예상`}`;
   return `<section class="fin-top"><div class="spread"><div><div class="faint">홍제역점 · 점주 전용</div><h2>매출·비용 <span class="pill s-warn">검토용</span></h2></div><input aria-label="조회 월" id="fin-month" type="month" value="${ym}"></div>
   <div class="fin-hero"><span>${esc(ctx.monthLabel(ym))} 예상 운영이익</span><strong class="num ${s.hasSales&&s.profit<0?'fin-loss':''}">${s.hasSales?won(s.profit):'매출을 넣어 주세요'}</strong>
   <div>${warn.length?'아직 빠진 게 있어요 · '+warn.join(' · '):(s.final?'입력된 기준으로 마감 가능한 상태예요':'지금까지 입력된 기준의 추정치')}</div>
   <div class="fin-formula">매출(취소 반영) − 운영비 − 월 고정비 − 급여·리워드 − 로열티</div></div>
   <div class="fin-metrics"><div><span>매출 (취소 반영)</span><b class="num">${won(s.sales)}</b></div><div><span>비용 합계</span><b class="num">${won(s.expense)}</b></div></div>
   <div class="row"><button class="btn primary" data-fin="day">+ 일 매출</button><button class="btn" data-fin="add">+ 비용·기타 거래</button><button class="btn" data-fin="import">파일 가져오기</button><button class="btn" data-fin="settings">월 비용 설정</button></div>
   <p class="faint">부가세 포함 금액 기준의 운영 참고값이에요. 세금·감가상각·안 넣은 비용은 빠져 있어서 최종 순이익과 달라요. 금융 자동 연동은 아직 안 되어 있어요.</p></section>

   <section><div class="spread"><h2>일 매출 <span class="sub">${s.daysEntered}/${s.daysPassed}일 입력</span></h2></div>
   ${s.missingDays.length?`<div class="fin-notice">안 넣은 날: ${s.missingDays.slice(0,40).map(d=>`<button class="fin-chip" data-fin-day="${d}">${md(d)}</button>`).join('')}${s.missingDays.length>40?' …':''}<br><span class="faint">쉬는 날은 0원으로 넣으면 입력한 날로 셀게요.</span></div>`:''}
   <div class="list">${dayList.length?dayList.map(([d,v])=>`<button class="item fin-transaction" data-fin-day="${d}"><div><div class="nm">${md(d)} ${'일월화수목금토'[new Date(d+'T00:00:00Z').getUTCDay()]}</div>${v.refunds?`<div class="faint">취소·환불 ${won(v.refunds)}</div>`:''}</div><b class="num">${won(v.sales-v.refunds)}</b></button>`).join(''):'<div class="card empty">토스 POS의 하루 매출 합계를 넣어 주세요.</div>'}</div></section>

   <section><h2>비용이 어디에 쓰였나요?</h2><div class="list">${[['직접 넣은·가져온 운영비',s.variable-s.purchaseAmount],['운영실 비품 주문',s.purchaseAmount],['월 고정비',s.fixed],['급여·리워드 (근무 기록 기준)',s.payroll],[royaltyLabel,s.royalty]].map(([l,n])=>`<div class="item"><span>${esc(l)}</span><b class="num">${won(n)}</b></div>`).join('')}</div>
   <div class="faint">급여는 관리 탭과 같은 방식(근무일 × 1시간 30분 × 시급 + 리워드)이고, 그만둔 매니저의 그 달 근무도 넣어요. 시급은 지금 등록된 값으로 계산해요. 로열티를 실제 운영비(분류 ‘로열티’)로 넣으면 예상액 대신 그 금액을 써요.</div>
   ${buys.length?`<details class="fin-details"><summary>비품 주문 중복 확인 · ${buys.length}건</summary><p class="faint">카드 사용내역에도 있는 주문이면 여기서 빼 주세요. 두 번 계산하지 않게요.</p>${buys.map(b=>`<label class="fin-check"><input type="checkbox" data-fin-purchase="${esc(b.row)}" ${(cfg.excludedPurchases||[]).includes(String(b.row))?'checked':''}>손익에서 빼기 · ${esc(b.date)} ${esc(b.name)} ${won(Number(b.price)||0)}</label>`).join('')}</details>`:''}</section>

   <section><div class="spread"><h2>비용·기타 거래 <span class="sub">${rows.length}건</span></h2><select aria-label="거래 필터" id="fin-filter">${options({all:'전체',...labels},filter)}</select></div>
   ${s.review?`<div class="fin-notice">분류 대기 ${s.review}건은 손익에 안 들어가 있어요. <button class="btn small" data-fin="classify">한꺼번에 분류하기</button></div>`:''}
   <div class="list">${rows.length?rows.map(r=>`<button class="item fin-transaction" data-fin-edit="${esc(r.id)}"><div><div class="nm">${esc(r.name)}</div><div class="faint">${r.date} · ${sources[r.source]||esc(r.source)} · ${labels[r.kind]}</div><small>${esc(r.category)}${r.note?' · '+esc(r.note):''}</small></div><b class="num">${won(r.amount)}</b></button>`).join(''):'<div class="card empty">이 달에 넣은 비용 거래가 없어요.</div>'}</div></section>

   <section><h2>연결 현황</h2><div class="list">${['토스 POS · 일 매출','현대카드 · 사업 지출','국민은행 · 입출금 확인'].map(l=>`<div class="item"><span>${l}</span><span class="pill s-off">자동 연동 안 됨</span></div>`).join('')}</div><p class="faint">지금은 직접 입력이나 파일 가져오기로 넣어요. 국민은행의 매출 정산 입금·카드대금 출금은 매출·비용으로 또 더하지 마세요.</p><div class="row"><button class="btn small" data-fin="export">이번 달 CSV 내려받기</button></div></section>`;
 }

 function dayEntry(date){
   const f=data(), dd=C.dailyTotals(f.tx,date.slice(0,7))[date], has=!!dd;
   ctx.openSheet(`<h3>일 매출 ${has?'고치기':'넣기'}</h3><form id="fin-entry"><div class="field"><label>날짜<input name="date" type="date" required value="${esc(date)}" ${has?'readonly':''}></label></div><div class="field"><label>토스 매출 합계 (원)<input name="sales" inputmode="numeric" required value="${has?dd.sales:''}" placeholder="예: 412000"></label></div><div class="field"><label>취소·환불 합계 (원, 없으면 0)<input name="refunds" inputmode="numeric" value="${has?dd.refunds:0}"></label></div><p class="faint">토스 POS의 그날 총 매출(취소 전)과 취소 금액을 따로 넣어 주세요. 이미 취소를 뺀 금액이라면 취소는 0으로 두세요.</p><div class="acts">${has?'<button class="btn" type="button" data-fin-remove>지우기</button>':''}<button class="btn" type="button" data-close>닫기</button><button class="btn primary">저장</button></div><p role="alert"></p></form>`,sh=>{
     const form=sh.querySelector('form');
     form.onsubmit=e=>{e.preventDefault();const o=Object.fromEntries(new FormData(form));submit(sh,form.querySelector('.btn.primary'),async()=>{if(!C.validDate(o.date))throw Error('날짜를 확인해 주세요.');return ctx.call('financeDaySave',{date:o.date,sales:C.amount(o.sales),refunds:C.amount(o.refunds||0)});},`${md(o.date)} 매출을 저장했어요.`);};
     sh.querySelector('[data-fin-remove]')?.addEventListener('click',e=>submit(sh,e.target,()=>ctx.call('financeDaySave',{date,remove:true}),'지웠어요.'));
   });
 }
 function entry(id){
   const f=data(),r=f.tx.find(x=>x.id===id)||{date:ctx.today(),kind:'expense',name:'',amount:'',category:'기타',source:'manual',externalId:'',note:''};
   ctx.openSheet(`<h3>${id?'거래 확인·고치기':'비용·기타 거래 넣기'}</h3><form id="fin-entry"><div class="field"><label>날짜<input name="date" type="date" required value="${esc(r.date)}"></label></div><div class="field"><label>구분<select name="kind">${options(labels,r.kind)}</select></label></div><div class="field"><label>거래 내용<input name="name" required maxlength="200" value="${esc(r.name)}" placeholder="예: 원두 구매 / 전기요금"></label></div><div class="field"><label>금액 (원)<input name="amount" inputmode="numeric" required value="${r.amount}"></label></div><div class="field"><label>출처<select name="source">${options(r.source==='toss'?sources:txSources,r.source)}</select></label></div><div class="field"><label>분류<select name="category">${catOptions(r.category)}</select></label></div><div class="field"><label>거래번호 (선택)<input name="externalId" value="${esc(r.externalId)}" maxlength="200"></label></div><p class="faint">토스 매출은 ‘일 매출’로 넣어 주세요. 월 고정비·급여·운영실 비품 주문에 이미 들어간 비용은 또 넣지 마세요.</p><div class="acts">${id?'<button class="btn" type="button" data-fin-remove>지우기</button>':''}<button class="btn" type="button" data-close>닫기</button><button class="btn primary">저장</button></div><p role="alert"></p></form>`,sh=>{
     const form=sh.querySelector('form');
     form.onsubmit=e=>{e.preventDefault();const o=Object.fromEntries(new FormData(form));submit(sh,form.querySelector('.btn.primary'),async()=>{const t=C.validate({...o,note:r.note||''});return ctx.call('financeTxSave',id?{id,orig:r.updatedAt,tx:t}:{tx:t});},'저장했어요.');};
     sh.querySelector('[data-fin-remove]')?.addEventListener('click',e=>submit(sh,e.target,()=>ctx.call('financeTxSave',{id,orig:r.updatedAt,remove:true}),'지웠어요.'));
   });
 }
 function settings(){
   const ym=ctx.month(),f=data(),cfg=config(f,ym);
   let fixed=(cfg.fixed||[]).map(x=>({...x}));
   const rowsHtml=()=>fixed.map((r,i)=>`<div class="fin-fixed"><input aria-label="항목 이름" name="n${i}" maxlength="40" value="${esc(r.name)}" placeholder="항목"><input aria-label="금액" name="a${i}" inputmode="numeric" value="${r.amount??''}" placeholder="원"><button type="button" class="btn small ghost" data-fx-del="${i}" aria-label="빼기">✕</button></div>`).join('');
   ctx.openSheet(`<h3>${esc(ctx.monthLabel(ym))} 월 비용 설정</h3>${!(f.months||{})[ym]?`<p class="fin-notice">${cfg.fromDefault?'지난번 저장한 금액을 불러왔어요. 이달 실제 금액인지 확인해 주세요.':'처음이에요. 매달 나가는 고정비를 넣어 주세요.'}</p>`:''}<form id="fin-settings"><div id="fin-fixed-list">${rowsHtml()}</div><button type="button" class="btn small" data-fx-add>+ 항목 추가</button><p class="faint">여기 넣은 비용은 월 전액 반영돼요. 같은 건을 거래로 또 넣지 마세요. 달마다 달라지는 전기·수도는 운영비 거래로 넣어 주세요.</p><div class="field"><label>로열티 비율 (매출의 %)<input name="rate" required inputmode="decimal" value="${cfg.royaltyRate||''}"></label></div><p class="faint">로열티 = 그 달 말일까지의 매출(취소 반영) × 비율로 계산해요.</p><label class="fin-check"><input name="alsoDefault" type="checkbox" checked>다음 달부터도 이 금액으로 시작</label><label class="fin-check"><input name="confirmed" type="checkbox" ${cfg.confirmed?'checked':''}>이달 고정비가 맞고, 거래로 또 넣지 않았어요</label><div class="acts"><button class="btn" type="button" data-close>닫기</button><button class="btn primary">저장</button></div><p role="alert"></p></form>`,sh=>{
     const form=sh.querySelector('form'),list=sh.querySelector('#fin-fixed-list');
     const sync=()=>{fixed=fixed.map((r,i)=>({name:form.elements['n'+i]?.value??r.name,amount:form.elements['a'+i]?.value??r.amount}));};
     const redraw=()=>{list.innerHTML=rowsHtml();list.querySelectorAll('[data-fx-del]').forEach(b=>b.onclick=()=>{sync();fixed.splice(Number(b.dataset.fxDel),1);redraw();});};
     redraw();
     sh.querySelector('[data-fx-add]').onclick=()=>{sync();fixed.push({name:'',amount:''});redraw();list.querySelector('.fin-fixed:last-child input')?.focus();};
     form.onsubmit=e=>{e.preventDefault();sync();const fd=new FormData(form);submit(sh,form.querySelector('.btn.primary'),async()=>{
       const items=fixed.filter(r=>String(r.name).trim()||String(r.amount).trim()).map(r=>{if(!String(r.name).trim())throw Error('고정비 이름을 적어 주세요.');return {name:String(r.name).trim(),amount:C.amount(r.amount)};});
       const rate=Number(String(fd.get('rate')).replace('%',''));if(!Number.isFinite(rate)||rate<0||rate>100)throw Error('로열티는 0~100% 범위로 넣어 주세요.');
       return ctx.call('financeMonthSave',{ym,fixed:items,royaltyRate:rate,confirmed:fd.get('confirmed')==='on',alsoDefault:fd.get('alsoDefault')==='on'});
     },'이달 비용 설정을 저장했어요.');};
   });
 }
 function classify(){
   const ym=ctx.month(),f=data(),list=f.tx.filter(r=>r.date.startsWith(ym)&&r.kind==='review').sort((a,b)=>a.date.localeCompare(b.date));
   const kindOpts=r=>options(r.source==='kb'?{transfer:labels.transfer,review:labels.review}:{expense:'운영비',expenseRefund:'비용 환급 (취소)',transfer:'손익 제외',sale:'매출',refund:'매출 취소',review:'나중에'},r.source==='kb'?'transfer':/마이너스|취소/.test(r.note)?'expenseRefund':'expense');
   ctx.openSheet(`<h3>분류 대기 ${list.length}건</h3><p class="faint">구분과 분류를 고른 뒤 한 번에 저장해요. 마이너스로 들어온 건은 ‘비용 환급’으로 골라 두었어요. 월세처럼 월 비용 설정에 이미 있는 건은 ‘손익 제외’로 골라 주세요.</p><form><div class="fin-classify">${list.map((r,i)=>`<div class="fin-crow"><div class="fin-cname"><b>${esc(r.name)}</b><span class="faint">${md(r.date)} · ${sources[r.source]||''}${r.note?' · '+esc(r.note):''}</span></div><b class="num">${won(r.amount)}</b><select name="k${i}" aria-label="구분">${kindOpts(r)}</select><select name="c${i}" aria-label="분류">${catOptions(r.category)}</select></div>`).join('')}</div><div class="acts"><button class="btn" type="button" data-close>닫기</button><button class="btn primary">저장</button></div><p role="alert"></p></form>`,sh=>{
     const form=sh.querySelector('form');
     form.onsubmit=e=>{e.preventDefault();const fd=new FormData(form);submit(sh,form.querySelector('.btn.primary'),async()=>{
       const items=list.map((r,i)=>({id:r.id,kind:fd.get('k'+i),category:fd.get('c'+i)})).filter(x=>x.kind!=='review');
       if(!items.length)throw Error('분류할 거래를 골라 주세요.');
       return ctx.call('financeClassify',{items});
     },r=>`${r.updated}건을 분류했어요.`);};
   });
 }
 async function chooseFile(accept){return new Promise(resolve=>{const i=document.createElement('input');i.type='file';i.accept=accept;i.onchange=()=>resolve(i.files[0]);i.oncancel=()=>resolve(null);i.click();});}
 async function importer(){
   const file=await chooseFile('.csv,text/csv');if(!file)return;
   try{if(file.size>4*1024*1024)throw Error('4MB 이하 CSV 파일을 골라 주세요.');const bytes=await file.arrayBuffer();let text=new TextDecoder('utf-8',{fatal:false}).decode(bytes);if(text.includes('�'))text=new TextDecoder('euc-kr').decode(bytes);draft=C.parseCSV(text);if(draft.rows.length>5000)throw Error('한 번에 5,000줄 이하로 가져와 주세요.');mapping();}catch(e){ctx.toast(e.message);}
 }
 function mapping(){
   const hs=draft.headers,guess=patterns=>hs.findIndex(h=>patterns.some(p=>h.includes(p)));
   const cols=(name,label,patterns,optional=false)=>{const g=guess(patterns);return `<div class="field"><label>${label}<select name="${name}">${optional?'<option value="">없음</option>':''}${hs.map((h,i)=>`<option value="${i}" ${i===(optional?g:Math.max(0,g))?'selected':''}>${esc(h)}</option>`).join('')}</select></label></div>`;};
   const body=src=>src==='toss'
     ?`${cols('date','날짜',['날짜','일자','영업일'])}${cols('sales','매출 합계 (취소 전 또는 취소 반영)',['총매출','총 매출','매출','결제금액','금액'])}${cols('refunds','취소 금액 (따로 있으면)',['취소','환불'],true)}<p class="faint">같은 날짜가 여러 줄이면 더해서 하루 합계로 넣어요. 이미 넣은 날은 파일 값으로 바뀌어요.</p>`
     :`${cols('date','거래 날짜',['날짜','일자','일시','이용일'])}${cols('name','내용·가맹점명',['가맹점','내용','적요','거래처','상품'])}${cols('amount','금액',['이용금액','금액','출금','입금'])}${cols('externalId','승인번호·거래번호 (선택)',['승인번호','거래번호'],true)}<label class="fin-check"><input type="checkbox" name="skipSimilar" checked>장부에 이미 있는 같은 날짜·내용·금액은 건너뛰기 (같은 파일을 두 번 올릴 때)</label><p class="faint">마이너스 금액은 취소로 표시해 둬요. 가져온 건은 ‘분류 대기’로 들어가고, 분류해야 손익에 들어가요.</p>`;
   ctx.openSheet(`<h3>파일 가져오기</h3><p>총 ${draft.rows.length}줄</p><form><div class="field"><label>어떤 파일인가요?<select name="source"><option value="toss">토스 POS · 일별 매출</option><option value="hyundai">현대카드 · 사용내역</option><option value="kb">국민은행 · 입출금 (손익 제외)</option></select></label></div><div id="fin-map">${body('toss')}</div><div class="acts"><button type="button" class="btn" data-close>닫기</button><button class="btn primary">미리보기</button></div><p role="alert"></p></form>`,sh=>{
    const form=sh.querySelector('form');
    form.elements.source.onchange=e=>{sh.querySelector('#fin-map').innerHTML=body(e.target.value);};
    form.onsubmit=e=>{e.preventDefault();const err=sh.querySelector('[role=alert]');try{const o=Object.fromEntries(new FormData(form));
     if(o.source==='toss'){if(o.date===o.sales)throw Error('날짜와 매출은 서로 다른 열을 골라 주세요.');const t=C.toDays(draft.rows,{date:o.date,sales:o.sales,refunds:o.refunds});if(!t.days.length)throw Error('날짜가 들어 있는 줄이 없어요. 날짜 열을 확인해 주세요.');previewDays(t.days,t.skipped);return;}
     if(new Set([o.date,o.name,o.amount]).size!==3)throw Error('날짜·내용·금액은 서로 다른 열을 골라 주세요.');
     let skipped=0;const rows=draft.rows.map((cells,i)=>{if(!C.looksDate(cells[o.date])){skipped++;return null;}try{const a=C.signedAmount(cells[o.amount]);return {date:C.parseDate(cells[o.date]),name:String(cells[o.name]||'').trim()||'(내용 없음)',amount:a.amount,note:a.negative?'마이너스(취소)':'',externalId:o.externalId!==''?String(cells[o.externalId]||'').trim():''};}catch(x){throw Error(`${i+2}행: ${x.message}`);}}).filter(Boolean);
     if(!rows.length)throw Error('날짜가 들어 있는 줄이 없어요. 날짜 열을 확인해 주세요.');
     previewRows(o.source,rows,o.skipSimilar==='on',skipped);
    }catch(x){err.textContent=x.message;}};
   });
 }
 function previewDays(days,skippedLines=0){
   const have=new Set(data().tx.filter(C.isDayRow).map(r=>r.date));
   ctx.openSheet(`<h3>일 매출 ${days.length}일</h3>${skippedLines?`<p class="faint">날짜가 없는 줄(합계 등) ${skippedLines}줄은 뺐어요.</p>`:''}<p class="faint">이미 넣은 날 중 이 달 장부에 보이는 날은 ‘바뀜’으로 표시했어요. 다른 달 날짜도 함께 저장돼요.</p><div class="list">${days.slice(0,40).map(d=>`<div class="item"><div>${d.date}${have.has(d.date)?' <span class="pill s-warn">바뀜</span>':''}${d.refunds?`<br><span class="faint">취소 ${won(d.refunds)}</span>`:''}</div><b class="num">${won(d.sales-d.refunds)}</b></div>`).join('')}</div>${days.length>40?`<p>처음 40일만 보여요.</p>`:''}<div class="acts"><button class="btn" data-close>취소</button><button class="btn primary" id="fin-commit">장부에 넣기</button></div><p role="alert"></p>`,sh=>{
     sh.querySelector('#fin-commit').onclick=e=>submit(sh,e.target,()=>ctx.call('financeImport',{days}),r=>`${r.days}일 매출을 넣었어요.`);
   });
 }
 function previewRows(source,rows,skipSimilar,skippedLines=0){
   ctx.openSheet(`<h3>가져오기 확인 · ${rows.length}건</h3>${skippedLines?`<p class="faint">날짜가 없는 줄(합계 등) ${skippedLines}줄은 뺐어요.</p>`:''}<p class="faint">${source==='kb'?'국민은행 입출금은 손익 제외로 들어가요.':'모두 분류 대기로 들어가요. 넣은 뒤 ‘한꺼번에 분류하기’로 정리해 주세요.'}</p><div class="list">${rows.slice(0,15).map(r=>`<div class="item"><div>${r.date}<br>${esc(r.name)}${r.note?` <span class="pill s-warn">취소</span>`:''}</div><b class="num">${won(r.amount)}</b></div>`).join('')}</div>${rows.length>15?'<p>처음 15건만 보여요.</p>':''}<div class="acts"><button class="btn" data-close>취소</button><button class="btn primary" id="fin-commit">장부에 넣기</button></div><p role="alert"></p>`,sh=>{
     sh.querySelector('#fin-commit').onclick=e=>submit(sh,e.target,async()=>{let added=0,skipped=0;for(let i=0;i<rows.length;i+=2000){const r=await ctx.call('financeImport',{source,rows:rows.slice(i,i+2000),skipSimilar});added+=r.added;skipped+=r.skipped;}draft=null;return {added,skipped};},r=>`${r.added}건 넣었어요${r.skipped?` · 이미 있던 ${r.skipped}건은 건너뜀`:''}.`);
   });
 }
 function bind(el){
  if(!ctx?.isOwner())return;
  el.querySelector('#fin-month')?.addEventListener('change',e=>{if(/^\d{4}-\d{2}$/.test(e.target.value))ctx.setMonth(e.target.value);});
  el.querySelector('#fin-filter')?.addEventListener('change',e=>{filter=e.target.value;ctx.render();});
  el.querySelectorAll('[data-fin-edit]').forEach(b=>b.onclick=()=>entry(b.dataset.finEdit));
  el.querySelectorAll('[data-fin-day]').forEach(b=>b.onclick=()=>dayEntry(b.dataset.finDay));
  el.querySelectorAll('[data-fin-purchase]').forEach(b=>b.onchange=async()=>{b.disabled=true;try{await ctx.call('financeMonthSave',{ym:ctx.month(),purchase:b.dataset.finPurchase,exclude:b.checked});await ctx.refresh();}catch(e){b.checked=!b.checked;b.disabled=false;ctx.toast(e.message);}});
  const today=ctx.today(),ym=ctx.month();
  const actions={day:()=>dayEntry(today.startsWith(ym)?today:C.lastDay(ym)),add:()=>entry(),settings,classify,import:importer,
    export:()=>download('홍제장부-'+ym+'.csv',C.exportCSV(data().tx.filter(r=>r.date.startsWith(ym))),'text/csv;charset=utf-8')};
  el.querySelectorAll('[data-fin]').forEach(b=>b.onclick=()=>{try{actions[b.dataset.fin]?.();}catch(e){ctx.toast(e.message);}});
 }
 window.HongjeFinance={view,bind};
})();
