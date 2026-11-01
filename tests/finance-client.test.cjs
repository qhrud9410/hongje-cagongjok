const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const core=require('../finance-core.js');
function fixture(finance,opts={}){
 const window={FinanceCore:core};
 // localStorage를 일부러 넣지 않는다: 화면이 브라우저 저장을 쓰면 여기서 바로 오류가 난다
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../finance.js'),'utf8'),{window,Date,console,structuredClone});
 const ctx={isOwner:()=>opts.owner!==false,today:()=>opts.today||'2026-11-15',month:()=>opts.month||'2026-11',monthLabel:x=>x,finance:()=>finance,purchases:()=>[],payroll:()=>16050,render(){},call:async()=>{},refresh:async()=>{}};
 return {api:window.HongjeFinance,ctx};
}
const fin=(tx=[],months={})=>({month:'2026-11',tx,months});
test('점주가 아니면 아무 금액도 보여 주지 않는다',()=>{
 const f=fixture(fin([{id:'toss-day-2026-11-01',date:'2026-11-01',kind:'sale',source:'toss',name:'x',amount:5900,category:'매출'}]),{owner:false});
 const html=f.api.view(f.ctx);assert.match(html,/점주만/);assert.doesNotMatch(html,/5,900/);
});
test('서버에 재무 기능이 없으면 안내만 하고 로컬 저장으로 넘어가지 않는다',()=>{
 const f=fixture(null);const html=f.api.view(f.ctx);assert.match(html,/서버 배포 뒤/);
});
test('다른 달 데이터가 오는 중이면 이전 달 숫자를 보여 주지 않는다',()=>{
 const f=fixture(fin([{id:'toss-day-2026-11-01',date:'2026-11-01',kind:'sale',source:'toss',name:'x',amount:5900,category:'매출'}]),{month:'2026-12'});
 assert.match(f.api.view(f.ctx),/불러오는 중/);
});
test('일 매출·로열티(말일 기준)·빠진 날·비율 미설정 안내',()=>{
 const tx=[{id:'toss-day-2026-11-01',date:'2026-11-01',kind:'sale',source:'toss',name:'토스 일 매출',amount:500000,category:'매출'}];
 let html=fixture(fin(tx),{}).api.view(fixture(fin(tx)).ctx);
 assert.match(html,/1\/15일 입력/);assert.match(html,/로열티 비율 미설정/);assert.match(html,/매출 안 넣은 날 14일/);
 const f=fixture(fin(tx,{'2026-11':{fixed:[{name:'월세',amount:100000}],royaltyRate:10,confirmed:true,excludedPurchases:[]}}));
 html=f.api.view(f.ctx);
 assert.match(html,/로열티 10% · 말일\(11\/30\) 기준 예상/);assert.match(html,/50,000원/);
 // 500,000 − 월세 100,000 − 급여 16,050 − 로열티 50,000
 assert.match(html,/333,950원/);
});
test('지난달은 말일 매출 기준으로 표시',()=>{
 const f=fixture(fin([],{'2026-11':{fixed:[],royaltyRate:10,confirmed:true,excludedPurchases:[]}}),{today:'2026-12-02'});
 assert.match(f.api.view(f.ctx),/11\/30 말일 매출 기준/);
});
test('새 달은 default 설정을 이어받되 확인 전으로 표시',()=>{
 const f=fixture(fin([],{default:{fixed:[{name:'월세',amount:1}],royaltyRate:7,confirmed:false,excludedPurchases:[]}}));
 const html=f.api.view(f.ctx);assert.match(html,/로열티 7%/);assert.match(html,/월 비용 설정 확인 전/);
});
test('분류 대기 건이 있으면 한꺼번에 분류 버튼을 보여 준다',()=>{
 const f=fixture(fin([{id:'t-1',date:'2026-11-03',kind:'review',source:'hyundai',name:'<b>다이소</b>',amount:5000,category:'기타',note:'마이너스(취소)'}]));
 const html=f.api.view(f.ctx);assert.match(html,/한꺼번에 분류하기/);assert.match(html,/&lt;b&gt;다이소/);assert.doesNotMatch(html,/<b>다이소/);
});
