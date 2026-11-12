// 카공족 홍제 운영실 — CS 관리 서버 함수 (api와 분리)
// 고객 문의를 붙여 넣으면 Claude API로 홍제점 점주 말투의 카톡 답장 초안을 만든다.
// 로그인 확인 방식은 api 함수와 같다 (매니저 이름+PIN 또는 점주 PIN, 6번 틀리면 10분 잠김).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { CS_DEFAULT_TONE, csSystemPrompt, parseCsOutput } from "./prompt.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
type Row = Record<string, any>;
class UserError extends Error {}
const fail = (m: string): never => { throw new UserError(m); };
async function q<T = Row[]>(p: PromiseLike<{ data: any; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}
function now() {
  const d = new Date();
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (k: string) => p.find((x) => x.type === k)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, iso: d.toISOString() };
}

/* ---------- 설정·로그인 ---------- */
const getSettings = () => q<Row[]>(db.from("settings").select("*").order("rid"));
const setting = (all: Row[], k: string) => (all.find((x) => x.key === k) || { value: "" }).value || "";
async function setSetting(k: string, v: string) {
  const r = (await getSettings()).find((x) => x.key === k);
  if (r) await q(db.from("settings").update({ value: v }).eq("rid", r.rid));
  else await q(db.from("settings").insert({ key: k, value: v, note: "CS 관리" }));
}
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
async function who(p: Row) {
  const [mgrs, st] = await Promise.all([q<Row[]>(db.from("managers").select("*").order("rid")), getSettings()]);
  const owner = mgrs.find((m) => m.role === "점주");
  if (p.ownerPin) {
    const op = setting(st, "점주PIN") || (owner && owner.pin) || "";
    if (!op) fail("점주 PIN이 아직 없어요.");
    await failGuard("owner");
    if (String(p.ownerPin) !== op) { await failHit("owner"); fail("점주 PIN이 맞지 않아요."); }
    const m = mgrs.find((x) => x.id === p.mid) || owner;
    return { owner: true, mid: m ? m.id : "", name: m && m.role !== "점주" ? m.name : "점주", settings: st };
  }
  if (p.mid && p.pin) {
    const m = mgrs.find((x) => x.id === p.mid);
    if (!m) fail("매니저를 찾을 수 없어요.");
    if (!m!.pin) fail("이 매니저의 PIN이 아직 없어요. 점주에게 요청해 주세요.");
    await failGuard("m:" + p.mid);
    if (String(p.pin) !== m!.pin) { await failHit("m:" + p.mid); fail("PIN이 맞지 않아요."); }
    return { owner: false, mid: m!.id, name: m!.name, settings: st };
  }
  return fail("먼저 이름과 PIN으로 로그인해 주세요.");
}

/* ---------- Claude API ---------- */
const DAILY_MAX = 150, MAX_Q = 3000;
async function ask(st: Row[], question: string, prev: string, extra: string) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) fail("AI 답변 기능이 아직 켜지지 않았어요. 점주에게 알려 주세요. (Claude API 키 미설정)");
  let user = `고객 문의:\n<inquiry>\n${question}\n</inquiry>`;
  if (prev) user += `\n\n지난번 답장 초안:\n<previous>\n${prev}\n</previous>`;
  if (extra) user += `\n\n직원 요청 (답장에 반영): ${extra}`;
  const system = csSystemPrompt(setting(st, "CS말투"), setting(st, "CS매장정보"));
  const models = [...new Set([Deno.env.get("CS_MODEL") || "claude-sonnet-5-5", "claude-sonnet-4-5"])];
  for (const model of models) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 1500, system, messages: [{ role: "user", content: user }] }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) { console.error("cs fetch", e); return fail("AI 답변이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요."); }
    const txt = await res.text();
    if (res.ok) {
      const j = JSON.parse(txt);
      const out = (j.content || []).filter((b: Row) => b.type === "text").map((b: Row) => b.text).join("");
      return { ...parseCsOutput(out), model };
    }
    console.error("cs api", model, res.status, txt.slice(0, 400));
    if (res.status === 404 || (res.status === 400 && /model/i.test(txt))) continue; // 모델 이름 문제면 다음 모델
    if (res.status === 401) fail("Claude API 키가 맞지 않아요. 점주에게 알려 주세요.");
    if (/credit|billing/i.test(txt)) fail("Claude API 크레딧이 부족해요. 점주에게 알려 주세요.");
    if (res.status === 429 || res.status === 529) fail("AI가 잠시 바빠요. 1분 뒤 다시 시도해 주세요.");
    break;
  }
  return fail("AI 답변을 만들지 못했어요. 잠시 후 다시 시도해 주세요.");
}
const row = (r: Row) => ({ id: r.id, at: r.at, mid: r.mid, name: r.name, question: r.question, reply: r.reply, memo: r.memo, extra: r.extra, parent: r.parent });

/* ---------- 요청 ---------- */
const ACTIONS: Record<string, (p: Row) => Promise<any>> = {
  async csReply(p) {
    const w = await who(p);
    const question = String(p.question || "").trim();
    if (question.length < 2) fail("고객 문의를 붙여 넣어 주세요.");
    if (question.length > MAX_Q) fail(`문의가 너무 길어요. ${MAX_Q.toLocaleString()}자 이하로 줄여 주세요.`);
    const extra = String(p.extra || "").trim().slice(0, 500);
    const n = now();
    let base: Row | null = null;
    if (p.id) {
      base = await q<Row | null>(db.from("cs_replies").select("*").eq("id", p.id).maybeSingle());
      if (!base) fail("기록을 찾을 수 없어요. 이미 지워졌을 수 있어요.");
    }
    const today = await q<Row[]>(db.from("cs_replies").select("rid").eq("date", n.date));
    if (today.length >= DAILY_MAX) fail(`오늘은 AI 답변을 ${DAILY_MAX}번 만들어서 더 만들 수 없어요. 내일 다시 써 주세요.`);
    const r = await ask(w.settings, question, base ? String(base.reply || "") : "", extra);
    const rec = { id: "cs-" + crypto.randomUUID().slice(0, 8), at: n.iso, date: n.date, mid: w.mid, name: w.name, question, reply: r.reply, memo: r.memo, extra, model: r.model, parent: base ? base.id : "" };
    await q(db.from("cs_replies").insert(rec));
    return row(rec);
  },
  async csList(p) {
    const w = await who(p);
    const rows = await q<Row[]>(db.from("cs_replies").select("*").order("rid", { ascending: false }).limit(60));
    return {
      items: rows.map(row), tone: setting(w.settings, "CS말투"), info: setting(w.settings, "CS매장정보"),
      defaultTone: CS_DEFAULT_TONE, ready: !!Deno.env.get("ANTHROPIC_API_KEY"), isOwner: w.owner, me: w.mid,
    };
  },
  async csDelete(p) {
    const w = await who(p);
    const r = await q<Row | null>(db.from("cs_replies").select("*").eq("id", p.id).maybeSingle());
    if (!r) return true;
    if (!w.owner && r.mid !== w.mid) fail("내가 만든 기록만 지울 수 있어요.");
    await q(db.from("cs_replies").delete().eq("id", p.id));
    return true;
  },
  async csSettingsSave(p) {
    const w = await who(p);
    if (!w.owner) fail("말투·매장 정보는 점주만 바꿀 수 있어요.");
    const tone = String(p.tone ?? "").trim(), info = String(p.info ?? "").trim();
    if (tone.length > 4000 || info.length > 4000) fail("4,000자 이하로 줄여 주세요.");
    await setSetting("CS말투", tone);
    await setSetting("CS매장정보", info);
    return true;
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  let body: Row;
  try { body = await req.json(); } catch { return json({ ok: false, error: "잘못된 요청이에요." }, 400); }
  const fn = ACTIONS[body.action];
  if (!fn) return json({ ok: false, error: "알 수 없는 요청이에요." }, 400);
  try { return json({ ok: true, result: await fn(body.p || {}) }); }
  catch (e) {
    if (e instanceof UserError) return json({ ok: false, error: e.message });
    console.error(body.action, e);
    return json({ ok: false, error: "서버 오류가 났어요. 잠시 후 다시 시도해 주세요." });
  }
});
