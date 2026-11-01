// 카공족 홍제 운영실 — Supabase Edge Function (서버)
// 구글 Apps Script의 api()를 그대로 옮긴 것. 화면은 POST {action, p} 로 부른다.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Row = Record<string, any>;
class UserError extends Error {}
const fail = (m: string): never => { throw new UserError(m); };

/* ---------------- DB 도우미 ---------------- */
const S = (o: Row) => { const r: Row = {}; for (const k in o) r[k] = o[k] == null ? "" : String(o[k]); return r; };
async function q<T = Row[]>(p: PromiseLike<{ data: any; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}
const all = (t: string) => q(db.from(t).select("*").order("rid"));
const ins = (t: string, o: Row | Row[]) => q(db.from(t).insert(Array.isArray(o) ? o.map(S) : S(o)));
const upd = (t: string, rid: number, o: Row) => q(db.from(t).update(S(o)).eq("rid", rid));
const delRid = (t: string, rid: number) => q(db.from(t).delete().eq("rid", rid));
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

/* ---------------- 시간 ---------------- */
function now() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (k: string) => parts.find((x) => x.type === k)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hm: `${g("hour")}:${g("minute")}`, ym: `${g("year")}-${g("month")}`, iso: d.toISOString(), ms: d.getTime() };
}
function shiftMonth(ym: string, n: number) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const parseDays = (s: string) => String(s || "").replace(/[\s·,]/g, "").split("").map((c) => DOW.indexOf(c)).filter((x) => x >= 0);
const fmtDays = (a: number[]) => (a || []).map((d) => DOW[d]).join(",");
const num = (v: any) => Number(String(v ?? "").replace(/,/g, "")) || 0;

/* ---------------- 요청별 컨텍스트 (같은 요청 안에서 중복 조회 방지) ---------------- */
class Ctx {
  private _m?: Promise<Row[]>; private _s?: Promise<Row[]>;
  managers() { return this._m ??= all("managers"); }
  settings() { return this._s ??= all("settings"); }
  async setting(k: string) { const r = (await this.settings()).find((x) => x.key === k); return r ? r.value : ""; }
  async mgr(id: string) { return (await this.managers()).find((x) => x.id === id); }
  async ownerMid() { const o = (await this.managers()).find((m) => m.role === "점주"); return o ? o.id : ""; }
  async ownerPin() {
    const s = await this.setting("점주PIN"); if (s) return s;
    const o = (await this.managers()).find((x) => x.role === "점주"); return o && o.pin ? o.pin : "";
  }
}
async function setSetting(k: string, v: string) {
  const r = (await all("settings")).find((x) => x.key === k);
  if (r) await upd("settings", r.rid, { value: v }); else await ins("settings", { key: k, value: v, note: "" });
}

/* ---------------- PIN 확인 (+ 연속 실패 잠금) ---------------- */
const FAIL_MAX = 6, FAIL_LOCK_MS = 10 * 60 * 1000;
async function failGuard(key: string) {
  const r = await q<Row | null>(db.from("auth_fail").select("*").eq("k", key).maybeSingle());
  if (r && r.n >= FAIL_MAX && Date.now() - Date.parse(r.at) < FAIL_LOCK_MS) fail("PIN을 여러 번 틀려서 10분 동안 잠겼어요. 잠시 후 다시 시도해 주세요.");
}
async function failHit(key: string) {
  const r = await q<Row | null>(db.from("auth_fail").select("*").eq("k", key).maybeSingle());
  const stale = !r || Date.now() - Date.parse(r.at) >= FAIL_LOCK_MS;
  await q(db.from("auth_fail").upsert({ k: key, n: stale ? 1 : r!.n + 1, at: new Date().toISOString() }));
}
const failClear = (key: string) => q(db.from("auth_fail").delete().eq("k", key));

async function ownerOk(c: Ctx, pin: string) {
  const op = await c.ownerPin();
  if (!op) fail("점주 PIN이 아직 없어요.");
  await failGuard("owner");
  if (String(pin || "") !== op) { await failHit("owner"); fail("점주 PIN이 맞지 않아요."); }
  return true;
}
async function managerOk(c: Ctx, mid: string, pin: string) {
  const m = await c.mgr(mid);
  if (!m) fail("매니저를 찾을 수 없어요.");
  if (!m!.pin) fail("이 매니저의 PIN이 아직 없어요. 점주에게 요청해 주세요.");
  await failGuard("m:" + mid);
  if (String(pin || "") !== m!.pin) { await failHit("m:" + mid); fail("PIN이 맞지 않아요."); }
  return m!;
}
async function who(c: Ctx, p: Row) {
  if (p.ownerPin) { await ownerOk(c, p.ownerPin); return { owner: true, mid: p.mid || await c.ownerMid() }; }
  if (p.mid && p.pin) { await managerOk(c, p.mid, p.pin); return { owner: false, mid: p.mid as string }; }
  return fail("먼저 이름과 PIN으로 로그인해 주세요.");
}
async function isOwnerSafe(c: Ctx, pin: string) {
  if (!pin) return false;
  const op = await c.ownerPin();
  return !!op && String(pin) === op;
}

/* ---------------- 구글 Apps Script 중계 (카카오톡·메일 알림, 옛 드라이브 사진) ---------------- */
async function relay(c: Ctx, action: string, p: Row = {}) {
  const url = await c.setting("relay_url"), secret = await c.setting("relay_secret");
  if (!url || !secret) fail("알림 중계가 아직 설정되지 않았어요.");
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ secret, action, p }), redirect: "follow" });
  const txt = await res.text();
  let j: Row; try { j = JSON.parse(txt); } catch { throw new Error("알림 중계 응답 오류 (" + res.status + ")"); }
  if (!j.ok) fail(j.error || "알림 중계 오류");
  return j.result;
}
// 응답을 먼저 돌려주고 알림은 뒤에서 보낸다
function background(job: Promise<unknown>) {
  const safe = job.catch((e) => console.error("background", e));
  // @ts-ignore EdgeRuntime is provided by Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(safe);
}
const notifyOwner = (c: Ctx, text: string, subject?: string) => relay(c, "notify", { text, subject: subject || text.split("\n")[0] }).then((r) => !!(r && r.sent));

/* ---------------- 휴대폰 알림 (웹 푸시) ---------------- */
let vapidReady = false;
async function pushTo(c: Ctx, mids: string[], msg: { title: string; body: string; tag?: string; url?: string }) {
  const ids = [...new Set(mids.filter(Boolean))];
  if (!ids.length) return 0;
  if (!vapidReady) {
    const pub = await c.setting("vapid_public"), prv = await c.setting("vapid_private");
    if (!pub || !prv) return 0;
    webpush.setVapidDetails("https://qhrud9410.github.io/hongje-cagongjok/", pub, prv);
    vapidReady = true;
  }
  const subs = await q<Row[]>(db.from("push_subs").select("*").in("mid", ids));
  let ok = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ url: "./?tab=today", ...msg }), { TTL: 86400, urgency: "high" });
      ok++;
      await q(db.from("push_subs").update({ last_ok: new Date().toISOString() }).eq("endpoint", s.endpoint));
    } catch (e: any) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await q(db.from("push_subs").delete().eq("endpoint", s.endpoint));
      else console.error("push", e && (e.statusCode || e.message));
    }
  }));
  return ok;
}
function dayLabel(d: string) {
  const [y, m, dd] = d.split("-").map(Number);
  return `${m}/${dd}(${DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]})`;
}
const swapKind = (t: string) => (t === "eswap" ? "저녁 분리수거" : "오전 근무");
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const kstIso = (date: string, hm: string) => new Date(`${date}T${hm}:00+09:00`).toISOString();
function daysBetween(a: string, b: string) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5); }
// 출근 기록에 시각을 직접 써 넣기 (점주 수정·정정 승인 공용)
async function applyAttTimes(c: Ctx, date: string, mid: string, inHM: string, outHM: string, note: string, by: string) {
  if (inHM && !HM.test(inHM)) fail("출근 시각을 다시 확인해 주세요.");
  if (outHM && !HM.test(outHM)) fail("퇴근 시각을 다시 확인해 주세요.");
  if (inHM && outHM && outHM <= inHM) fail("퇴근 시각이 출근 시각보다 늦어야 해요.");
  const key = date + "__" + mid;
  const m = (await c.mgr(mid)) || { name: "" };
  const row: Row = { inHM: inHM || "", inAt: inHM ? kstIso(date, inHM) : "", outHM: outHM || "", outAt: outHM ? kstIso(date, outHM) : "", fixNote: note || "", fixedAt: new Date().toISOString(), fixedBy: by };
  const a = await q<Row | null>(db.from("attendance").select("rid").eq("key", key).maybeSingle());
  if (a) await upd("attendance", a.rid, row); else await ins("attendance", { key, date, mid, name: m.name, ...row });
}

/* ---------------- 사진 ---------------- */
async function savePhoto(dataUrl: string) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
  const mime = m ? m[1] : "image/jpeg", data = m ? m[2] : String(dataUrl).split(",").pop()!;
  if (data.length > 4_000_000) fail("사진이 너무 커요.");
  const id = "ph-" + crypto.randomUUID();
  await ins("photos", { id, mime, data });
  return id;
}
async function photoUrl(c: Ctx, id: string) {
  if (!id) fail("사진이 없어요.");
  if (id.startsWith("ph-")) {
    const r = await q<Row | null>(db.from("photos").select("mime,data").eq("id", id).maybeSingle());
    if (!r) fail("사진을 찾을 수 없어요.");
    return `data:${r!.mime};base64,${r!.data}`;
  }
  return await relay(c, "drivePhoto", { id }); // 이전 구글 드라이브 사진
}

/* ---------------- 게시판 ---------------- */
async function boardFor(c: Ctx, p: Row, isOwner: boolean) {
  let ok = isOwner;
  if (!ok && p.mid && p.pin) { const m = await c.mgr(p.mid); ok = !!(m && m.pin && String(p.pin) === m.pin); }
  if (!ok) return null;
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
  const rows = await q<Row[]>(db.from("posts").select("*").or(`pinned.eq.Y,status.eq.open,at.gte.${cutoff}`).order("at", { ascending: false }).limit(150));
  const posts = rows.map((x) => ({ id: x.id, kind: x.kind, mid: x.mid, name: x.name, text: x.text, hasPhoto: !!x.photo, at: x.at, status: x.status, pinned: x.pinned === "Y", doneBy: x.doneBy, doneAt: x.doneAt }));
  const ids = posts.map((x) => x.id);
  const comments = ids.length ? (await q<Row[]>(db.from("comments").select("*").in("postId", ids).order("rid"))).map((x) => ({ id: x.id, postId: x.postId, mid: x.mid, name: x.name, text: x.text, at: x.at })) : [];
  return { posts, comments };
}
async function postFind(id: string) {
  const x = await q<Row | null>(db.from("posts").select("*").eq("id", id).maybeSingle());
  if (!x) fail("글을 찾을 수 없어요. 이미 지워졌을 수 있어요.");
  return x!;
}

/* ---------------- 매출·비용 장부: 점주 전용, 외부 금융 키는 다루지 않음 ---------------- */
const FIN_KINDS = ["sale", "refund", "expense", "expenseRefund", "transfer", "review"];
const FIN_SOURCES = ["manual", "toss", "hyundai", "kb"];
const FIN_YM = /^20\d{2}-(0[1-9]|1[0-2])$/;
const DAY_PREFIX = "toss-";             // 토스 일 매출 줄은 id가 toss-day-YYYY-MM-DD / toss-refund-YYYY-MM-DD
function finMoney(x: any) {
  const n = typeof x === "string" ? Number(x.replace(/[,\s원₩]/g, "")) : x;
  if (!Number.isSafeInteger(n) || n < 0 || n > 10_000_000_000) fail("금액은 0 이상의 원 단위 정수로 입력해 주세요.");
  return n as number;
}
function finDate(s: any) {
  s = String(s || "");
  const d = new Date(s + "T00:00:00Z");
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(s) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail("날짜를 확인해 주세요.");
  return s as string;
}
function finTx(r: Row) {
  if (!r || typeof r !== "object") fail("거래 내용을 확인해 주세요.");
  const kind = String(r.kind), source = String(r.source || "manual");
  if (!FIN_KINDS.includes(kind)) fail("거래 구분을 확인해 주세요.");
  if (!FIN_SOURCES.includes(source)) fail("거래 출처를 확인해 주세요.");
  if (source === "kb" && !["transfer", "review"].includes(kind)) fail("국민은행 입출금은 손익 제외 항목으로 기록해 주세요.");
  const name = String(r.name ?? "").trim();
  if (!name || name.length > 200) fail("거래 내용을 적어 주세요.");
  const externalId = String(r.externalId ?? "").trim().slice(0, 200);
  if (externalId.startsWith(DAY_PREFIX)) fail("거래번호 형식을 확인해 주세요.");
  return { date: finDate(r.date), kind, source, name, amount: finMoney(r.amount), category: String(r.category || "기타").trim().slice(0, 40) || "기타", externalId, note: String(r.note ?? "").slice(0, 200) };
}
async function finExtFree(t: Row, selfId = "") {
  if (!t.externalId) return;
  const ex = await q<Row[]>(db.from("finance_tx").select("id").eq("source", t.source).eq("externalId", t.externalId));
  if (ex.some((x) => x.id !== selfId)) fail("같은 출처·거래번호가 이미 있어요. 취소는 다른 거래번호로 넣어 주세요.");
}
function finDay(d: Row) {
  if (!d || typeof d !== "object") fail("일 매출 형식을 확인해 주세요.");
  return { date: finDate(d.date), sales: finMoney(d.sales ?? 0), refunds: finMoney(d.refunds ?? 0) };
}
// 하루 합계: 매출 줄은 0원이어도 남겨서 '입력한 날'로 센다. 취소 줄은 0원이면 지운다.
async function finDayUpsert(days: { date: string; sales: number; refunds: number }[]) {
  const n = now();
  const ids = days.flatMap((d) => [DAY_PREFIX + "day-" + d.date, DAY_PREFIX + "refund-" + d.date]);
  const ex = await q<Row[]>(db.from("finance_tx").select("id,createdAt").in("id", ids));
  const created = new Map(ex.map((x) => [x.id, x.createdAt]));
  const up: Row[] = [], drop: string[] = [];
  for (const d of days) {
    const sid = DAY_PREFIX + "day-" + d.date, rid = DAY_PREFIX + "refund-" + d.date;
    up.push({ id: sid, date: d.date, kind: "sale", source: "toss", name: "토스 일 매출", amount: d.sales, category: "매출", externalId: sid, note: "", createdAt: created.get(sid) || n.iso, updatedAt: n.iso, by: "점주" });
    if (d.refunds > 0) up.push({ id: rid, date: d.date, kind: "refund", source: "toss", name: "토스 일 취소·환불", amount: d.refunds, category: "매출", externalId: rid, note: "", createdAt: created.get(rid) || n.iso, updatedAt: n.iso, by: "점주" });
    else if (created.has(rid)) drop.push(rid);
  }
  if (up.length) await q(db.from("finance_tx").upsert(up, { onConflict: "id" }));
  if (drop.length) await q(db.from("finance_tx").delete().in("id", drop));
}
function finMonthRow(x: Row) {
  return { fixed: Array.isArray(x.fixed) ? x.fixed : [], royaltyRate: Number(x.royaltyRate) || 0, feeRate: Number(x.feeRate) || 0, confirmed: !!x.confirmed, excludedPurchases: Array.isArray(x.excludedPurchases) ? x.excludedPurchases.map(String) : [], updatedAt: x.updatedAt || "" };
}
async function financeFor(month: string) {
  const [tx, mr] = await Promise.all([
    q<Row[]>(db.from("finance_tx").select("*").gte("date", month + "-01").lt("date", shiftMonth(month, 1) + "-01").order("date").order("rid")),
    q<Row[]>(db.from("finance_month").select("*")),
  ]);
  const months: Row = {};
  mr.forEach((x) => { months[x.ym] = finMonthRow(x); });
  return {
    month, months,
    tx: tx.map((x) => ({ id: x.id, date: x.date, kind: x.kind, source: x.source, name: x.name, amount: Number(x.amount), category: x.category, externalId: x.externalId, note: x.note, updatedAt: x.updatedAt })),
  };
}

/* ---------------- 요청 처리 ---------------- */
const ACTIONS: Record<string, (c: Ctx, p: Row) => Promise<any>> = {
  /* 매출·비용 — 모두 점주 PIN 확인 뒤 처리. 조회는 load 응답(점주일 때만)에 함께 담긴다. */
  async financeTxSave(c, p) {
    await ownerOk(c, p.ownerPin);
    const n = now();
    if (p.id) {
      if (String(p.id).startsWith(DAY_PREFIX)) fail("토스 일 매출은 '일 매출 입력'에서 고쳐 주세요.");
      const x = await q<Row | null>(db.from("finance_tx").select("*").eq("id", p.id).maybeSingle());
      if (!x) fail("거래를 찾을 수 없어요. 이미 지워졌을 수 있어요.");
      if (String(x!.updatedAt) !== String(p.orig ?? "")) fail("그새 다른 기기에서 이 거래가 바뀌었어요. 새로고침 후 다시 해 주세요.");
      if (p.remove) { await q(db.from("finance_tx").delete().eq("id", p.id)); return true; }
      const t = finTx(p.tx);
      await finExtFree(t, p.id);
      await q(db.from("finance_tx").update({ ...t, updatedAt: n.iso, by: "점주" }).eq("id", p.id));
      return true;
    }
    const t = finTx(p.tx);
    await finExtFree(t);
    await q(db.from("finance_tx").insert({ id: "t-" + crypto.randomUUID(), ...t, createdAt: n.iso, updatedAt: n.iso, by: "점주" }));
    return true;
  },
  async financeDaySave(c, p) {
    await ownerOk(c, p.ownerPin);
    const d = finDay(p);
    if (p.remove) { await q(db.from("finance_tx").delete().in("id", [DAY_PREFIX + "day-" + d.date, DAY_PREFIX + "refund-" + d.date])); return true; }
    await finDayUpsert([d]);
    return true;
  },
  async financeImport(c, p) {
    await ownerOk(c, p.ownerPin);
    const n = now();
    if (Array.isArray(p.days)) {
      if (!p.days.length || p.days.length > 400) fail("한 번에 400일까지 가져올 수 있어요.");
      const days = p.days.map(finDay);
      if (new Set(days.map((d: Row) => d.date)).size !== days.length) fail("같은 날짜가 두 번 들어 있어요.");
      await finDayUpsert(days);
      return { days: days.length };
    }
    if (!Array.isArray(p.rows) || !p.rows.length || p.rows.length > 2000) fail("한 번에 2,000건까지 가져올 수 있어요.");
    const source = String(p.source);
    if (!["hyundai", "kb", "manual"].includes(source)) fail("토스 매출은 하루 합계로 가져와 주세요.");
    // 가져온 거래는 '분류 대기'(손익 제외). 국민은행은 처음부터 '입출금(손익 제외)'.
    const rows = p.rows.map((r: Row) => finTx({ ...r, source, kind: source === "kb" ? "transfer" : "review", category: "기타" }));
    const ext = rows.filter((r: Row) => r.externalId).map((r: Row) => r.externalId);
    const have = new Set<string>();
    for (let i = 0; i < ext.length; i += 200) (await q<Row[]>(db.from("finance_tx").select("externalId").eq("source", source).in("externalId", ext.slice(i, i + 200)))).forEach((x) => have.add(x.externalId));
    // 거래번호가 없는 줄: 장부에 같은 날짜·내용·금액이 이미 '몇 건' 있는지 세서 그만큼만 건너뛴다.
    // (같은 파일을 다시 올려도 안 겹치고, 같은 금액 정당한 거래 두 건은 둘 다 들어간다)
    const similar = new Map<string, number>();
    const noId = rows.filter((r: Row) => !r.externalId);
    if (p.skipSimilar && noId.length) {
      const dates = noId.map((r: Row) => r.date).sort();
      const ex = await q<Row[]>(db.from("finance_tx").select("date,name,amount").eq("source", source).gte("date", dates[0]).lte("date", dates[dates.length - 1]));
      ex.forEach((x) => { const k = JSON.stringify([x.date, x.name, Number(x.amount)]); similar.set(k, (similar.get(k) || 0) + 1); });
    }
    const add: Row[] = [];
    let skipped = 0;
    for (const r of rows) {
      if (r.externalId && have.has(r.externalId)) { skipped++; continue; }
      if (!r.externalId && similar.size) {
        const k = JSON.stringify([r.date, r.name, r.amount]), left = similar.get(k) || 0;
        if (left > 0) { similar.set(k, left - 1); skipped++; continue; }
      }
      if (r.externalId) have.add(r.externalId);
      add.push({ id: "t-" + crypto.randomUUID(), ...r, createdAt: n.iso, updatedAt: n.iso, by: "점주" });
    }
    for (let i = 0; i < add.length; i += 500) await q(db.from("finance_tx").insert(add.slice(i, i + 500)));
    return { added: add.length, skipped };
  },
  async financeClassify(c, p) {
    await ownerOk(c, p.ownerPin);
    if (!Array.isArray(p.items) || !p.items.length || p.items.length > 2000) fail("분류할 거래를 골라 주세요.");
    const groups = new Map<string, string[]>();
    for (const it of p.items) {
      const id = String(it?.id || ""), kind = String(it?.kind), category = String(it?.category || "기타").trim().slice(0, 40) || "기타";
      if (!id || id.startsWith(DAY_PREFIX)) fail("분류할 수 없는 거래가 있어요.");
      if (!FIN_KINDS.includes(kind)) fail("거래 구분을 확인해 주세요.");
      const k = JSON.stringify([kind, category]);
      groups.set(k, [...(groups.get(k) || []), id]);
    }
    const ids = [...groups.values()].flat();
    const ex = await q<Row[]>(db.from("finance_tx").select("id,source").in("id", ids));
    if (ex.length !== new Set(ids).size) fail("그새 지워진 거래가 있어요. 새로고침 후 다시 해 주세요.");
    const kbIds = new Set(ex.filter((x) => x.source === "kb").map((x) => x.id));
    for (const [k, list] of groups) {
      const [kind] = JSON.parse(k);
      if (!["transfer", "review"].includes(kind) && list.some((id) => kbIds.has(id))) fail("국민은행 입출금은 매출·비용으로 분류할 수 없어요.");
    }
    const iso = now().iso;
    for (const [k, list] of groups) {
      const [kind, category] = JSON.parse(k);
      await q(db.from("finance_tx").update({ kind, category, updatedAt: iso, by: "점주" }).in("id", list));
    }
    return { updated: ids.length };
  },
  async financeMonthSave(c, p) {
    await ownerOk(c, p.ownerPin);
    const ym = String(p.ym || "");
    if (ym !== "default" && !FIN_YM.test(ym)) fail("월을 확인해 주세요.");
    const ex = await q<Row | null>(db.from("finance_month").select("*").eq("ym", ym).maybeSingle());
    const dflt = ex ? null : await q<Row | null>(db.from("finance_month").select("*").eq("ym", "default").maybeSingle());
    const base = finMonthRow(ex || dflt || {});
    if (!ex) { base.confirmed = false; base.excludedPurchases = []; }
    const row: Row = { ym, fixed: base.fixed, royaltyRate: base.royaltyRate, feeRate: base.feeRate, confirmed: base.confirmed, excludedPurchases: base.excludedPurchases, updatedAt: now().iso };
    if ("fixed" in p) {
      if (!Array.isArray(p.fixed) || p.fixed.length > 50) fail("고정비 항목은 50개까지 넣을 수 있어요.");
      row.fixed = p.fixed.map((r: Row) => { const name = String(r?.name ?? "").trim(); if (!name || name.length > 40) fail("고정비 이름을 확인해 주세요."); return { name, amount: finMoney(r.amount) }; });
    }
    if ("royaltyRate" in p) {
      const v = Number(p.royaltyRate);
      if (!Number.isFinite(v) || v < 0 || v > 100) fail("로열티는 0~100% 범위로 넣어 주세요.");
      row.royaltyRate = v;
    }
    if ("feeRate" in p) {
      const v = Number(p.feeRate);
      if (!Number.isFinite(v) || v < 0 || v > 100) fail("카드 수수료율은 0~100% 범위로 넣어 주세요.");
      row.feeRate = v;
    }
    if ("confirmed" in p) row.confirmed = !!p.confirmed;
    if ("purchase" in p) {   // 비품 주문 하나만 넣고 빼서, 다른 기기 변경을 덮어쓰지 않는다
      const id = String(p.purchase);
      const set = new Set(row.excludedPurchases);
      p.exclude ? set.add(id) : set.delete(id);
      if (set.size > 2000) fail("제외 목록이 너무 많아요.");
      row.excludedPurchases = [...set];
    }
    await q(db.from("finance_month").upsert(row, { onConflict: "ym" }));
    if (p.alsoDefault && ym !== "default") await q(db.from("finance_month").upsert({ ym: "default", fixed: row.fixed, royaltyRate: row.royaltyRate, feeRate: row.feeRate, confirmed: false, excludedPurchases: [], updatedAt: row.updatedAt }, { onConflict: "ym" }));
    return true;
  },
  async verify(c, p) {
    if (p.ownerPin) { await ownerOk(c, p.ownerPin); await failClear("owner"); return { owner: true, mid: await c.ownerMid() }; }
    await managerOk(c, p.mid, p.pin); await failClear("m:" + p.mid); return { owner: false, mid: p.mid };
  },

  /* 점주 PIN 바꾸기 — 지금 PIN을 확인한 뒤 새 PIN으로. 다른 기기는 다음 새로고침 때 로그아웃된다. */
  async ownerPinChange(c, p) {
    await ownerOk(c, p.ownerPin);
    const next = String(p.newPin ?? "").trim();
    if (!/^\d{4,8}$/.test(next)) fail("새 PIN은 숫자 4~8자리로 넣어 주세요.");
    if (next === String(p.ownerPin)) fail("지금 PIN과 다른 번호로 정해 주세요.");
    const mgrs = await c.managers();
    if (mgrs.some((m) => m.role !== "점주" && m.pin && String(m.pin) === next)) fail("매니저 PIN과 같은 번호는 쓸 수 없어요.");
    const owner = mgrs.find((m) => m.role === "점주");
    if (!owner) fail("점주 정보를 찾을 수 없어요.");
    await upd("managers", owner!.rid, { pin: next });
    // 예전 방식(설정의 점주PIN)이 남아 있으면 같이 바꾼다 — 그쪽이 먼저 쓰이기 때문
    if (await c.setting("점주PIN")) await setSetting("점주PIN", next);
    await failClear("owner");
    return true;
  },

  async load(c, p) {
    const n = now();
    const month = p.month || n.ym;
    const isOwner = await isOwnerSafe(c, p.ownerPin);
    const finMonth = isOwner && FIN_YM.test(String(p.finMonth || "")) ? String(p.finMonth) : month;
    const months = [shiftMonth(month, -1), month, shiftMonth(month, 1), n.ym, shiftMonth(n.ym, 1), finMonth];
    const minM = months.slice().sort()[0] + "-01";
    const inRange = (d: string) => months.some((m) => String(d).startsWith(m));
    const [mgrs, attR, chkR, eveR, clR, supR, evR, chR, rwR, puR, finance, board, settings] = await Promise.all([
      c.managers(),
      q<Row[]>(db.from("attendance").select("*").gte("date", minM)),
      q<Row[]>(db.from("checks").select("*").gte("date", minM)),
      q<Row[]>(db.from("evening").select("*").gte("date", minM)),
      all("checklist"), all("supplies"), all("events"), all("changes"),
      isOwner ? all("rewards") : Promise.resolve([]),
      isOwner ? all("purchases") : Promise.resolve([]),
      isOwner ? financeFor(finMonth) : Promise.resolve(null),
      boardFor(c, p, isOwner),
      c.settings(),
    ]);
    let meOk = false;
    if (!isOwner && p.mid && p.pin) { const m = await c.mgr(p.mid); meOk = !!(m && m.pin && String(p.pin) === m.pin); }
    const fixR = isOwner || meOk ? await q<Row[]>(db.from("att_fixes").select("*").gte("date", minM).order("rid")) : [];
    const attFixes: Row = {};
    fixR.filter((f) => isOwner || f.mid === p.mid).forEach((f) => { attFixes[f.id] = { date: f.date, mid: f.mid, inHM: f.inHM, outHM: f.outHM, note: f.note, state: f.state, createdAt: f.createdAt }; });
    const managers = mgrs.map((m) => ({
      id: m.id, name: m.name, role: m.role === "점주" ? "owner" : "", days: parseDays(m.days),
      startDate: m.startDate, wage: num(m.wage), active: m.active !== "N",
      order: num(m.order), hasPin: !!m.pin, duty: m.duty === "저녁 분리수거" ? "evening" : "morning", payTo: m.payTo || "",
    }));
    const att: Row = {};
    attR.forEach((a) => { if (inRange(a.date)) att[a.date + "__" + a.mid] = { date: a.date, mid: a.mid, inHM: a.inHM, inAt: a.inAt, outHM: a.outHM, outAt: a.outAt, hasPhoto: !!a.photo, memo: a.memo, statusOverride: a.override, fixNote: a.fixNote || "", fixedAt: a.fixedAt || "", fixedBy: a.fixedBy || "" }; });
    const checks: Row = {};
    chkR.forEach((x) => { if (inRange(x.date)) (checks[x.date] ??= { items: {} }).items[x.itemId] = { at: x.at, hm: x.hm, by: x.by }; });
    const evening: Row = {};
    eveR.forEach((e) => { if (inRange(e.date)) evening[e.date + "__" + e.mid] = { date: e.date, mid: e.mid, hm: e.hm, by: e.by || e.mid, byName: e.byName || e.name }; });
    const sections: Row[] = [];
    clR.forEach((r) => {
      let s = sections.find((x) => x.title === r.section);
      if (!s) { s = { title: r.section, items: [] }; sections.push(s); }
      const days = parseDays(r.days);
      if (!days.length && !r.link) s.items.push(r.text);
      else { const o: Row = { text: r.text }; if (days.length) o.days = days; if (r.link) { o.link = r.link; if (r.linkLabel) o.linkLabel = r.linkLabel; } s.items.push(o); }
    });
    const supplies: Row = {};
    supR.forEach((s) => { supplies[s.id] = { name: s.name, cat: s.cat, status: s.status || "ok", price: num(s.price), unit: s.unit, link: s.link, vendor: s.vendor, requestedBy: s.requestedBy, requestedAt: s.requestedAt, note: s.note, lastBought: s.lastBought }; });
    const events: Row = {};
    evR.forEach((e) => { events[e.id] = { date: e.date, title: e.title, time: e.time }; });
    const changes: Row = {};
    chR.forEach((x) => { changes[x.id] = { date: x.date, type: x.type, fromMid: x.fromMid, toMid: x.toMid, note: x.note, state: x.state, requestedBy: x.requestedBy }; });
    const rewards: Row = {};
    rwR.forEach((r) => { rewards[r.ym] = { amount: num(r.amount) }; });
    const purchases = puR.map((x) => ({ row: x.rid, date: x.date, sid: x.sid, name: x.name, price: num(x.price) }));
    const st = (k: string) => (settings.find((x) => x.key === k) || {}).value || "";
    let ni: Row = {}; try { ni = JSON.parse(st("notify_cache") || "{}"); } catch { /* */ }
    return {
      now: n, isOwner, managers, att, checks, evening, board, checklist: { sections, source: st("체크리스트_출처") },
      supplies, events, changes, rewards, purchases, attFixes, finance,
      ownerPinSet: !!(await c.ownerPin()), kakao: !!ni.kakao,
      kakaoList: isOwner ? ni.kakaoList || [] : [], notifyEmails: isOwner ? ni.notifyEmails || "" : "",
      kakaoKey: isOwner ? !!ni.kakaoKey : false, kakaoSecret: isOwner ? !!ni.kakaoSecret : false, kakaoRedirect: isOwner ? ni.kakaoRedirect || "" : "",
    };
  },

  async clockIn(c, p) {
    const w = await who(c, p);
    const mid = w.owner ? (p.mid || w.mid) : w.mid;
    if (!p.photo) fail("매장 사진이 필요해요.");
    const n = now();
    if (p.shotAt && n.ms - Number(p.shotAt) > 15 * 60 * 1000) fail("방금 찍은 사진이 아니에요. 다시 촬영해 주세요.");
    const key = n.date + "__" + mid;
    const ex = await q<Row | null>(db.from("attendance").select("*").eq("key", key).maybeSingle());
    if (ex && ex.inHM) fail("오늘 출근 기록이 이미 있어요.");
    const m = (await c.mgr(mid)) || { name: "" };
    const photo = await savePhoto(p.photo);
    const row = { key, date: n.date, mid, name: m.name, inHM: n.hm, inAt: n.iso, photo };
    if (ex) await upd("attendance", ex.rid, row); else await ins("attendance", row);
    return { inHM: n.hm };
  },

  async clockOut(c, p) {
    const w = await who(c, p);
    const mid = w.owner ? (p.mid || w.mid) : w.mid;
    const n = now();
    const ex = await q<Row | null>(db.from("attendance").select("*").eq("key", n.date + "__" + mid).maybeSingle());
    if (!ex || !ex.inHM) fail("오늘 출근 기록이 없어요.");
    await upd("attendance", ex!.rid, { outHM: n.hm, outAt: n.iso, memo: p.memo || "" });
    return { outHM: n.hm };
  },

  async photo(c, p) {
    await who(c, p);
    const a = await q<Row | null>(db.from("attendance").select("photo").eq("key", p.key).maybeSingle());
    if (!a || !a.photo) fail("사진이 없어요.");
    return await photoUrl(c, a!.photo);
  },

  async toggleCheck(c, p) {
    const w = await who(c, p);
    const n = now();
    if (!w.owner && p.date !== n.date) fail("오늘 체크리스트만 바꿀 수 있어요.");
    if (p.on) await q(db.from("checks").upsert(S({ date: p.date, itemId: p.itemId, text: p.text, hm: n.hm, at: n.iso, by: w.mid }), { onConflict: "date,itemId", ignoreDuplicates: true }));
    else await q(db.from("checks").delete().eq("date", p.date).eq("itemId", p.itemId));
    return true;
  },

  async eveningToggle(c, p) {
    const w = await who(c, p);
    const n = now();
    const date = p.date || n.date;
    if (!w.owner && date !== n.date) fail("오늘 기록만 바꿀 수 있어요.");
    let mid = w.owner && p.target ? p.target : w.mid;
    let subFor = false;
    if (!w.owner && p.target && p.target !== w.mid) {
      const ok = await q<Row[]>(db.from("changes").select("rid").eq("type", "eswap").eq("state", "approved").eq("date", date).eq("fromMid", p.target).eq("toMid", w.mid));
      if (!ok.length) fail("승인된 분리수거 대타가 아니에요.");
      mid = p.target; subFor = true;
    }
    const m = (await c.mgr(mid)) || { name: "" };
    const rows = await q<Row[]>(db.from("evening").select("*").eq("date", date).eq("mid", mid));
    if (p.on) {
      const byId = subFor ? w.mid : (w.owner && p.byMid) ? p.byMid : (w.owner && p.cover ? (await c.ownerMid() || w.mid) : mid);
      const by = (await c.mgr(byId)) || { name: "" };
      await q(db.from("evening").upsert(S({ date, mid, name: m.name, hm: n.hm, at: n.iso, by: byId, byName: by.name }), { onConflict: "date,mid" }));
    } else {
      const mine = w.owner ? rows : rows.filter((r) => !r.by || r.by === w.mid);
      if (rows.length && !mine.length) fail("다른 사람이 대신 처리한 기록은 그 사람이나 점주만 취소할 수 있어요.");
      for (const r of mine) await delRid("evening", r.rid);
    }
    return true;
  },

  /* 알림 설정 — 구글 쪽에 그대로 맡김 */
  async notifyInfo(c, p) { await ownerOk(c, p.ownerPin); const r = await relay(c, "notifyInfo"); await setSetting("notify_cache", JSON.stringify(r)); return r; },
  async kakaoSaveKeys(c, p) { await ownerOk(c, p.ownerPin); const r = await relay(c, "kakaoSaveKeys", p); await refreshNotifyCache(c); return r; },
  async kakaoAuthUrl(c, p) { await ownerOk(c, p.ownerPin); return await relay(c, "kakaoAuthUrl", p); },
  async kakaoTest(c, p) { await ownerOk(c, p.ownerPin); return await relay(c, "kakaoTest", p); },
  async kakaoRemove(c, p) { await ownerOk(c, p.ownerPin); const r = await relay(c, "kakaoRemove", p); await refreshNotifyCache(c); return r; },
  async notifySaveEmails(c, p) { await ownerOk(c, p.ownerPin); const r = await relay(c, "notifySaveEmails", p); await refreshNotifyCache(c); return r; },

  async postSave(c, p) {
    const w = await who(c, p);
    const kind = ["notice", "issue", "talk"].includes(p.kind) ? p.kind : "talk";
    if (kind === "notice" && !w.owner) fail("공지는 점주만 올릴 수 있어요.");
    const text = String(p.text || "").trim().slice(0, 2000);
    if (!text && !p.photo) fail("내용을 적어 주세요.");
    const n = now();
    const m = (await c.mgr(w.mid)) || { name: w.owner ? "점주" : "" };
    const photo = p.photo ? await savePhoto(p.photo) : "";
    const id = uid("p");
    await ins("posts", { id, kind, mid: w.mid, name: m.name, text, photo, at: n.iso, status: kind === "issue" ? "open" : "", pinned: kind === "notice" ? "Y" : "" });
    if (kind === "issue" && !w.owner) background(notifyOwner(c, `[카공족 홍제] 새 이슈 · ${m.name}\n${text.slice(0, 300)}${photo ? "\n(사진 첨부)" : ""}`, `[카공족 홍제] 새 이슈 · ${m.name}`));
    return { id };
  },
  async postStatus(c, p) {
    const w = await who(c, p);
    const x = await postFind(p.id);
    if (x.kind !== "issue") fail("이슈 글만 상태를 바꿀 수 있어요.");
    const m = (await c.mgr(w.mid)) || { name: "" };
    await upd("posts", x.rid, p.done ? { status: "done", doneBy: m.name, doneAt: now().iso } : { status: "open", doneBy: "", doneAt: "" });
    return true;
  },
  async postPin(c, p) { await ownerOk(c, p.ownerPin); const x = await postFind(p.id); await upd("posts", x.rid, { pinned: p.on ? "Y" : "" }); return true; },
  async postDelete(c, p) {
    const w = await who(c, p);
    const x = await postFind(p.id);
    if (!w.owner && x.mid !== w.mid) fail("내가 쓴 글만 지울 수 있어요.");
    await q(db.from("comments").delete().eq("postId", x.id));
    await delRid("posts", x.rid);
    if (String(x.photo).startsWith("ph-")) await q(db.from("photos").delete().eq("id", x.photo));
    return true;
  },
  async postPhoto(c, p) { await who(c, p); const x = await postFind(p.id); return await photoUrl(c, x.photo); },
  async commentAdd(c, p) {
    const w = await who(c, p);
    const text = String(p.text || "").trim().slice(0, 1000);
    if (!text) fail("댓글 내용을 적어 주세요.");
    const x = await postFind(p.postId);
    const m = (await c.mgr(w.mid)) || { name: "" };
    await ins("comments", { id: uid("c"), postId: x.id, mid: w.mid, name: m.name, text, at: now().iso });
    return true;
  },
  async commentDelete(c, p) {
    const w = await who(c, p);
    const x = await q<Row | null>(db.from("comments").select("*").eq("id", p.id).maybeSingle());
    if (!x) return true;
    if (!w.owner && x.mid !== w.mid) fail("내가 쓴 댓글만 지울 수 있어요.");
    await delRid("comments", x.rid);
    return true;
  },

  async supplyLow(c, p) {
    const w = await who(c, p);
    const n = now();
    const s = await q<Row | null>(db.from("supplies").select("*").eq("id", p.id).maybeSingle());
    if (!s) fail("비품을 찾을 수 없어요.");
    await upd("supplies", s!.rid, { status: "low", requestedBy: w.mid, requestedAt: n.iso, note: p.note || "", notifiedAt: "" });
    const m = await c.mgr(w.mid);
    background(notifyOwner(c, `[카공족 홍제] 비품 부족: ${s!.name}\n요청: ${m ? m.name : ""} · ${n.hm}${p.note ? "\n메모: " + p.note : ""}`, `[카공족 홍제] 비품 부족: ${s!.name}`)
      .then((sent) => sent ? upd("supplies", s!.rid, { notifiedAt: n.iso }) : null));
    return { notified: true };
  },
  async supplyStatus(c, p) {
    const w = await who(c, p);
    if (p.status === "ordered" && !w.owner) fail("주문 기록은 점주만 할 수 있어요.");
    const n = now();
    const s = await q<Row | null>(db.from("supplies").select("*").eq("id", p.id).maybeSingle());
    if (!s) fail("비품을 찾을 수 없어요.");
    const patch: Row = { status: p.status };
    if (p.status === "ok") Object.assign(patch, { requestedBy: "", requestedAt: "", note: "", notifiedAt: "" });
    if (p.status === "ordered") { patch.lastBought = n.date; await ins("purchases", { date: n.date, sid: s!.id, name: s!.name, price: Number(p.price) || 0 }); }
    await upd("supplies", s!.rid, patch);
    return true;
  },
  async purchaseSave(c, p) {
    await ownerOk(c, p.ownerPin);
    const price = num(p.price);
    const valid = () => { if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || "") || !String(p.name || "").trim()) fail("날짜와 비품 이름을 입력해 주세요."); };
    if (p.row) {
      const x = await q<Row | null>(db.from("purchases").select("*").eq("rid", Number(p.row)).maybeSingle());
      const o = p.orig || {};
      const same = x && String(x.date) === String(o.date) && String(x.name) === String(o.name) && num(x.price) === (Number(o.price) || 0);
      if (!same) fail("그새 기록이 바뀌었어요. 새로고침 후 다시 해 주세요.");
      if (p.remove) { await delRid("purchases", x!.rid); return true; }
      valid();
      await upd("purchases", x!.rid, { date: p.date, name: String(p.name).trim(), price });
      return true;
    }
    valid();
    await ins("purchases", { date: p.date, sid: p.sid || "", name: String(p.name).trim(), price });
    return true;
  },
  async supplySave(c, p) {
    await ownerOk(c, p.ownerPin);
    const d: Row = {};
    for (const k of ["name", "cat", "status", "price", "unit", "link", "vendor", "note", "lastBought"]) if (p.data && k in p.data) d[k] = p.data[k];
    if (p.id) {
      const s = await q<Row | null>(db.from("supplies").select("rid").eq("id", p.id).maybeSingle());
      if (!s) fail("비품을 찾을 수 없어요.");
      if (p.remove) { await delRid("supplies", s!.rid); return true; }
      await upd("supplies", s!.rid, d);
    } else await ins("supplies", { id: uid("s"), status: "ok", ...d });
    return true;
  },

  async changeRequest(c, p) {
    const w = await who(c, p);
    const n = now();
    const type = p.type === "eswap" ? "eswap" : "swap";
    const fromMid = w.owner ? (p.fromMid || "") : w.mid;
    if (!w.owner && p.fromMid && p.fromMid !== w.mid) fail("본인 일정만 대타를 부탁할 수 있어요.");
    if (!p.toMid) fail("대신할 사람을 골라 주세요.");
    if (p.toMid === fromMid) fail("다른 사람을 골라 주세요.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || "")) fail("날짜가 올바르지 않아요.");
    if (!w.owner && p.date < n.date) fail("지난 날짜는 대타를 부탁할 수 없어요.");
    const same = await q<Row[]>(db.from("changes").select("state").eq("date", p.date).eq("type", type).eq("fromMid", fromMid).in("state", ["requested", "approved"]));
    if (same.some((x) => x.state === "requested")) fail("이 날짜에 이미 답을 기다리는 요청이 있어요.");
    if (same.some((x) => x.state === "approved")) fail("이 날짜에 이미 확정된 대타가 있어요. 먼저 취소해 주세요.");
    const direct = w.owner && !p.ask;
    await ins("changes", { id: uid("c"), date: p.date, type, fromMid, toMid: p.toMid, note: p.note || "", state: direct ? "approved" : "requested", requestedBy: w.owner ? "owner" : w.mid, createdAt: n.iso, decidedAt: direct ? n.iso : "" });
    const fromName = ((await c.mgr(fromMid)) || { name: "" }).name;
    if (direct) background(pushTo(c, [fromMid, p.toMid], { title: "📅 근무가 바뀌었어요", body: `${dayLabel(p.date)} ${swapKind(type)}: ${fromName} → ${((await c.mgr(p.toMid)) || { name: "" }).name} (점주 지정)`, tag: "swap" }));
    else background(pushTo(c, [p.toMid], { title: "🙋 대타 요청이 왔어요", body: `${dayLabel(p.date)} ${swapKind(type)} — ${fromName}님이 부탁했어요.${p.note ? " 사유: " + p.note : ""}\n눌러서 수락하거나 거절해 주세요.`, tag: "swap" }));
    return true;
  },
  async changeRespond(c, p) {
    const w = await who(c, p);
    const x = await q<Row | null>(db.from("changes").select("*").eq("id", p.id).maybeSingle());
    if (!x) fail("요청을 찾을 수 없어요.");
    if (x!.state !== "requested") fail(x!.state === "canceled" ? "이미 취소된 요청이에요." : "이미 답한 요청이에요.");
    if (!w.owner && x!.toMid !== w.mid) fail("나에게 온 요청만 답할 수 있어요.");
    const accept = !!p.accept;
    await upd("changes", x!.rid, { state: accept ? "approved" : "rejected", decidedAt: now().iso });
    const nm = async (id: string) => ((await c.mgr(id)) || { name: "" }).name;
    const toName = await nm(x!.toMid), fromName = await nm(x!.fromMid);
    const asker = x!.requestedBy && x!.requestedBy !== "owner" ? x!.requestedBy : x!.fromMid;
    background(pushTo(c, [asker, x!.fromMid], accept
      ? { title: "✅ 대타가 확정됐어요", body: `${dayLabel(x!.date)} ${swapKind(x!.type)} — ${toName}님이 수락했어요.`, tag: "swap" }
      : { title: "🙅 대타 요청이 거절됐어요", body: `${dayLabel(x!.date)} ${swapKind(x!.type)} — ${toName}님이 어렵대요. 다른 분께 부탁해 주세요.`, tag: "swap" }));
    if (accept) background(notifyOwner(c, `[카공족 홍제] 대타 확정\n${dayLabel(x!.date)} ${swapKind(x!.type)} · ${fromName} → ${toName}${x!.note ? "\n사유: " + x!.note : ""}`, `[카공족 홍제] 대타 확정 · ${dayLabel(x!.date)}`));
    return true;
  },
  async changeCancel(c, p) {
    const w = await who(c, p);
    const x = await q<Row | null>(db.from("changes").select("*").eq("id", p.id).maybeSingle());
    if (!x) fail("요청을 찾을 수 없어요.");
    const n = now();
    if (!["requested", "approved"].includes(x!.state)) fail("이미 끝난 요청이에요.");
    if (!w.owner && x!.date < n.date) fail("지난 날짜는 취소할 수 없어요.");
    const mine = x!.fromMid === w.mid || x!.requestedBy === w.mid;
    if (!w.owner && !(mine || (x!.state === "approved" && x!.toMid === w.mid))) fail("내 대타만 취소할 수 있어요.");
    await upd("changes", x!.rid, { state: "canceled", decidedAt: n.iso });
    const nm = async (id: string) => ((await c.mgr(id)) || { name: "" }).name;
    const byName = await nm(w.mid);
    const others = [x!.fromMid, x!.toMid].filter((id) => id !== w.mid);
    background(pushTo(c, others, { title: x!.state === "approved" ? "↩️ 대타가 취소됐어요" : "↩️ 대타 요청이 취소됐어요", body: `${dayLabel(x!.date)} ${swapKind(x!.type)} — ${byName}님이 취소했어요.${x!.state === "approved" ? " 원래 근무로 돌아가요." : ""}`, tag: "swap" }));
    if (x!.state === "approved") background(notifyOwner(c, `[카공족 홍제] 대타 취소\n${dayLabel(x!.date)} ${swapKind(x!.type)} · ${await nm(x!.fromMid)} → ${await nm(x!.toMid)}\n취소한 사람: ${byName}`, `[카공족 홍제] 대타 취소 · ${dayLabel(x!.date)}`));
    return true;
  },
  async changeDecide(c, p) {
    await ownerOk(c, p.ownerPin);
    const x = await q<Row | null>(db.from("changes").select("*").eq("id", p.id).maybeSingle());
    if (!x) fail("요청을 찾을 수 없어요.");
    await upd("changes", x!.rid, { state: p.approve ? "approved" : "rejected", decidedAt: now().iso });
    background(pushTo(c, [x!.fromMid, x!.toMid], { title: p.approve ? "✅ 점주가 대타를 확정했어요" : "🙅 점주가 대타 요청을 거절했어요", body: `${dayLabel(x!.date)} ${swapKind(x!.type)}`, tag: "swap" }));
    return true;
  },

  /* 출근 기록 수정 — 점주는 모두, 매니저는 자기 기록(2주 이내, 사유 필수) */
  async attEdit(c, p) {
    const w = await who(c, p);
    const n = now();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || "") || !p.mid) fail("날짜와 매니저를 골라 주세요.");
    if (p.date > n.date) fail("아직 오지 않은 날은 고칠 수 없어요.");
    const m = await c.mgr(p.mid);
    if (!m) fail("매니저를 찾을 수 없어요.");
    const note = String(p.note || "").trim().slice(0, 200);
    if (!w.owner) {
      if (p.mid !== w.mid) fail("내 출근 기록만 고칠 수 있어요.");
      if (daysBetween(p.date, n.date) > 14) fail("2주가 지난 기록은 점주에게 말해 주세요.");
      if (!note) fail("왜 고치는지 사유를 적어 주세요.");
    }
    const inHM = String(p.inHM || ""), outHM = String(p.outHM || "");
    await applyAttTimes(c, p.date, p.mid, inHM, outHM, note, w.owner ? "점주" : m!.name);
    await q(db.from("att_fixes").update({ state: w.owner ? "approved" : "canceled", decidedAt: n.iso }).eq("date", p.date).eq("mid", p.mid).eq("state", "requested"));
    const times = `출근 ${inHM || "–"} / 퇴근 ${outHM || "–"}`;
    if (w.owner) background(pushTo(c, [p.mid], { title: "🕘 출근 기록이 수정됐어요", body: `${dayLabel(p.date)} · ${times} (점주 수정)`, tag: "att" }));
    else {
      const text = `${dayLabel(p.date)} · ${m!.name} (본인 수정)\n${times}\n사유: ${note}`;
      background(pushTo(c, [await c.ownerMid()], { title: "🕘 매니저가 출근 기록을 고쳤어요", body: text.replace(/\n/g, " · "), tag: "att" }));
      background(notifyOwner(c, `[카공족 홍제] 출근 기록 수정\n${text}`, `[카공족 홍제] 출근 기록 수정 · ${m!.name}`));
    }
    return true;
  },
  /* 출근 기록 정정 요청 (매니저) */
  async attFixRequest(c, p) {
    const w = await who(c, p);
    const n = now();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || "")) fail("날짜가 올바르지 않아요.");
    if (p.date > n.date) fail("아직 오지 않은 날은 정정할 수 없어요.");
    if (daysBetween(p.date, n.date) > 14) fail("2주가 지난 기록은 점주에게 직접 말해 주세요.");
    const inHM = String(p.inHM || ""), outHM = String(p.outHM || ""), note = String(p.note || "").trim().slice(0, 200);
    if (!inHM || !HM.test(inHM)) fail("실제 출근 시각을 넣어 주세요.");
    if (outHM && !HM.test(outHM)) fail("퇴근 시각을 다시 확인해 주세요.");
    if (outHM && outHM <= inHM) fail("퇴근 시각이 출근 시각보다 늦어야 해요.");
    if (!note) fail("무슨 일이 있었는지 짧게 적어 주세요.");
    const mid = w.owner ? (p.mid || w.mid) : w.mid;
    const dup = await q<Row[]>(db.from("att_fixes").select("rid").eq("date", p.date).eq("mid", mid).eq("state", "requested"));
    if (dup.length) fail("이 날짜에 이미 답을 기다리는 정정 요청이 있어요.");
    await ins("att_fixes", { id: uid("f"), date: p.date, mid, inHM, outHM, note, state: "requested", createdAt: n.iso });
    const name = ((await c.mgr(mid)) || { name: "" }).name;
    const owner = await c.ownerMid();
    const text = `${dayLabel(p.date)} · ${name}\n출근 ${inHM}${outHM ? " / 퇴근 " + outHM : ""}\n사유: ${note}`;
    background(pushTo(c, [owner], { title: "🕘 출근 기록 정정 요청", body: text.replace(/\n/g, " · "), tag: "attfix", url: "./?tab=admin" }));
    background(notifyOwner(c, `[카공족 홍제] 출근 기록 정정 요청\n${text}\n관리 탭에서 승인해 주세요.`, `[카공족 홍제] 출근 기록 정정 요청 · ${name}`));
    return true;
  },
  async attFixDecide(c, p) {
    await ownerOk(c, p.ownerPin);
    const f = await q<Row | null>(db.from("att_fixes").select("*").eq("id", p.id).maybeSingle());
    if (!f) fail("요청을 찾을 수 없어요.");
    if (f!.state !== "requested") fail("이미 처리된 요청이에요.");
    if (p.approve) await applyAttTimes(c, f!.date, f!.mid, String(p.inHM ?? f!.inHM), String(p.outHM ?? f!.outHM), "정정 요청 승인 · " + f!.note, "점주");
    await upd("att_fixes", f!.rid, { state: p.approve ? "approved" : "rejected", decidedAt: now().iso });
    background(pushTo(c, [f!.mid], p.approve
      ? { title: "✅ 출근 기록 정정이 승인됐어요", body: `${dayLabel(f!.date)} · 출근 ${p.inHM ?? f!.inHM}${(p.outHM ?? f!.outHM) ? " / 퇴근 " + (p.outHM ?? f!.outHM) : ""}`, tag: "attfix" }
      : { title: "🙅 출근 기록 정정이 거절됐어요", body: `${dayLabel(f!.date)} · 자세한 건 점주에게 물어봐 주세요.`, tag: "attfix" }));
    return true;
  },
  async attFixCancel(c, p) {
    const w = await who(c, p);
    const f = await q<Row | null>(db.from("att_fixes").select("*").eq("id", p.id).maybeSingle());
    if (!f) fail("요청을 찾을 수 없어요.");
    if (!w.owner && f!.mid !== w.mid) fail("내 요청만 취소할 수 있어요.");
    if (f!.state !== "requested") fail("이미 처리된 요청이에요.");
    await upd("att_fixes", f!.rid, { state: "canceled", decidedAt: now().iso });
    return true;
  },

  async pushSubscribe(c, p) {
    const w = await who(c, p);
    const sub = p.sub || {};
    if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) fail("알림 정보가 올바르지 않아요.");
    if (!/^https:\/\//.test(sub.endpoint)) fail("알림 정보가 올바르지 않아요.");
    await q(db.from("push_subs").upsert({ endpoint: sub.endpoint, mid: w.mid, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } }, { onConflict: "endpoint" }));
    if (p.welcome) background(pushTo(c, [w.mid], { title: "🔔 알림이 켜졌어요", body: "대타 요청이나 답이 오면 이렇게 알려 드릴게요.", tag: "welcome" }));
    return true;
  },
  async pushUnsubscribe(c, p) {
    if (p.endpoint) await q(db.from("push_subs").delete().eq("endpoint", String(p.endpoint)));
    return true;
  },

  async managerSave(c, p) {
    await ownerOk(c, p.ownerPin);
    const d = p.data || {};
    const row: Row = { name: d.name, days: fmtDays(d.days), startDate: d.startDate || "", wage: d.wage || 0, active: d.active === false ? "N" : "Y", duty: d.duty === "evening" ? "저녁 분리수거" : "오전 청소", payTo: d.payTo || "" };
    if (d.pin) row.pin = String(d.pin);
    if (p.id) {
      const m = await c.mgr(p.id);
      if (!m) fail("매니저를 찾을 수 없어요.");
      await upd("managers", m!.rid, row);
    } else await ins("managers", { id: uid("m"), role: "매니저", order: (await c.managers()).length, ...row });
    return true;
  },

  async eventSave(c, p) { await ownerOk(c, p.ownerPin); await ins("events", { id: uid("e"), date: p.date, title: p.title, time: p.time || "" }); return true; },
  async eventDelete(c, p) { await ownerOk(c, p.ownerPin); await q(db.from("events").delete().eq("id", p.id)); return true; },

  async checklistSave(c, p) {
    await ownerOk(c, p.ownerPin);
    const rows: Row[] = [];
    (p.sections || []).forEach((sec: Row) => (sec.items || []).forEach((it: any) => {
      const o = typeof it === "string" ? { text: it } : it;
      rows.push({ section: sec.title, text: o.text, days: fmtDays(o.days), link: o.link || "", linkLabel: o.linkLabel || "" });
    }));
    await q(db.from("checklist").delete().gte("rid", 0));
    if (rows.length) await ins("checklist", rows);
    await setSetting("체크리스트_출처", "점주 수정 · " + now().date);
    return true;
  },

  async rewardSave(c, p) { await ownerOk(c, p.ownerPin); await q(db.from("rewards").upsert(S({ ym: p.ym, amount: p.amount || 0 }), { onConflict: "ym" })); return true; },

  async override(c, p) {
    await ownerOk(c, p.ownerPin);
    const key = p.date + "__" + p.mid;
    const a = await q<Row | null>(db.from("attendance").select("rid").eq("key", key).maybeSingle());
    if (a) await upd("attendance", a.rid, { override: p.value || "" });
    else { const m = (await c.mgr(p.mid)) || { name: "" }; await ins("attendance", { key, date: p.date, mid: p.mid, name: m.name, override: p.value || "" }); }
    return true;
  },

};
async function refreshNotifyCache(c: Ctx) {
  try { await setSetting("notify_cache", JSON.stringify(await relay(c, "notifyInfo"))); } catch (e) { console.error("notify cache", e); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  let body: Row;
  try { body = await req.json(); } catch { return json({ ok: false, error: "잘못된 요청이에요." }, 400); }
  const fn = ACTIONS[body.action];
  if (!fn) return json({ ok: false, error: "알 수 없는 요청이에요." }, 400);
  try {
    const result = await fn(new Ctx(), body.p || {});
    return json({ ok: true, result });
  } catch (e) {
    if (e instanceof UserError) return json({ ok: false, error: e.message });
    console.error(body.action, e);
    return json({ ok: false, error: "서버 오류가 났어요. 잠시 후 다시 시도해 주세요." });
  }
});
