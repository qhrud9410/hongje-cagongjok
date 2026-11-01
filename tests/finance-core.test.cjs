const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../finance-core.js');
const row=(kind,amount,extra={})=>C.validate({id:'a',date:'2026-11-01',name:'테스트',kind,amount,source:'manual',category:'기타',...extra});
const day=(date,sales,refunds=0)=>[{id:'toss-day-'+date,date,kind:'sale',source:'toss',name:'토스 일 매출',amount:sales,category:'매출'},...(refunds?[{id:'toss-refund-'+date,date,kind:'refund',source:'toss',name:'취소',amount:refunds,category:'매출'}]:[])];
test('취소·비용 환급·미분류·통장 입출금을 구분한다',()=>{
 const s=C.summarize([row('sale',100000),row('refund',10000),row('expense',20000),row('expenseRefund',5000),row('transfer',90000),row('review',99999)],'2026-11',{fixed:[{amount:10000}],royaltyRate:10},16050);
 assert.equal(s.sales,90000);assert.equal(s.variable,15000);assert.equal(s.royalty,9000);assert.equal(s.expense,50050);assert.equal(s.profit,39950);assert.equal(s.review,1);
});
test('로열티 = 그 달 전체 매출(취소 반영) × 비율, 말일 전에는 추정',()=>{
 const rows=[...day('2026-11-01',300000,20000),...day('2026-11-30',200000),...day('2026-10-31',999999)];
 const mid=C.summarize(rows,'2026-11',{royaltyRate:8},0,[],'2026-11-15');
 assert.equal(mid.sales,480000);assert.equal(mid.royalty,38400);assert.equal(mid.final,false);assert.equal(mid.lastDay,'2026-11-30');
 const after=C.summarize(rows,'2026-11',{royaltyRate:8},0,[],'2026-12-01');assert.equal(after.final,true);assert.equal(after.royalty,38400);
 assert.equal(C.summarize(rows,'2026-11',{},0,[],'2026-12-01').royalty,0,'비율 미설정이면 0 (10%로 가정하지 않음)');
 assert.equal(C.lastDay('2028-02'),'2028-02-29');
});
test('로열티 실지출은 추정 로열티를 대체한다',()=>{
 const s=C.summarize([row('sale',100000),row('expense',12000,{category:'로열티'})],'2026-11',{royaltyRate:10});
 assert.equal(s.royalty,0);assert.equal(s.expense,12000);assert.equal(s.profit,88000);
});
test('일 매출 입력 현황: 지난 날 중 빠진 날을 찾는다',()=>{
 const rows=[...day('2026-11-01',1000),...day('2026-11-03',0)];
 const s=C.summarize(rows,'2026-11',{},0,[],'2026-11-04');
 assert.equal(s.daysPassed,4);assert.equal(s.daysEntered,2);assert.deepEqual(s.missingDays,['2026-11-02','2026-11-04']);
 assert.equal(C.summarize(rows,'2026-12',{},0,[],'2026-11-04').daysPassed,0);
 assert.equal(C.summarize(rows,'2026-10',{},0,[],'2026-11-04').daysPassed,31);
});
test('월 구분 및 비품 중복 제외',()=>{
 const s=C.summarize([row('sale',100000),row('sale',900000,{date:'2026-10-01'})],'2026-11',{royaltyRate:0,excludedPurchases:['2']},0,[{row:1,date:'2026-11-01',price:2000},{row:2,date:'2026-11-01',price:5000}]);
 assert.equal(s.sales,100000);assert.equal(s.purchaseAmount,2000);assert.equal(s.profit,98000);
});
test('실제 달력 날짜와 원 단위 정수만 허용한다',()=>{
 assert.throws(()=>row('sale',-100));assert.throws(()=>row('sale','1.5'));assert.throws(()=>row('sale',100,{date:'2026-02-30'}));
 assert.equal(row('sale','₩ 1,000원').amount,1000);
 assert.throws(()=>row('sale',100,{source:'kb'}),/국민은행/);
});
test('가져오기 금액·날짜 표기: 마이너스·괄호·소수점·여러 날짜 형식',()=>{
 assert.deepEqual(C.signedAmount('-5,000'),{amount:5000,negative:true});
 assert.deepEqual(C.signedAmount('(12,000)'),{amount:12000,negative:true});
 assert.deepEqual(C.signedAmount('3000.00'),{amount:3000,negative:false});
 assert.throws(()=>C.signedAmount('3000.5'));
 assert.equal(C.parseDate('2026.11.01'),'2026-11-01');assert.equal(C.parseDate('2026/11/1 13:22'),'2026-11-01');assert.equal(C.parseDate('20261101'),'2026-11-01');
 assert.throws(()=>C.parseDate('11/01'));
});
test('토스 일별 파일: 같은 날짜 여러 줄은 더하고, 마이너스는 취소로',()=>{
 const d=C.toDays([['2026-11-01','100,000','0'],['2026-11-01','50000','2000'],['2026.11.02','-3000',''],['합계','147,000','2000']],{date:0,sales:1,refunds:2});
 assert.deepEqual(d,{days:[{date:'2026-11-01',sales:150000,refunds:2000},{date:'2026-11-02',sales:0,refunds:3000}],skipped:1});
 assert.throws(()=>C.toDays([['2026-11-01','1'],['2026-02-30','1']],{date:0,sales:1,refunds:''}),/3행/);
});
test('인용부호, 줄바꿈, 쉼표가 든 CSV를 파싱한다',()=>{
 const d=C.parseCSV('﻿날짜,내용,금액\r\n2026-11-01,"원두, \"\"특별\"\"\n구매","12,000"');
 assert.deepEqual(d.rows,[['2026-11-01','원두, "특별"\n구매','12,000']]);
 assert.throws(()=>C.parseCSV('a,b\n"닫히지 않음,2'));
});
test('내보낸 거래 CSV에서 스프레드시트 수식을 실행하지 않는다',()=>{
 assert.match(C.exportCSV([row('sale',100,{name:'=HYPERLINK("bad")'})]),/"'=HYPERLINK/);
});
test('매출이 없는 달을 확정 매출로 취급하지 않는다',()=>{
 assert.equal(C.summarize([],'2026-11').hasSales,false);
 assert.equal(C.summarize(day('2026-11-01',0),'2026-11').hasSales,true);
});
const fs=require('node:fs'),path=require('node:path');
const fx=n=>{const b=fs.readFileSync(path.join(__dirname,'fixtures',n));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
test('토스 매출리포트(엑셀): 결제 상세내역으로 일 합계, 취소는 따로, 결제 합계와 대조',async()=>{
 const r=C.tossReport(await C.readXlsx(fx('toss-sample.xlsx')));
 assert.deepEqual(r.days,[{date:'2026-09-01',sales:104900,refunds:5900},{date:'2026-09-02',sales:5900,refunds:0},{date:'2026-09-03',sales:6900,refunds:0}]);
 assert.equal(r.net,111800);assert.equal(r.check,111800);assert.equal(r.matches,true);assert.equal(r.period,'2026-09-01 ~ 2026-09-30');
});
test('토스 ZIP(비밀번호): 비밀번호 없음·틀림을 알려 주고, 맞으면 연다',async()=>{
 const ab=fx('toss-sample.zip');assert.equal(C.isZip(ab),true);
 const z=C.openZip(ab),n=z.names.find(x=>x.endsWith('.xlsx'));assert.equal(z.encrypted(n),true);
 await assert.rejects(z.bytes(n,''),/비밀번호가 필요/);await assert.rejects(z.bytes(n,'1234'),/맞지 않아요/);
 const b=await z.bytes(n,'0000');const r=C.tossReport(await C.readXlsx(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)));
 assert.equal(r.net,111800);
});
test('토스 리포트가 아닌 엑셀은 null, 엑셀 날짜 숫자도 읽는다',async()=>{
 assert.equal(C.tossReport({'시트1':[['날짜','금액'],['2026-09-01',1]]}),null);
 assert.equal(C.parseDate(46266),'2026-09-01');assert.equal(C.looksDate(46266),true);
});
test('카드 수수료: 매출 × 수수료율로 추정, 실제 결제수수료를 넣으면 그 금액으로 대체',()=>{
 const est=C.summarize([row('sale',1000000),row('refund',20000)],'2026-11',{royaltyRate:10,feeRate:1.5});
 assert.equal(est.fee,14700);assert.equal(est.royalty,98000);assert.equal(est.profit,980000-98000-14700);
 const act=C.summarize([row('sale',1000000),row('expense',9000,{category:'결제수수료'})],'2026-11',{feeRate:1.5});
 assert.equal(act.fee,0);assert.equal(act.hasFee,true);assert.equal(act.expense,9000);
 assert.equal(C.summarize([row('sale',1000000)],'2026-11',{}).fee,0,'수수료율 미설정이면 0');
});
