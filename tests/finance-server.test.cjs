// 서버(Edge Function) 재무 기능 테스트 — 실제 Postgres에 마이그레이션을 적용한 뒤, 서버 코드를 HTTP 처리기째로 실행한다.
// 실행: PGSOCK=<소켓 폴더> REPO=<저장소> node --test finance-server.test.cjs
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const sb=require('./pgsb.cjs');
const REPO=process.env.REPO;
let handler;
const OWNER='9999', MGR='1111';
async function api(action,p={}){
  const res=await handler(new Request('http://x/',{method:'POST',body:JSON.stringify({action,p})}));
  return res.json();
}
const ok=async(a,p)=>{const r=await api(a,{ownerPin:OWNER,...p});assert.equal(r.ok,true,`${a}: ${r.error}`);return r.result;};
const bad=async(a,p,re)=>{const r=await api(a,p);assert.equal(r.ok,false,`${a} should fail`);if(re)assert.match(r.error,re);return r.error;};
const load=(p={})=>ok('load',p);
before(()=>{
  sb.psql(`truncate finance_tx, finance_month, managers, attendance, purchases, rewards, settings, auth_fail, realtime.sent;`,'postgres');
  sb.psql(`insert into managers(id,name,role,days,"startDate",wage,pin,active,"order",duty,"payTo") values
    ('m-owner','점주','점주','','', '0','${OWNER}','Y','0','',''),
    ('m-a','매니저A','매니저','월,화','2026-09-01','10700','${MGR}','Y','1','오전 청소',''),
    ('m-old','퇴사자','매니저','수','2026-08-01','10700','2222','N','2','오전 청소','');
    insert into attendance(key,date,mid,name,"inHM","inAt") values ('2026-08-05__m-old','2026-08-05','m-old','퇴사자','06:50','2026-08-04T21:50:00Z');
    insert into purchases(date,sid,name,price) values ('2026-11-02','s1','원두','30000');`,'postgres');
  let src=fs.readFileSync(path.join(REPO,'supabase/functions/api/index.ts'),'utf8').replace(/^import .*;\r?$/gm,'');
  src=stripTypeScriptTypes(src);
  const sandbox={createClient:sb.createClient,webpush:{setVapidDetails(){},sendNotification:async()=>{}},Deno:{env:{get:()=>''},serve:h=>{handler=h;}},console:{...console,error:(...a)=>process.env.DEBUG&&console.log("SERVER_ERR",...a)},TextEncoder,Date,Intl,crypto:globalThis.crypto,Response,Request,JSON,fetch:async()=>{throw Error('no network in test');}};
  vm.runInNewContext(src,sandbox);
});

test('바깥(anon·authenticated)에서는 재무 표를 직접 못 읽는다',()=>{
  for(const role of ['anon','authenticated'])for(const t of ['finance_tx','finance_month'])
    assert.throws(()=>sb.psql(`select * from ${t}`,role),/permission denied/);
});

test('매니저 PIN·틀린 점주 PIN으로는 재무 기능을 못 쓴다',async()=>{
  for(const a of ['financeTxSave','financeDaySave','financeImport','financeClassify','financeMonthSave']){
    await bad(a,{mid:'m-a',pin:MGR,date:'2026-11-01',sales:1},/PIN/);
  }
  sb.psql(`truncate auth_fail`,'postgres');
  const m=await api('load',{mid:'m-a',pin:MGR,finMonth:'2026-11'});
  assert.equal(m.ok,true);assert.equal(m.result.finance,null);assert.equal(m.result.isOwner,false);
});

test('일 매출: 넣기·고치기·취소 0원이면 취소 줄 삭제·지우기',async()=>{
  await ok('financeDaySave',{date:'2026-11-01',sales:500000,refunds:12000});
  let f=(await load({finMonth:'2026-11'})).finance;
  assert.deepEqual(f.tx.map(r=>[r.id,r.kind,r.amount]),[['toss-day-2026-11-01','sale',500000],['toss-refund-2026-11-01','refund',12000]]);
  const created=sb.psql(`select "createdAt" from finance_tx where id='toss-day-2026-11-01'`);
  await ok('financeDaySave',{date:'2026-11-01',sales:510000,refunds:0});
  f=(await load({finMonth:'2026-11'})).finance;
  assert.deepEqual(f.tx.map(r=>[r.id,r.amount]),[['toss-day-2026-11-01',510000]]);
  assert.equal(sb.psql(`select "createdAt" from finance_tx where id='toss-day-2026-11-01'`),created,'처음 만든 시각은 유지');
  await ok('financeDaySave',{date:'2026-11-02',sales:0});
  assert.equal((await load({finMonth:'2026-11'})).finance.tx.length,2,'쉬는 날 0원도 입력한 날로 남는다');
  await ok('financeDaySave',{date:'2026-11-02',remove:true});
  await bad('financeDaySave',{ownerPin:OWNER,date:'2026-02-30',sales:1},/날짜/);
  await bad('financeDaySave',{ownerPin:OWNER,date:'2026-11-03',sales:-5},/금액/);
  await bad('financeTxSave',{ownerPin:OWNER,id:'toss-day-2026-11-01',orig:'',tx:{}},/일 매출/);
});

test('토스 일별 파일: 같은 날짜 두 번은 거절, 다시 올리면 값이 바뀐다',async()=>{
  await bad('financeImport',{ownerPin:OWNER,days:[{date:'2026-10-01',sales:1},{date:'2026-10-01',sales:2}]},/같은 날짜/);
  assert.equal((await ok('financeImport',{days:[{date:'2026-10-01',sales:300000,refunds:0},{date:'2026-10-02',sales:200000,refunds:5000}]})).days,2);
  await ok('financeImport',{days:[{date:'2026-10-01',sales:310000,refunds:0}]});
  const f=(await load({finMonth:'2026-10'})).finance;
  assert.deepEqual(f.tx.map(r=>[r.id,r.amount]),[['toss-day-2026-10-01',310000],['toss-day-2026-10-02',200000],['toss-refund-2026-10-02',5000]]);
  await bad('financeImport',{ownerPin:OWNER,source:'toss',rows:[{date:'2026-10-03',name:'x',amount:1}]},/하루 합계/);
});

test('카드 파일: 승인번호 중복·같은 파일 재업로드는 건너뛰고, 같은 금액 정당한 두 건은 둘 다 들어간다',async()=>{
  const rows=[
    {date:'2026-11-03',name:'원두상회',amount:42000,externalId:'A1'},
    {date:'2026-11-03',name:'다이소',amount:5000,externalId:''},
    {date:'2026-11-03',name:'다이소',amount:5000,externalId:''},
    {date:'2026-11-04',name:'원두상회',amount:42000,externalId:'A2',note:'마이너스(취소)'},
  ];
  let r=await ok('financeImport',{source:'hyundai',rows,skipSimilar:true});
  assert.deepEqual(r,{added:4,skipped:0});
  r=await ok('financeImport',{source:'hyundai',rows,skipSimilar:true});
  assert.deepEqual(r,{added:0,skipped:4},'같은 파일 다시 올리기');
  r=await ok('financeImport',{source:'hyundai',rows:[...rows.slice(1,3),{date:'2026-11-03',name:'다이소',amount:5000}],skipSimilar:true});
  assert.deepEqual(r,{added:1,skipped:2},'세 번째 같은 금액 건만 새로 들어간다');
  const f=(await load({finMonth:'2026-11'})).finance;
  const card=f.tx.filter(x=>x.source==='hyundai');
  assert.equal(card.length,5);assert.ok(card.every(x=>x.kind==='review'));
  assert.equal(card.find(x=>x.externalId==='A2').note,'마이너스(취소)');
  r=await ok('financeImport',{source:'kb',rows:[{date:'2026-11-05',name:'토스 정산 입금',amount:480000,externalId:''}],skipSimilar:true});
  assert.equal((await load({finMonth:'2026-11'})).finance.tx.find(x=>x.source==='kb').kind,'transfer');
});

test('한꺼번에 분류: 국민은행은 매출·비용 불가, 나머지는 반영',async()=>{
  const f=(await load({finMonth:'2026-11'})).finance;
  const kb=f.tx.find(x=>x.source==='kb'), card=f.tx.filter(x=>x.source==='hyundai');
  await bad('financeClassify',{ownerPin:OWNER,items:[{id:kb.id,kind:'expense',category:'기타'}]},/국민은행/);
  await bad('financeClassify',{ownerPin:OWNER,items:[{id:'toss-day-2026-11-01',kind:'expense'}]},/분류할 수 없는/);
  const items=card.map(x=>({id:x.id,kind:x.note?'expenseRefund':'expense',category:x.name==='원두상회'?'원두·음료':'소모품'}));
  assert.equal((await ok('financeClassify',{items})).updated,5);
  const after=(await load({finMonth:'2026-11'})).finance.tx.filter(x=>x.source==='hyundai');
  assert.ok(after.every(x=>x.kind!=='review'));
  assert.equal(after.find(x=>x.externalId==='A2').kind,'expenseRefund');
});

test('거래 고치기: 다른 기기에서 먼저 바꿨으면 거절, 같은 출처·거래번호 중복 거절',async()=>{
  await ok('financeTxSave',{tx:{date:'2026-11-06',kind:'expense',source:'manual',name:'전기요금',amount:83000,category:'공과금'}});
  const t=(await load({finMonth:'2026-11'})).finance.tx.find(x=>x.name==='전기요금');
  await ok('financeTxSave',{id:t.id,orig:t.updatedAt,tx:{...t,amount:84000}});
  await bad('financeTxSave',{ownerPin:OWNER,id:t.id,orig:t.updatedAt,tx:{...t,amount:85000}},/다른 기기/);
  await bad('financeTxSave',{ownerPin:OWNER,tx:{date:'2026-11-06',kind:'expense',source:'hyundai',name:'중복',amount:1,externalId:'A1'}},/거래번호/);
  await bad('financeTxSave',{ownerPin:OWNER,tx:{date:'2026-11-06',kind:'sale',source:'kb',name:'입금',amount:1}},/국민은행/);
  const t2=(await load({finMonth:'2026-11'})).finance.tx.find(x=>x.name==='전기요금');
  assert.equal(t2.amount,84000);
  await ok('financeTxSave',{id:t2.id,orig:t2.updatedAt,remove:true});
});

test('월 설정: 초깃값(default) 이어받기, 비품 제외 토글이 다른 설정을 덮지 않음',async()=>{
  await ok('financeMonthSave',{ym:'2026-11',fixed:[{name:'월세',amount:1000000}],royaltyRate:5,confirmed:true,alsoDefault:true});
  let m=(await load({finMonth:'2026-11'})).finance.months;
  assert.deepEqual(m.default.fixed,[{name:'월세',amount:1000000}]);assert.equal(m.default.confirmed,false);
  const rid=sb.psql(`select rid from purchases limit 1`,'postgres');
  await ok('financeMonthSave',{ym:'2026-11',purchase:rid,exclude:true});
  m=(await load({finMonth:'2026-11'})).finance.months;
  assert.deepEqual(m['2026-11'].excludedPurchases,[rid]);assert.equal(m['2026-11'].royaltyRate,5);assert.equal(m['2026-11'].confirmed,true);
  await ok('financeMonthSave',{ym:'2026-12',purchase:rid,exclude:true});
  m=(await load({finMonth:'2026-12'})).finance.months;
  assert.equal(m['2026-12'].royaltyRate,5,'새 달은 default 값에서 시작');assert.equal(m['2026-12'].confirmed,false);
  await ok('financeMonthSave',{ym:'2026-11',purchase:rid,exclude:false});
  assert.deepEqual((await load({finMonth:'2026-11'})).finance.months['2026-11'].excludedPurchases,[]);
  await bad('financeMonthSave',{ownerPin:OWNER,ym:'2026-13',royaltyRate:1},/월/);
  await bad('financeMonthSave',{ownerPin:OWNER,ym:'2026-11',royaltyRate:120},/로열티/);
  await ok('financeMonthSave',{ym:'2026-11',feeRate:1.5,alsoDefault:true});
  m=(await load({finMonth:'2026-11'})).finance.months;
  assert.equal(m['2026-11'].feeRate,1.5);assert.equal(m.default.feeRate,1.5);assert.equal(m['2026-11'].royaltyRate,5,'수수료만 바꿔도 로열티 유지');
  await bad('financeMonthSave',{ownerPin:OWNER,ym:'2026-11',feeRate:-1},/수수료율/);
});

test('지난달 카테고리별 지출 합계가 함께 온다',async()=>{
  await ok('financeTxSave',{tx:{date:'2026-10-20',kind:'expense',source:'manual',name:'원두',amount:30000,category:'원두·음료'}});
  const f=(await load({finMonth:'2026-11'})).finance;
  assert.equal(f.prev.month,'2026-10');assert.equal(f.prev.cats['원두·음료'],30000);
  assert.equal((await load({finMonth:'2026-09'})).finance.prev,null);
});

test('재무 표가 바뀌면 화면 새로고침 신호(표 이름만)가 나간다',()=>{
  const sent=sb.psql(`select string_agg(distinct payload->>'t', ',' order by payload->>'t') from realtime.sent where topic='hongje-sync'`,'postgres');
  assert.match(sent,/finance_month/);assert.match(sent,/finance_tx/);
  assert.equal(sb.psql(`select count(*) from realtime.sent where payload::text like '%500000%' or payload::text like '%월세%'`,'postgres'),'0','금액·내용은 신호에 안 실린다');
});

test('먼 달을 보면 그 달 근무 기록도 같이 와서 급여 계산이 된다 (퇴사자 포함)',async()=>{
  const d=await load({finMonth:'2026-08'});
  assert.equal(d.finance.month,'2026-08');
  assert.ok(d.att['2026-08-05__m-old'],'2026-08 근무 기록 포함');
  assert.ok(d.managers.find(m=>m.id==='m-old'&&m.active===false));
});

test('점주 PIN 바꾸기: 지금 PIN 확인, 형식·매니저 PIN 중복 거절, 바꾼 뒤 예전 PIN은 안 됨',async()=>{
  sb.psql(`truncate auth_fail`,'postgres');
  await bad('ownerPinChange',{ownerPin:'0000',newPin:'4321'},/PIN이 맞지/);
  await bad('ownerPinChange',{ownerPin:OWNER,newPin:'12a4'},/숫자 4~8자리/);
  await bad('ownerPinChange',{ownerPin:OWNER,newPin:OWNER},/다른 번호/);
  await bad('ownerPinChange',{ownerPin:OWNER,newPin:MGR},/매니저 PIN/);
  await ok('ownerPinChange',{newPin:'4321'});
  assert.equal(sb.psql(`select count(*) from auth_fail where k='owner'`,'postgres'),'0','성공하면 틀린 횟수 초기화');
  const old=await api('load',{ownerPin:OWNER});assert.equal(old.result.isOwner,false);assert.equal(old.result.finance,null);
  const now=await api('load',{ownerPin:'4321'});assert.equal(now.result.isOwner,true);
  // 예전 방식 설정값이 있으면 그것도 같이 바뀐다
  sb.psql(`insert into settings(key,value) values ('점주PIN','4321')`,'postgres');
  await api('ownerPinChange',{ownerPin:'4321',newPin:OWNER}).then(r=>assert.equal(r.ok,true,r.error));
  assert.equal(sb.psql(`select value from settings where key='점주PIN'`,'postgres'),OWNER);
  sb.psql(`delete from settings where key='점주PIN'`,'postgres');
  assert.equal((await api('load',{ownerPin:OWNER})).result.isOwner,true);
});
