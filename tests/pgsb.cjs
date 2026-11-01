// 테스트 전용: supabase-js 쿼리 빌더 중 서버가 쓰는 부분만 흉내 내서 실제 Postgres(psql)로 실행한다.
// service_role 권한으로 실행해서 권한(GRANT) 설정도 함께 확인한다.
const {execFileSync}=require('node:child_process');
const SOCK=process.env.PGSOCK, PORT=process.env.PGPORT||'55432';
function psql(sql,role='service_role'){
  const out=execFileSync('psql',['-h',SOCK,'-p',PORT,'-U','postgres','-d','hongje','-At','-v','ON_ERROR_STOP=1','-q','-c',`set role ${role}; ${sql}`],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  return out.trim();
}
const id=c=>'"'+String(c).replace(/"/g,'""')+'"';
const lit=v=>v===null||v===undefined?'null':typeof v==='boolean'?String(v):typeof v==='number'?String(v):typeof v==='object'?`'${JSON.stringify(v).replace(/'/g,"''")}'::jsonb`:`'${String(v).replace(/'/g,"''")}'`;
// 숫자를 text 열에 넣어도, jsonb 열에 문자열을 넣어도 되게 열 타입에 맞춰 캐스팅
const typeCache={};
function colTypes(t){return typeCache[t]??=Object.fromEntries(psql(`select column_name||'|'||data_type from information_schema.columns where table_schema='public' and table_name='${t}'`,'postgres').split('\n').filter(Boolean).map(x=>x.split('|')));}
function val(t,c,v){const ty=colTypes(t)[c];if(v===null||v===undefined)return 'null';if(ty==='jsonb')return `'${JSON.stringify(v).replace(/'/g,"''")}'::jsonb`;if(typeof v==='object')return lit(JSON.stringify(v));return `${lit(String(v))}::${ty==='timestamp with time zone'?'timestamptz':ty}`;}
class Q{
  constructor(t){this.t=t;this.op='select';this.cols='*';this.w=[];this.ord=[];this.lim=null;this.single=false;}
  select(c='*'){if(this.op==='select')this.cols=c;else this.ret=true;return this;}
  insert(o){this.op='insert';this.rows=Array.isArray(o)?o:[o];return this;}
  upsert(o,opt={}){this.op='upsert';this.rows=Array.isArray(o)?o:[o];this.conf=opt.onConflict;this.ignore=opt.ignoreDuplicates;return this;}
  update(o){this.op='update';this.set=o;return this;}
  delete(){this.op='delete';return this;}
  eq(c,v){this.w.push(`${id(c)} = ${val(this.t,c,v)}`);return this;}
  gte(c,v){this.w.push(`${id(c)} >= ${val(this.t,c,v)}`);return this;}
  lte(c,v){this.w.push(`${id(c)} <= ${val(this.t,c,v)}`);return this;}
  lt(c,v){this.w.push(`${id(c)} < ${val(this.t,c,v)}`);return this;}
  in(c,arr){this.w.push(arr.length?`${id(c)} in (${arr.map(v=>val(this.t,c,v)).join(',')})`:'false');return this;}
  or(s){const parts=s.split(',').map(p=>{const [c,op,...rest]=p.split('.');const v=rest.join('.');return `${id(c)} ${({eq:'=',gte:'>='})[op]} ${val(this.t,c,v)}`;});this.w.push('('+parts.join(' or ')+')');return this;}
  order(c,o={}){this.ord.push(`${id(c)} ${o.ascending===false?'desc':'asc'}`);return this;}
  limit(n){this.lim=n;return this;}
  maybeSingle(){this.single=true;return this;}
  sql(){
    const where=this.w.length?' where '+this.w.join(' and '):'';
    const t='public.'+id(this.t);
    if(this.op==='select')return `select coalesce(json_agg(x),'[]') from (select ${this.cols==='*'?'*':this.cols.split(',').map(c=>id(c.trim())).join(',')} from ${t}${where}${this.ord.length?' order by '+this.ord.join(','):''}${this.lim?' limit '+this.lim:''}) x`;
    if(this.op==='insert'||this.op==='upsert'){
      const cols=Object.keys(this.rows[0]);
      if(this.rows.some(r=>Object.keys(r).join()!==cols.join()))throw new Error('PostgREST bulk insert needs same keys');
      let s=`insert into ${t} (${cols.map(id).join(',')}) values ${this.rows.map(r=>'('+cols.map(c=>val(this.t,c,r[c])).join(',')+')').join(',')}`;
      if(this.op==='upsert'){const pk=()=>psql(`select string_agg(a.attname, ',') from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid='public.${this.t}'::regclass and i.indisprimary`,'postgres');const k=(this.conf||pk()).split(',').map(x=>id(x.trim()));s+=this.ignore?` on conflict (${k}) do nothing`:` on conflict (${k}) do update set ${cols.map(c=>`${id(c)}=excluded.${id(c)}`).join(',')}`;}
      return `with r as (${s} returning 1) select '[]'`;
    }
    if(this.op==='update')return `with r as (update ${t} set ${Object.entries(this.set).map(([c,v])=>`${id(c)} = ${val(this.t,c,v)}`).join(',')}${where} returning 1) select '[]'`;
    if(this.op==='delete')return `with r as (delete from ${t}${where} returning 1) select '[]'`;
  }
  then(res,rej){
    let out;
    try{const d=JSON.parse(psql(this.sql()));
      if(this.single){if(d.length>1)out={data:null,error:{message:'multiple rows'}};else out={data:d[0]??null,error:null};}
      else out={data:d,error:null};
    }catch(e){out={data:null,error:{message:String(e.stderr||e.message).trim()}};}
    return Promise.resolve(out).then(res,rej);
  }
}
module.exports={createClient:()=>({from:t=>new Q(t)}),psql};
