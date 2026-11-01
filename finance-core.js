/* 매출·비용 계산 (원 단위, 부가세 포함 관리 금액). 네트워크를 쓰지 않는다. */
(function(root){
  'use strict';
  const kinds=['sale','refund','expense','expenseRefund','transfer','review'];
  const DAY='toss-day-', REFUND='toss-refund-';
  function amount(v){
    const s=String(v??'').replace(/[₩원,\s]/g,'');
    if(!/^\d+$/.test(s)) throw new Error('금액은 0 이상의 원 단위 정수로 입력해 주세요.');
    const n=Number(s); if(!Number.isSafeInteger(n)||n>10000000000) throw new Error('금액은 100억 원 이하로 입력해 주세요.'); return n;
  }
  // 가져오기용: "-5,000", "(5,000)", "5,000.00" 같은 표기를 받아 부호와 크기를 나눈다
  function signedAmount(v){
    let s=String(v??'').replace(/[₩원,\s]/g,'');
    let neg=false;
    if(/^\(.*\)$/.test(s)){neg=true;s=s.slice(1,-1);}
    if(s.startsWith('-')){neg=!neg;s=s.slice(1);}else if(s.startsWith('+'))s=s.slice(1);
    s=s.replace(/\.0+$/,'');
    return {amount:amount(s),negative:neg};
  }
  function validDate(s){return /^20\d{2}-\d{2}-\d{2}$/.test(s)&&!isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}
  // "2026.11.01", "2026/11/1 13:22", "20261101" → "2026-11-01"
  function parseDate(raw){
    const t=String(raw??'').trim();
    const m=t.match(/^(\d{4})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{1,2})/)||t.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/);
    const d=m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:t;
    if(!validDate(d)) throw new Error('날짜를 읽지 못했어요: '+t);
    return d;
  }
  function validate(r){
    if(!validDate(r.date)) throw new Error('날짜를 YYYY-MM-DD 형식으로 확인해 주세요.');
    if(!kinds.includes(r.kind)) throw new Error('거래 구분을 확인해 주세요.');
    if(!String(r.name||'').trim()) throw new Error('거래 내용을 입력해 주세요.');
    if(!['manual','toss','hyundai','kb'].includes(r.source)) throw new Error('거래 출처를 확인해 주세요.');
    if(r.source==='kb'&&!['transfer','review'].includes(r.kind)) throw new Error('국민은행 거래는 입출금 확인용이에요. 매출·비용은 원래 결제 출처에서 입력해 주세요.');
    return {...r,name:String(r.name).trim(),amount:amount(r.amount),category:String(r.category||'기타')};
  }
  const isDayRow=r=>String(r.id||'').startsWith(DAY)||String(r.id||'').startsWith(REFUND);
  const daysIn=ym=>{const [y,m]=ym.split('-').map(Number);return new Date(Date.UTC(y,m,0)).getUTCDate();};
  const lastDay=ym=>`${ym}-${String(daysIn(ym)).padStart(2,'0')}`;
  // 일별 매출 합계 표: {date:{sales,refunds}}
  function dailyTotals(rows,ym){
    const out={};
    rows.filter(r=>r.date.startsWith(ym)&&(r.kind==='sale'||r.kind==='refund')).forEach(r=>{const d=out[r.date]??={sales:0,refunds:0,entered:false};if(r.kind==='sale')d.sales+=r.amount;else d.refunds+=r.amount;if(String(r.id||'').startsWith(DAY))d.entered=true;});
    return out;
  }
  /*
    예상 운영이익 = (매출 − 취소) − (운영비 − 비용 환급) − 포함한 비품 주문 − 월 고정비 − 급여·리워드 − 로열티
    로열티 = 그 달 전체(말일까지) 매출 × 비율. 말일 전에는 지금까지 매출 기준 추정치.
    로열티를 실제 운영비로 넣은 달은 추정치 대신 그 금액을 쓴다.
  */
  function summarize(rows,ym,config={},payroll=0,purchases=[],today=''){
    const month=rows.filter(r=>r.date.startsWith(ym));
    const sum=k=>month.filter(r=>r.kind===k).reduce((s,r)=>s+r.amount,0);
    const sales=sum('sale')-sum('refund');
    const fixed=(config.fixed||[]).reduce((s,r)=>s+amount(r.amount),0);
    const costs={};
    month.filter(r=>r.kind==='expense'||r.kind==='expenseRefund').forEach(r=>costs[r.category]=(costs[r.category]||0)+(r.kind==='expense'?r.amount:-r.amount));
    const excluded=new Set((config.excludedPurchases||[]).map(String));
    const purchaseAmount=purchases.filter(p=>(p.date||'').startsWith(ym)&&!excluded.has(String(p.row))).reduce((s,p)=>s+(Number(p.price)||0),0);
    const variable=sum('expense')-sum('expenseRefund')+purchaseAmount;
    const hasRoyalty=month.some(r=>(r.kind==='expense'||r.kind==='expenseRefund')&&r.category==='로열티');
    const rate=Number(config.royaltyRate)||0;
    const royalty=hasRoyalty?0:Math.round(Math.max(0,sales)*rate/100);
    const expense=variable+fixed+payroll+royalty;
    const daily=dailyTotals(rows,ym);
    const end=lastDay(ym);
    // 지금까지 지난 날 수 (오늘 포함). 지난달이면 그 달 전체, 다음 달이면 0.
    const passedDays=!today||today>end?daysIn(ym):today<ym+'-01'?0:Number(today.slice(8,10));
    const entered=Object.keys(daily);
    return {sales,expense,profit:sales-expense,variable,fixed,payroll,royalty,royaltyRate:rate,purchaseAmount,costs,
      review:month.filter(r=>r.kind==='review').length,hasSales:month.some(r=>r.kind==='sale'),hasRoyalty,
      final:!!today&&today>end, lastDay:end, daysEntered:entered.length, daysPassed:passedDays,
      missingDays:Array.from({length:passedDays},(_,i)=>`${ym}-${String(i+1).padStart(2,'0')}`).filter(d=>!entered.includes(d))};
  }
  function parseCSV(text){
    const rows=[]; let row=[],cell='',quoted=false;
    text=text.replace(/^﻿/,'');
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||!cell){quoted=!quoted;}else throw new Error('CSV 따옴표 형식을 확인해 주세요.');}
      else if(c===','&&!quoted){row.push(cell);cell='';}
      else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}
      else cell+=c;
    }
    if(quoted)throw new Error('CSV 따옴표가 닫히지 않았어요.');
    row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
    if(rows.length<2)throw new Error('제목과 거래 내역이 있는 CSV를 선택해 주세요.');
    const headers=rows.shift().map(x=>x.trim());
    if(new Set(headers).size!==headers.length)throw new Error('CSV 열 제목이 중복돼요.');
    return {headers,rows};
  }
  // 토스 일별 집계: 같은 날짜가 여러 줄(결제수단별 등)이면 더한다. 음수 매출은 취소로 본다.
  // 날짜 칸이 날짜처럼 안 생긴 줄(합계·소계·빈 줄)은 건너뛰고 몇 줄인지 알려 준다
  const looksDate=v=>/^\s*\d{4}[.\/-]?\s*\d{1,2}[.\/-]?\s*\d{1,2}/.test(String(v??''));
  function toDays(cells,map){
    const days={};let skipped=0;
    cells.forEach((c,i)=>{
      if(!looksDate(c[map.date])){skipped++;return;}
      try{
        const date=parseDate(c[map.date]);
        const s=signedAmount(c[map.sales]);
        const d=days[date]??={date,sales:0,refunds:0};
        if(s.negative)d.refunds+=s.amount;else d.sales+=s.amount;
        if(map.refunds!==''&&map.refunds!=null&&String(c[map.refunds]??'').trim()!==''){const r=signedAmount(c[map.refunds]);d.refunds+=r.amount;}
      }catch(e){throw new Error(`${i+2}행: ${e.message}`);}
    });
    return {days:Object.values(days).sort((a,b)=>a.date.localeCompare(b.date)),skipped};
  }
  function csvCell(v){const s=String(v??'');return '"'+(/^[=+@\-\t\r]/.test(s)?"'":'')+s.replace(/"/g,'""')+'"';}
  function exportCSV(rows){return '﻿'+[['날짜','구분','내용','금액','분류','출처','거래번호'],...rows.map(r=>[r.date,r.kind,r.name,r.amount,r.category,r.source,r.externalId||''])].map(r=>r.map(csvCell).join(',')).join('\r\n');}
  const api={looksDate,amount,signedAmount,validDate,parseDate,validate,summarize,dailyTotals,parseCSV,toDays,exportCSV,kinds,isDayRow,daysIn,lastDay};
  if(typeof module!=='undefined')module.exports=api;else root.FinanceCore=api;
})(typeof window!=='undefined'?window:globalThis);
