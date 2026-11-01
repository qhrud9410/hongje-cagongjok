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
    const sd=serialDate(raw);if(sd)return sd;
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
  const looksDate=v=>serialDate(v)!==null||/^\s*\d{4}[.\/-]?\s*\d{1,2}[.\/-]?\s*\d{1,2}/.test(String(v??''));
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
  /* ---- ZIP·엑셀(xlsx) 읽기: 외부 라이브러리 없이 브라우저 기본 기능(DecompressionStream)만 쓴다 ---- */
  const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  const crcByte=(c,b)=>(CRC[(c^b)&0xff]^(c>>>8))>>>0;
  // 토스가 매출 리포트에 거는 ZIP 비밀번호(전통 ZipCrypto) 풀기
  function zipDecrypt(data,password){
    let k0=0x12345678,k1=0x23456789,k2=0x34567890;
    const upd=b=>{k0=crcByte(k0,b);k1=(Math.imul((k1+(k0&0xff))>>>0,134775813)+1)>>>0;k2=crcByte(k2,(k1>>>24)&0xff);};
    for(const b of new TextEncoder().encode(password))upd(b);
    const out=new Uint8Array(data.length);
    for(let i=0;i<data.length;i++){const t=(k2|2)&0xffff;const c=data[i]^((Math.imul(t,t^1)>>>8)&0xff);out[i]=c;upd(c);}
    return out.subarray(12);
  }
  function openZip(ab){
    const u8=new Uint8Array(ab),dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);let e=-1;
    for(let i=u8.length-22;i>=Math.max(0,u8.length-65558);i--)if(dv.getUint32(i,true)===0x06054b50){e=i;break;}
    if(e<0)throw new Error('파일을 읽지 못했어요. 엑셀(xlsx)·ZIP·CSV 파일인지 확인해 주세요.');
    const files={},td=new TextDecoder();let p=dv.getUint32(e+16,true);
    for(let k=0,n=dv.getUint16(e+10,true);k<n;k++){
      if(dv.getUint32(p,true)!==0x02014b50)throw new Error('파일이 손상됐어요.');
      const flags=dv.getUint16(p+8,true),method=dv.getUint16(p+10,true),crc=dv.getUint32(p+16,true),csize=dv.getUint32(p+20,true),nl=dv.getUint16(p+28,true),xl=dv.getUint16(p+30,true),cl=dv.getUint16(p+32,true),off=dv.getUint32(p+42,true);
      files[td.decode(u8.subarray(p+46,p+46+nl))]={encrypted:!!(flags&1),method,crc,csize,off};p+=46+nl+xl+cl;
    }
    async function bytes(name,password=''){
      const f=files[name];if(!f)return null;
      if(f.method!==0&&f.method!==8)throw new Error('지원하지 않는 압축 방식이에요. 압축을 풀어서 엑셀 파일만 올려 주세요.');
      const s=f.off+30+dv.getUint16(f.off+26,true)+dv.getUint16(f.off+28,true);
      let data=u8.subarray(s,s+f.csize);
      if(f.encrypted){if(!password)throw new Error('비밀번호가 필요해요.');data=zipDecrypt(data,password);}
      let out=data;
      if(f.method===8){try{out=new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());}catch(x){throw new Error(f.encrypted?'비밀번호가 맞지 않아요.':'파일이 손상됐어요.');}}
      let c=0xffffffff;for(const b of out)c=crcByte(c,b);
      if(((c^0xffffffff)>>>0)!==f.crc)throw new Error(f.encrypted?'비밀번호가 맞지 않아요.':'파일이 손상됐어요.');
      return out;
    }
    return {names:Object.keys(files),encrypted:n=>!!files[n]?.encrypted,bytes,text:async(n,pw)=>{const b=await bytes(n,pw);return b&&new TextDecoder().decode(b);}};
  }
  const isZip=ab=>{const u=new Uint8Array(ab,0,Math.min(4,ab.byteLength));return u[0]===0x50&&u[1]===0x4b&&u[2]===3&&u[3]===4;};
  const ent=s=>s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi,(m,e)=>e[0]==='#'?String.fromCodePoint(e[1]==='x'||e[1]==='X'?parseInt(e.slice(2),16):parseInt(e.slice(1),10)):{lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"}[e.toLowerCase()]);
  const tText=x=>[...x.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m=>ent(m[1])).join('');
  const attr=(s,n)=>{const m=s.match(new RegExp('(?:^|\\s)'+n+'="([^"]*)"'));return m?ent(m[1]):'';};
  const colIdx=ref=>{let n=0;for(const ch of ref.replace(/\d+/g,''))n=n*26+ch.charCodeAt(0)-64;return n-1;};
  // 엑셀 파일 → {시트이름: [[칸,...],...]}
  async function readXlsx(ab){
    const z=openZip(ab);
    const wb=await z.text('xl/workbook.xml');if(!wb)throw new Error('엑셀 파일이 아니에요.');
    const rels=(await z.text('xl/_rels/workbook.xml.rels'))||'';
    const shared=[...((await z.text('xl/sharedStrings.xml'))||'').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m=>tText(m[1]));
    const target={};for(const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g))target[attr(m[1],'Id')]=attr(m[1],'Target');
    const book={};
    for(const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)){
      const name=attr(m[1],'name'),t=target[attr(m[1],'r:id')];if(!t)continue;
      const xml=await z.text(t.startsWith('/')?t.slice(1):'xl/'+t.replace(/^\.\//,''));if(!xml)continue;
      const rows=[];
      for(const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)){
        const row=[];
        for(const c of (r[1]||'').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
          const a=c[1],inner=c[2]||'',ref=attr(a,'r'),type=attr(a,'t'),v=(inner.match(/<v>([\s\S]*?)<\/v>/)||[])[1];
          let val=null;
          if(type==='s')val=v!=null?shared[Number(v)]??'':'';
          else if(type==='inlineStr')val=tText(inner);
          else if(type==='str'||type==='e')val=v!=null?ent(v):'';
          else if(type==='b')val=v==='1';
          else if(v!=null)val=Number(v);
          row[ref?colIdx(ref):row.length]=val;
        }
        rows.push(Array.from(row,x=>x??null));
      }
      book[name]=rows.filter(r=>r.some(x=>x!==null&&x!==''));
    }
    return book;
  }
  // 토스 매출리포트(엑셀)를 알아보고 하루 합계로 바꾼다. '결제 합계' 시트의 결제금액과 맞는지도 확인.
  function tossReport(book){
    const rows=book['결제 상세내역'];if(!rows||!rows.length)return null;
    const h=rows[0].map(x=>String(x??'').trim()),iD=h.indexOf('결제기준일자'),iA=h.indexOf('결제금액');
    if(iD<0||iA<0)return null;
    const r=toDays(rows.slice(1),{date:iD,sales:iA,refunds:''});
    const net=r.days.reduce((s,d)=>s+d.sales-d.refunds,0);
    let check=null;const t=book['결제 합계'];
    if(t){const hi=t.findIndex(x=>x.some(c=>String(c??'').trim()==='결제금액'));if(hi>=0){const ci=t[hi].findIndex(c=>String(c??'').trim()==='결제금액');const v=t.slice(hi+1).map(x=>x[ci]).find(x=>x!==null&&x!=='');if(v!=null){const a=signedAmount(String(v));check=a.negative?-a.amount:a.amount;}}}
    const basis=book['데이터 기준'];let period='';
    if(basis){const hi=basis.findIndex(x=>x.includes('시작일자'));const v=hi>=0&&basis.slice(hi+1).find(x=>looksDate(x[0]));if(v)period=`${v[0]} ~ ${v[1]||''}`.trim();}
    return {...r,net,check,matches:check===null?null:check===net,period};
  }
  // 엑셀 날짜 칸이 숫자(일련번호)로 올 때
  const serialDate=v=>{const n=Number(v);if(typeof v!=='number'||!(n>30000&&n<80000))return null;return new Date(Date.UTC(1899,11,30)+Math.floor(n)*864e5).toISOString().slice(0,10);};
  const api={openZip,isZip,readXlsx,tossReport,serialDate,looksDate,amount,signedAmount,validDate,parseDate,validate,summarize,dailyTotals,parseCSV,toDays,exportCSV,kinds,isDayRow,daysIn,lastDay};
  if(typeof module!=='undefined')module.exports=api;else root.FinanceCore=api;
})(typeof window!=='undefined'?window:globalThis);
