import { useState, useEffect, useRef } from "react";

// ════════════════════════════════════════════════════════
// SUPABASE
// ════════════════════════════════════════════════════════
const SB_URL = "https://tyxvuscqdnyhehmkcxfw.supabase.co";
const SB_KEY = "sb_publishable_Dl4Bf62VEFxs0R94oZAwqw_Q-Z7jMIm";

async function sb(table, method="GET", body=null, query="") {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, {
      method,
      headers: {
        "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
        "Content-Type": "application/json", "Prefer": "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(text);
    return text ? JSON.parse(text) : null;
  } catch(e) { console.warn("DB:", e.message); return null; }
}

function sbListen(table, filter, onRow) {
  try {
    const ws = new WebSocket(`${SB_URL}/realtime/v1/websocket?apikey=${SB_KEY}&vsn=1.0.0`);
    const ref = Date.now().toString();
    ws.onopen = () => ws.send(JSON.stringify({
      topic: `realtime:public:${table}${filter ? `:${filter}` : ""}`,
      event: "phx_join", payload: { config: { broadcast: { self: true } } }, ref,
    }));
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (["INSERT","UPDATE"].includes(m.event)) onRow(m.payload?.record);
    };
    ws.onerror = () => {};
    return () => ws.close();
  } catch { return () => {}; }
}

const DB = {
  async createUser(nickname) { return (await sb("users","POST",{nickname,profile_pct:0}))?.[0]||null; },
  async getUser(id) { return (await sb("users","GET",null,`?id=eq.${id}&select=*`))?.[0]||null; },
  async updateUser(id, data) { return (await sb("users","PATCH",{...data,last_active:new Date().toISOString()},`?id=eq.${id}`))?.[0]||null; },
  async getVector(uid) { return (await sb("soul_vectors","GET",null,`?user_id=eq.${uid}`))?.[0]||null; },
  async upsertVector(uid, vec) {
    const pct = calcPct(vec);
    const r = await sb("soul_vectors","POST",{...vec,user_id:uid,updated_at:new Date().toISOString()},"?on_conflict=user_id");
    await sb("users","PATCH",{profile_pct:pct},`?id=eq.${uid}`);
    return r?.[0]||null;
  },
  async saveChat(uid, role, content) { return (await sb("soul_chats","POST",{user_id:uid,role,content}))?.[0]||null; },
  async getChats(uid, limit=80) { return await sb("soul_chats","GET",null,`?user_id=eq.${uid}&order=created_at.asc&limit=${limit}`) || []; },
  async getUsers(excludeId) { return await sb("users","GET",null,`?id=neq.${excludeId}&profile_pct=gte.5&order=last_active.desc&limit=30&select=*,soul_vectors(*)`) || []; },
  async createMatch(aId, bId, score, tier, dynamics) {
    const [a,b] = [aId,bId].sort();
    return (await sb("matches","POST",{user_a:a,user_b:b,score,tier,dynamics:JSON.stringify(dynamics),status:"pending"},"?on_conflict=user_a,user_b"))?.[0]||null;
  },
  async getMatches(uid) { return await sb("matches","GET",null,`?or=(user_a.eq.${uid},user_b.eq.${uid})&order=created_at.desc&select=*`) || []; },
  async acceptMatch(mid) {
    const room = (await sb("chat_rooms","POST",{match_id:mid}))?.[0]||null;
    await sb("matches","PATCH",{status:"accepted"},`?id=eq.${mid}`);
    return room;
  },
  async getRoomByMatch(mid) { return (await sb("chat_rooms","GET",null,`?match_id=eq.${mid}`))?.[0]||null; },
  async sendMsg(roomId, senderId, content) { return (await sb("messages","POST",{room_id:roomId,sender_id:senderId,content}))?.[0]||null; },
  async getMsgs(roomId) { return await sb("messages","GET",null,`?room_id=eq.${roomId}&order=created_at.asc&limit=100`) || []; },
  listenMsgs(roomId, cb) { return sbListen("messages",`room_id=eq.${roomId}`,cb); },
  listenMatches(uid, cb) { return sbListen("matches",`user_b=eq.${uid}`,cb); },
};

function calcPct(vec) {
  const fields = ["core_emotion","attachment","conflict","love_lang","fear","shine","voice","pattern"];
  const filled = fields.filter(f => vec[f]).length;
  return Math.min(100, Math.floor(filled/fields.length*80) + Math.min((vec.tags?.length||0)*3, 20));
}

// ════════════════════════════════════════════════════════
// ① 콜드스타트 해결 — AI 더미 유저 (Supabase에 실제 저장)
// ════════════════════════════════════════════════════════
const DUMMY_USERS = [
  { nickname:"지현", emoji:"🌿", color:"#C8906A", profile_pct:82,
    vec:{ core_emotion:"온기", attachment:"anxious", conflict:"avoiding", love_lang:"time",
      fear:"버려지는 것", shine:"말없이 이해받을 때", voice:"말수는 적지만 깊은", pattern:"천천히 열리고 깊이 헌신",
      emoji:"🌿", color:"#C8906A", tags:["재즈","독서","카페"], confidence:80 }},
  { nickname:"도윤", emoji:"🌊", color:"#5AAA82", profile_pct:75,
    vec:{ core_emotion:"신뢰", attachment:"secure", conflict:"compromising", love_lang:"acts",
      fear:"정체되는 것", shine:"혼자 몰입할 때", voice:"논리적이지만 따뜻한", pattern:"서두르지 않고 깊어지는",
      emoji:"🌊", color:"#5AAA82", tags:["로파이","독서","미니멀"], confidence:75 }},
  { nickname:"서연", emoji:"🌙", color:"#9A84C4", profile_pct:68,
    vec:{ core_emotion:"달빛", attachment:"secure", conflict:"avoiding", love_lang:"words",
      fear:"혼자 남는 것", shine:"꽃 사이에서 하루 시작할 때", voice:"감성적이고 섬세한", pattern:"느리게 사랑하는",
      emoji:"🌙", color:"#9A84C4", tags:["인디","그림","빈티지"], confidence:68 }},
  { nickname:"하은", emoji:"🦋", color:"#C4784A", profile_pct:91,
    vec:{ core_emotion:"설렘", attachment:"secure", conflict:"confronting", love_lang:"words",
      fear:"무뎌지는 것", shine:"새로운 걸 발견할 때", voice:"솔직하고 에너지 넘치는", pattern:"빠르게 빠져들고 솔직한",
      emoji:"🦋", color:"#C4784A", tags:["팝","여행","보헤미안"], confidence:91 }},
  { nickname:"민준", emoji:"⚡", color:"#6A90C4", profile_pct:59,
    vec:{ core_emotion:"불꽃", attachment:"avoidant", conflict:"confronting", love_lang:"acts",
      fear:"실패하는 것", shine:"뭔가 만들어낼 때", voice:"직접적이고 열정적인", pattern:"강렬하게 시작하는",
      emoji:"⚡", color:"#6A90C4", tags:["힙합","여행","게임"], confidence:59 }},
];

async function seedDummyUsers() {
  // 더미 유저가 이미 있는지 확인
  const existing = await sb("users","GET",null,"?nickname=like.%5B소울%5D*&limit=1");
  if (existing?.length > 0) return; // 이미 있으면 스킵

  for (const d of DUMMY_USERS) {
    try {
      const u = await sb("users","POST",{ nickname:`[소울]${d.nickname}`, profile_pct: d.profile_pct, bio:"AI 소울 파트너" });
      if (u?.[0]) {
        await sb("soul_vectors","POST",{ ...d.vec, user_id: u[0].id, updated_at: new Date().toISOString() },"?on_conflict=user_id");
      }
    } catch {}
  }
}

// ════════════════════════════════════════════════════════
// CLAUDE API
// ════════════════════════════════════════════════════════
const API = "/api/claude";

async function ai(system, user, max=500, signal=null) {
  for (let i=0; i<=2; i++) {
    try {
      const r = await fetch(API, { method:"POST", signal,
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:max, system, messages:[{role:"user",content:user}] }),
      });
      if (!r.ok) { if (r.status>=500&&i<2){await sleep(700*(i+1));continue;} throw new Error(r.status); }
      return (await r.json()).content?.map(b=>b.text||"").join("") || "";
    } catch(e) { if(e.name==="AbortError") throw e; if(i===2) return ""; await sleep(700*(i+1)); }
  }
  return "";
}

async function aiStream(system, user, max=180, onChunk, signal=null) {
  try {
    const r = await fetch(API, { method:"POST", signal,
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:max, system, messages:[{role:"user",content:user}], stream:true }),
    });
    if (!r.ok) throw new Error(r.status);
    const reader = r.body.getReader(); const dec = new TextDecoder(); let full = "";
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      for (const line of dec.decode(value).split("\n").filter(l=>l.startsWith("data: "))) {
        const d = line.slice(6); if (d==="[DONE]") continue;
        try { const t=JSON.parse(d).delta?.text||""; if(t){full+=t;onChunk(full);} } catch {}
      }
    }
    return full;
  } catch(e) {
    if (e.name==="AbortError") throw e;
    const r = await ai(system, user, max, signal); if(r) onChunk(r); return r;
  }
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ════════════════════════════════════════════════════════
// ② 소울 대화 — 레벨별 모드 + 방향성
// ════════════════════════════════════════════════════════

// 레벨별 소울 모드
function getSoulMode(pct) {
  if (pct < 20) return { mode:"탐색", label:"처음 만남", desc:"서로 알아가는 중", color:"#8A9AA8" };
  if (pct < 40) return { mode:"연결", label:"연결되는 중", desc:"패턴이 보이기 시작해요", color:"#5A9A7A" };
  if (pct < 60) return { mode:"심화", label:"깊어지는 중", desc:"숨겨진 면이 보여요", color:"#B8915A" };
  if (pct < 80) return { mode:"각성", label:"자기 발견", desc:"진짜 나를 알아가요", color:"#9A7AC4" };
  return { mode:"완성", label:"소울 완성", desc:"당신을 완전히 알아요", color:"#C87050" };
}

// 레벨별 언락 혜택
function getUnlocks(pct) {
  const unlocks = [];
  if (pct >= 20) unlocks.push({ icon:"🔍", label:"탐색 탭 해금", desc:"다른 유저 볼 수 있어요" });
  if (pct >= 40) unlocks.push({ icon:"💫", label:"매칭 신청 가능", desc:"궁합 분석 시작" });
  if (pct >= 60) unlocks.push({ icon:"🌟", label:"심층 리포트", desc:"내 심리 프로파일 전체 공개" });
  if (pct >= 80) unlocks.push({ icon:"✦", label:"100년 시뮬레이션", desc:"가장 정확한 버전" });
  if (pct >= 100) unlocks.push({ icon:"👑", label:"소울 마스터", desc:"완성된 매칭 프로파일" });
  return unlocks;
}

// ⑤ 매일 달라지는 소울 모드 — 오늘의 테마
const DAILY_THEMES = [
  { theme:"감정", question:"오늘 하루 어떤 감정이 가장 컸어요?", followup:"그 감정, 자주 느끼는 편이에요?" },
  { theme:"관계", question:"최근에 누군가한테 고마웠던 적 있어요?", followup:"그 사람한테 표현했어요?" },
  { theme:"두려움", question:"요즘 가장 피하고 싶은 게 있어요?", followup:"왜 그게 무서운 것 같아요?" },
  { theme:"꿈", question:"10년 후 어떤 하루를 살고 싶어요?", followup:"그 하루에 옆에 있는 사람은 어떤 사람이에요?" },
  { theme:"상처", question:"연애에서 가장 힘들었던 순간이 언제예요?", followup:"그때 뭐가 있었으면 달랐을 것 같아요?" },
  { theme:"행복", question:"가장 최근에 진짜 웃었던 게 언제예요?", followup:"그 순간에 누가 있었어요?" },
  { theme:"패턴", question:"좋아하는 사람 생기면 어떻게 돼요?", followup:"그 패턴, 스스로도 알고 있었어요?" },
];

function getTodayTheme() {
  const day = Math.floor(Date.now() / 86400000);
  return DAILY_THEMES[day % DAILY_THEMES.length];
}

async function soulReply(history, msg, vec, pct, onChunk, signal) {
  const mode = getSoulMode(pct);
  const ctx = vec?.core_emotion
    ? `파악된 성향: 핵심감정=${vec.core_emotion}, 애착=${vec.attachment||"?"}, 갈등=${vec.conflict||"?"}, 두려움="${vec.fear||"?"}", 완성도=${pct}%`
    : `아직 잘 모르는 단계 (완성도 ${pct}%)`;

  const modeGuide = {
    "탐색": "가볍고 따뜻하게. 판단 없이 들어주기. 자연스러운 질문 하나.",
    "연결": "패턴을 발견하기 시작. '아까 말한 것처럼...' 연결해주기. 조금 더 깊이 들어가기.",
    "심화": "숨겨진 감정 건드리기. 부드럽지만 핵심을 찌르는 질문. '혹시 이게...' 가설 제시.",
    "각성": "자기 발견 촉진. '당신은 사실...' 인사이트 제공. 구체적이고 날카롭게.",
    "완성": "깊은 이해 기반 대화. 패턴 전체를 반영해서 응답. 소울메이트 추천 준비.",
  };

  const recentHistory = history.slice(-8).map(m=>`${m.role==="user"?"상대방":"소울"}: ${m.content}`).join("\n");

  return aiStream(
    `당신은 "소울" — AI 소울 파트너. 현재 모드: ${mode.mode} (${mode.label})
${ctx}
대화 스타일: ${modeGuide[mode.mode]}
원칙: 2~3문장. 공감 먼저. 자연스러운 질문 하나. 한국어 구어체. 절대 상담사처럼 굴지 않기.
최근 대화:\n${recentHistory}`,
    msg, 160, onChunk, signal
  );
}

async function extractVector(chats, current) {
  const userMsgs = chats.filter(m=>m.role==="user");
  if (userMsgs.length < 3) return current;
  const msgs = userMsgs.slice(-20).map(m=>m.content).join("\n---\n");
  const raw = await ai("심리학자. 순수JSON만.",
    `대화:\n${msgs}\n\nJSON:{"core_emotion":"4자","attachment":"secure|anxious|avoidant|null","conflict":"confronting|avoiding|compromising|null","love_lang":"words|acts|gifts|time|touch|null","fear":"15자|null","shine":"15자|null","voice":"20자|null","pattern":"20자|null","emoji":"이모지1개","color":"hex","confidence":0-100}`,
    400
  );
  try {
    const p = JSON.parse(raw.replace(/```json|```/g,"").trim());
    const merged = {...(current||{})};
    Object.keys(p).forEach(k => { if(p[k]!==null&&p[k]!==undefined) merged[k]=p[k]; });
    return merged;
  } catch { return current; }
}

async function calcMatch(vA, vB, nA, nB) {
  const raw = await ai("관계심리전문가. 순수JSON만. 점수를 80~90에 몰아넣지 마세요. 실제 분석 기반.",
    `${nA}:애착=${vA.attachment||"?"},갈등=${vA.conflict||"?"},사랑언어=${vA.love_lang||"?"},두려움="${vA.fear||"?"}"\n${nB}:애착=${vB.attachment||"?"},갈등=${vB.conflict||"?"},사랑언어=${vB.love_lang||"?"},두려움="${vB.fear||"?"}"\nJSON:{"score":35-99,"chemistry":"25자","tension":"25자","complement":"25자","glue":"25자","why":"점수이유30자","tensions":{"20s":"15자","30s":"15자","40s":"15자","50s":"15자","60s":"15자"}}`,
    420
  );
  try {
    const p = JSON.parse(raw.replace(/```json|```/g,"").trim());
    p.score = Math.max(35, Math.min(99, parseInt(p.score)||65));
    p.tier = p.score>=90?"FATE":p.score>=80?"SOUL":p.score>=68?"MATCH":p.score>=55?"BOND":"GROW";
    return p;
  } catch {
    return { score:68, tier:"MATCH", chemistry:"다른 듯 닮아가는", tension:"표현 방식 차이", complement:"약점이 맞물림", glue:"말없이 통하는 침묵", why:"프로파일 기반 보완 관계", tensions:{"20s":"속도차이","30s":"역할기대","40s":"각자의꿈","50s":"재적응","60s":"의존"} };
  }
}

// ④ AI 아이스브레이커 — 채팅 첫 메시지
async function getIcebreaker(vecA, vecB, nameA, nameB, dyn) {
  return await ai("관계 코치. 따뜻하고 재밌는 한 문장.",
    `${nameA}(${vecA.core_emotion||"?"},${vecA.love_lang||"?"},두려움:"${vecA.fear||"?"}")와 ${nameB}(${vecB.core_emotion||"?"},${vecB.love_lang||"?"},두려움:"${vecB.fear||"?"}") 첫 대화.\n케미: ${dyn.chemistry}.\n두 사람 성격에 맞는 자연스러운 아이스브레이커 질문 하나. 가볍게.`,
    120
  );
}

// 시뮬레이션
const STAGES = [
  {l:"첫 만남",age:"25세",icon:"✦"},{l:"설레는 연애",age:"27세",icon:"✦"},
  {l:"프로포즈",age:"29세",icon:"◆"},{l:"결혼",age:"31세",icon:"◆"},
  {l:"우리 가정",age:"35세",icon:"✦"},{l:"함께 성장",age:"45세",icon:"✦"},
  {l:"황금기",age:"60세",icon:"◆"},{l:"영원히",age:"85세",icon:"∞"},
];
const SC = ["#B8915A","#C06040","#8A7068","#5A7868","#6A8A6A","#7A8A9A","#B8915A","#8A7068"];

async function genStage(stage, vA, vB, dyn, nA, nB, history, onChunk, signal) {
  const tone = {"첫 만남":"설렘과 어색함","설레는 연애":"달콤하지만 조심스러운","프로포즈":"두려움과 용기","결혼":"기쁨과 책임감","우리 가정":"따뜻하지만 지치기도 하는","함께 성장":"갈등이 있지만 극복하는","황금기":"깊고 조용한","영원히":"완성된 사랑"};
  const crisis = stage.l==="함께 성장"||stage.l==="프로포즈";
  const prev = history.length>0 ? `이미 쓴 장면: ${history.join(", ")}. 완전히 다른 장면.` : "";
  return aiStream(
    `감성적인 소설 작가. 2~3문장. 이름 사용. 감정은 행동/대화로.\n【${nA}】말투:${vA.voice||"따뜻한"}/두려움:${vA.fear||"없음"}\n【${nB}】말투:${vB.voice||"솔직한"}/두려움:${vB.fear||"없음"}\n역학:${dyn.chemistry}${prev?"\n"+prev:""}`,
    `${stage.l}(${stage.age}) — 톤:${tone[stage.l]||"따뜻한"}${crisis?" — 갈등 후 해결 포함":""}. 마지막 문장 여운.`,
    210, onChunk, signal
  );
}

async function genReport(vA, vB, dyn, nA, nB) {
  const raw = await ai("관계심리전문가이자감성작가. 순수JSON만.",
    `${nA}:${JSON.stringify(vA).slice(0,160)} ${nB}:${JSON.stringify(vB).slice(0,160)} score=${dyn.score},chemistry="${dyn.chemistry}"\nJSON:{"title":"20자","why_works":"40자","why_hard":"35자","turning_point":"45자","decade":{"20대":"25자","30대":"25자","40대":"25자","50대":"25자","60대":"25자"},"message":"45자","share_quote":"30자"}`,
    440
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return { title:"서로의 언어를 배우는 여정", why_works:"약점이 맞물리는 보완 관계", why_hard:"표현 방식 차이", turning_point:"처음으로 서로 앞에서 우는 날", decade:{"20대":"설레는 탐색","30대":"현실속 버팀","40대":"위기 후 성장","50대":"편안함","60대":"말없이 통함"}, message:"함께라면 어떤 계절도 아름다울 거예요", share_quote:"AI가 쓴 우리 100년, 소름" }; }
}

// ════════════════════════════════════════════════════════
// SESSION
// ════════════════════════════════════════════════════════
const SK = "ss_v2";
const loadSess = () => { try { return JSON.parse(localStorage.getItem(SK)||"{}"); } catch { return {}; } };
const saveSess = d => { try { localStorage.setItem(SK, JSON.stringify(d)); } catch {} };

// ════════════════════════════════════════════════════════
// DESIGN
// ════════════════════════════════════════════════════════
const C = { ink:"#1A1108", gold:"#B8915A", bg:"#F9F5EF", paper:"#F3EDE3", rule:"rgba(26,17,8,.09)", dim:"rgba(26,17,8,.38)" };
const TIER_MAP = { FATE:"운명의 단 하나", SOUL:"영혼의 단짝", MATCH:"완벽한 궁합", BOND:"깊은 유대감", GROW:"함께 성장" };
const ATT_MAP = { secure:"안정형", anxious:"불안형", avoidant:"회피형" };
const CONF_MAP = { confronting:"직면형", avoiding:"회피형", compromising:"타협형" };
const LOVE_MAP = { words:"언어", acts:"행동", gifts:"선물", time:"시간", touch:"접촉" };
const TL = { "20s":"20대","30s":"30대","40s":"40대","50s":"50대","60s":"60대" };

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,300;0,400;1,300;1,400&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;font-weight:300;color:#1A1108;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
::-webkit-scrollbar{display:none}
input,textarea,button{font-family:inherit}
textarea{resize:none}
@keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fadein{from{opacity:0}to{opacity:1}}
@keyframes slide{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes barfill{from{width:0}}
@keyframes mi{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes unlock{0%{transform:scale(.8);opacity:0}70%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
.a1{animation:up .65s cubic-bezier(.16,1,.3,1) both}
.a2{animation:up .65s .07s cubic-bezier(.16,1,.3,1) both}
.a3{animation:up .65s .14s cubic-bezier(.16,1,.3,1) both}
.a4{animation:up .65s .21s cubic-bezier(.16,1,.3,1) both}
.si{animation:slide .35s cubic-bezier(.16,1,.3,1) both}
.mi{animation:mi .3s cubic-bezier(.16,1,.3,1) both}
.cursor{display:inline-block;width:2px;height:.82em;background:#1A1108;margin-left:1px;animation:blink .7s infinite;vertical-align:text-bottom}
`;

// ════════════════════════════════════════════════════════
// ATOMS
// ════════════════════════════════════════════════════════
const rule = <div style={{height:1,background:C.rule,flexShrink:0}}/>;

function Btn({label,onClick,ghost,full,sm,disabled,style:s}) {
  const [h,setH] = useState(false);
  return <button onClick={onClick} disabled={disabled}
    onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)}
    style={{padding:sm?"8px 16px":"12px 24px",
      background:disabled?"#ccc":ghost?h?"rgba(26,17,8,.06)":"transparent":h?"#2A1E0E":C.ink,
      color:disabled?"#999":ghost?C.dim:C.bg,
      border:ghost?`1px solid ${C.rule}`:"none",
      fontSize:11,letterSpacing:".1em",textTransform:"uppercase",
      cursor:disabled?"not-allowed":"pointer",transition:"background .15s",
      width:full?"100%":"auto",flexShrink:0,...s}}>{label}</button>;
}

function Spin({text}) {
  return <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:11,padding:"32px 0"}}>
    <div style={{width:28,height:28,borderRadius:"50%",border:`1.5px solid ${C.rule}`,borderTopColor:C.ink,animation:"spin .8s linear infinite"}}/>
    {text&&<p style={{fontSize:11,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",textAlign:"center"}}>{text}</p>}
  </div>;
}

function Ava({user,vec,size=40}) {
  const emoji = vec?.emoji||"✨";
  const color = vec?.color||C.paper;
  return <div style={{width:size,height:size,borderRadius:"50%",border:`1px solid ${C.rule}`,overflow:"hidden",
    background:`${color}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*.42,flexShrink:0}}>
    {user?.img_url ? <img src={user.img_url} style={{width:"100%",height:"100%",objectFit:"cover"}}/> : emoji}
  </div>;
}

function Glass({children,style:s,gold,onClick}) {
  return <div onClick={onClick} style={{background:C.paper,border:`1px solid ${C.rule}`,
    borderLeft:gold?`3px solid ${C.gold}`:`1px solid ${C.rule}`,
    cursor:onClick?"pointer":"default",...s}}>{children}</div>;
}

function TNav({left,center,right,prog}) {
  return <div style={{flexShrink:0,background:"rgba(249,245,239,.96)",backdropFilter:"blur(16px)",borderBottom:`1px solid ${C.rule}`}}>
    <div style={{height:50,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 18px",maxWidth:480,margin:"0 auto"}}>
      <div style={{minWidth:52}}>{left}</div>
      <span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:17,color:C.ink}}>{center}</span>
      <div style={{minWidth:52,display:"flex",justifyContent:"flex-end"}}>{right}</div>
    </div>
    {prog!=null&&<><div style={{height:2,background:C.rule,margin:"0 18px"}}><div style={{height:"100%",width:`${prog}%`,background:C.ink,transition:"width .4s"}}/></div><div style={{height:9}}/></>}
  </div>;
}

function BNav({tab,set,matchCount}) {
  return <div style={{flexShrink:0,background:"rgba(249,245,239,.96)",backdropFilter:"blur(16px)",borderTop:`1px solid ${C.rule}`}}>
    <div style={{display:"flex",maxWidth:480,margin:"0 auto"}}>
      {[["소울","soul"],["탐색","explore"],["매칭","matches"],["채팅","chat"],["나","me"]].map(([l,k])=>(
        <button key={k} onClick={()=>set(k)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"9px 0",background:"none",border:"none",cursor:"pointer",position:"relative"}}>
          <div style={{width:4,height:4,borderRadius:"50%",background:tab===k?C.ink:"transparent",border:`1px solid ${tab===k?C.ink:C.rule}`,transition:"all .2s"}}/>
          <span style={{fontSize:8,letterSpacing:".12em",textTransform:"uppercase",color:tab===k?C.ink:C.dim,fontWeight:tab===k?500:300}}>{l}</span>
          {k==="matches"&&matchCount>0&&<div style={{width:16,height:16,borderRadius:"50%",background:"#E8607A",position:"absolute",top:4,right:"15%",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{fontSize:8,color:"#fff",fontWeight:500}}>{matchCount}</span>
          </div>}
        </button>
      ))}
    </div>
  </div>;
}

function ABar({children}) {
  return <div style={{flexShrink:0,background:"rgba(249,245,239,.96)",backdropFilter:"blur(16px)",borderTop:`1px solid ${C.rule}`,padding:"11px 18px"}}>
    <div style={{maxWidth:480,margin:"0 auto",display:"flex",gap:9}}>{children}</div>
  </div>;
}

// ③ 언락 팝업
function UnlockPopup({unlock,onClose}) {
  if (!unlock) return null;
  return <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(26,17,8,.5)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 32px"}}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.bg,width:"100%",maxWidth:340,padding:28,animation:"unlock .4s cubic-bezier(.16,1,.3,1) both"}}>
      <div style={{textAlign:"center",marginBottom:18}}>
        <p style={{fontSize:36,marginBottom:12}}>{unlock.icon}</p>
        <p style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:22,marginBottom:6}}>해금됐어요!</p>
        <p style={{fontSize:14,color:C.ink,fontWeight:500,marginBottom:5}}>{unlock.label}</p>
        <p style={{fontSize:12,color:C.dim,lineHeight:1.6}}>{unlock.desc}</p>
      </div>
      <Btn label="확인 →" onClick={onClose} full/>
    </div>
  </div>;
}

// 토스트
function Toast({msg,type="info",onClose}) {
  useEffect(()=>{ if(msg){const t=setTimeout(onClose,3500);return()=>clearTimeout(t);} },[msg]);
  if (!msg) return null;
  const bg = type==="success"?"#2A6E4A":type==="error"?"#B83232":C.ink;
  return <div style={{position:"fixed",bottom:88,left:"50%",transform:"translateX(-50%)",background:bg,color:C.bg,
    padding:"11px 18px",fontSize:12,letterSpacing:".06em",zIndex:400,maxWidth:300,textAlign:"center",
    animation:"fadein .3s ease",whiteSpace:"pre-line"}}>{msg}</div>;
}

// ② 프로파일 바 + 모드
function SoulBar({pct}) {
  const mode = getSoulMode(pct);
  return <div style={{padding:"10px 18px",background:C.paper,borderBottom:`1px solid ${C.rule}`,flexShrink:0}}>
    <div style={{maxWidth:480,margin:"0 auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:9,color:mode.color,letterSpacing:".12em",textTransform:"uppercase",fontWeight:500}}>{mode.label}</span>
          <span style={{fontSize:9,color:C.dim}}>· {mode.desc}</span>
        </div>
        <span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:15,color:mode.color}}>{pct}%</span>
      </div>
      <div style={{height:2,background:C.rule}}>
        <div style={{height:"100%",width:`${pct}%`,background:mode.color,transition:"width 1s cubic-bezier(.16,1,.3,1)"}}/>
      </div>
    </div>
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: JOIN
// ════════════════════════════════════════════════════════
function JoinScreen({onDone}) {
  const [name,setName] = useState("");
  const [loading,setLoading] = useState(false);
  const [err,setErr] = useState("");

  const join = async () => {
    if (!name.trim()) { setErr("닉네임을 입력해주세요"); return; }
    setLoading(true);
    try {
      const user = await DB.createUser(name.trim());
      if (!user) throw new Error();
      saveSess({ userId:user.id, nickname:user.nickname });
      // ① 더미 유저 시드 (백그라운드)
      seedDummyUsers().catch(()=>{});
      onDone(user);
    } catch { setErr("오류가 났어요. 다시 시도해주세요."); }
    setLoading(false);
  };

  return <div style={{display:"flex",flexDirection:"column",height:"100%",alignItems:"center",justifyContent:"center",padding:"0 28px",background:C.bg}}>
    <div style={{width:"100%",maxWidth:360,animation:"up .6s ease both"}}>
      <p style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:36,textAlign:"center",marginBottom:8}}>Soulscope</p>
      <p style={{fontSize:13,color:C.dim,textAlign:"center",lineHeight:1.8,marginBottom:32}}>AI 소울 파트너와 매일 대화하면서<br/>나를 알아가고 소울메이트를 찾아요</p>
      <p style={{fontSize:9,color:C.dim,letterSpacing:".14em",textTransform:"uppercase",marginBottom:7}}>닉네임</p>
      <input style={{width:"100%",background:C.bg,border:`1px solid ${C.rule}`,padding:"13px 14px",fontSize:15,color:C.ink,outline:"none",marginBottom:err?8:14,transition:"border .2s"}}
        placeholder="나를 부를 이름" value={name} onChange={e=>setName(e.target.value)}
        onKeyDown={e=>e.key==="Enter"&&join()}
        onFocus={e=>e.target.style.borderColor=C.ink} onBlur={e=>e.target.style.borderColor=C.rule}
        autoFocus/>
      {err&&<p style={{fontSize:12,color:"#B83232",marginBottom:10}}>{err}</p>}
      {loading?<Spin text="시작하는 중"/>:<Btn label="소울 파트너 만나기 →" onClick={join} full/>}
      <p style={{fontSize:10,color:C.dim,textAlign:"center",marginTop:14,lineHeight:1.6}}>로그인 없이 시작 · 데이터 안전 저장</p>
    </div>
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: SOUL ② ③ ⑤
// ════════════════════════════════════════════════════════
function SoulScreen({user,vec,onVecUpdate,onPctChange}) {
  const [msgs,setMsgs] = useState([]);
  const [input,setInput] = useState("");
  const [loading,setLoading] = useState(false);
  const [streaming,setStreaming] = useState("");
  const [unlock,setUnlock] = useState(null);
  const [toast,setToast] = useState("");
  const [todayTheme] = useState(getTodayTheme);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const msgCountRef = useRef(0);
  const pct = user.profile_pct||0;

  useEffect(()=>{
    loadHistory();
    return()=>abortRef.current?.abort();
  },[]);

  useEffect(()=>{ scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight,behavior:"smooth"}); },[msgs,streaming]);

  const loadHistory = async () => {
    const chats = await DB.getChats(user.id);
    setMsgs(chats.map(c=>({role:c.role,content:c.content})));
    msgCountRef.current = chats.filter(c=>c.role==="user").length;
    if (chats.length===0) setTimeout(()=>sendGreeting(),500);
  };

  const sendGreeting = async () => {
    setLoading(true);
    abortRef.current = new AbortController();
    let full = "";
    await aiStream(
      `당신은 "소울" — AI 소울 파트너. 처음 만나는 사람에게 따뜻하고 자연스럽게 인사. 2~3문장. 오늘의 테마로 자연스럽게 대화 시작.`,
      `사용자: ${user.nickname}. 오늘 테마: "${todayTheme.theme}" — "${todayTheme.question}"으로 자연스럽게 연결해서 인사해줘.`,
      160, t=>{setStreaming(t);full=t;}, abortRef.current.signal
    ).catch(()=>{});
    if (full) {
      setMsgs([{role:"ai",content:full}]);
      setStreaming("");
      await DB.saveChat(user.id,"ai",full);
    }
    setLoading(false);
  };

  const send = async () => {
    if (!input.trim()||loading) return;
    const userMsg = input; setInput("");
    const newMsgs = [...msgs,{role:"user",content:userMsg}];
    setMsgs(newMsgs);
    await DB.saveChat(user.id,"user",userMsg);
    msgCountRef.current++;

    setLoading(true);
    abortRef.current = new AbortController();
    let full = "";
    try {
      await soulReply(newMsgs, userMsg, vec, pct, t=>{setStreaming(t);full=t;}, abortRef.current.signal);
    } catch(e) { if(e.name!=="AbortError") full="잠깐 생각 중이에요... 다시 말해줄래요?"; }

    setStreaming("");
    if (full) {
      const finalMsgs = [...newMsgs,{role:"ai",content:full}];
      setMsgs(finalMsgs);
      await DB.saveChat(user.id,"ai",full);

      // ③ 5번마다 벡터 업데이트 + 언락 체크
      if (msgCountRef.current%5===0) {
        const allChats = await DB.getChats(user.id);
        const newVec = await extractVector(allChats, vec);
        if (newVec) {
          const newPct = calcPct(newVec);
          await DB.upsertVector(user.id, newVec);
          onVecUpdate(newVec);
          onPctChange(newPct);

          // 언락 이벤트
          const prevUnlocks = getUnlocks(pct).length;
          const newUnlocks = getUnlocks(newPct);
          if (newUnlocks.length > prevUnlocks) {
            setUnlock(newUnlocks[newUnlocks.length-1]);
          } else {
            setToast("소울 프로파일이 업데이트됐어요 ✦");
          }
        }
      }
    }
    setLoading(false);
  };

  const mode = getSoulMode(pct);

  return <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    <TNav
      left={<div style={{display:"flex",alignItems:"center",gap:7}}>
        <div style={{width:7,height:7,borderRadius:"50%",background:"#5A9A5A",animation:"blink 2.5s infinite"}}/>
        <span style={{fontSize:10,color:C.dim}}>온라인</span>
      </div>}
      center="나의 소울"
      right={<span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:14,color:mode.color}}>{pct}%</span>}
    />
    <SoulBar pct={pct}/>

    {/* ⑤ 오늘의 테마 배너 */}
    <div style={{padding:"8px 18px",background:`${mode.color}11`,borderBottom:`1px solid ${mode.color}22`,flexShrink:0}}>
      <div style={{maxWidth:480,margin:"0 auto",display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:9,color:mode.color,letterSpacing:".12em",textTransform:"uppercase",flexShrink:0}}>오늘의 테마</span>
        <span style={{fontSize:11,color:C.dim,flex:1}}>{todayTheme.theme} — {todayTheme.question}</span>
      </div>
    </div>

    <div ref={scrollRef} style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"16px 18px"}}>
        {msgs.length===0&&!loading&&<div style={{textAlign:"center",padding:"40px 0"}}>
          <div style={{fontSize:40,marginBottom:12,animation:"float 4s ease-in-out infinite"}}>✨</div>
          <p style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:22,marginBottom:6}}>안녕하세요, {user.nickname}</p>
          <p style={{fontSize:13,color:C.dim,lineHeight:1.7}}>당신의 AI 소울 파트너예요<br/>매일 대화할수록 더 잘 알게 돼요</p>
        </div>}

        {msgs.map((m,i)=>(
          <div key={i} className="mi" style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:12}}>
            <div style={{maxWidth:"78%"}}>
              {m.role==="ai"&&<p style={{fontSize:9,color:C.dim,marginBottom:3}}>소울 ✦</p>}
              <div style={{background:m.role==="user"?C.ink:C.paper,color:m.role==="user"?C.bg:C.ink,padding:"10px 14px",border:`1px solid ${m.role==="user"?C.ink:C.rule}`}}>
                <p style={{fontSize:13,lineHeight:1.75}}>{m.content}</p>
              </div>
            </div>
          </div>
        ))}

        {loading&&streaming&&<div className="mi" style={{display:"flex",justifyContent:"flex-start",marginBottom:12}}>
          <div style={{maxWidth:"78%"}}>
            <p style={{fontSize:9,color:C.dim,marginBottom:3}}>소울 ✦</p>
            <div style={{background:C.paper,padding:"10px 14px",border:`1px solid ${C.rule}`}}>
              <p style={{fontSize:13,lineHeight:1.75}}>{streaming}<span className="cursor"/></p>
            </div>
          </div>
        </div>}
        {loading&&!streaming&&<div style={{display:"flex",gap:4,padding:"8px 0"}}>
          {[0,1,2].map(i=><div key={i} style={{width:5,height:5,borderRadius:"50%",background:C.dim,animation:`spin ${.8+i*.15}s linear infinite`,opacity:.5}}/>)}
        </div>}
      </div>
    </div>

    {/* 팔로업 질문 칩 */}
    {msgs.length>2&&<div style={{padding:"8px 18px",borderTop:`1px solid ${C.rule}`,flexShrink:0}}>
      <div style={{maxWidth:480,margin:"0 auto",display:"flex",gap:6,flexWrap:"wrap"}}>
        {[todayTheme.followup,"더 얘기해줄래요?","어떤 느낌이에요?"].map(q=>(
          <span key={q} onClick={()=>setInput(q)} style={{fontSize:10,color:C.dim,border:`1px solid ${C.rule}`,padding:"5px 10px",cursor:"pointer",background:C.paper,transition:"all .15s"}}>{q}</span>
        ))}
      </div>
    </div>}

    <ABar>
      <input value={input} onChange={e=>setInput(e.target.value)}
        onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&send()}
        placeholder="소울에게 말해봐요..."
        style={{flex:1,background:C.bg,border:`1px solid ${C.rule}`,padding:"11px 13px",fontSize:13,color:C.ink,fontWeight:300,outline:"none",transition:"border .2s"}}
        onFocus={e=>e.target.style.borderColor=C.ink} onBlur={e=>e.target.style.borderColor=C.rule}/>
      <Btn label="전송" onClick={send} disabled={loading||!input.trim()} sm/>
    </ABar>

    <UnlockPopup unlock={unlock} onClose={()=>setUnlock(null)}/>
    <Toast msg={toast} onClose={()=>setToast("")}/>
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: EXPLORE
// ════════════════════════════════════════════════════════
function ExploreScreen({user,myVec,onMatch}) {
  const [users,setUsers] = useState([]);
  const [loading,setLoading] = useState(true);
  const [matchLoading,setMatchLoading] = useState(null);
  const [toast,setToast] = useState({msg:"",type:"info"});
  const pct = user.profile_pct||0;

  useEffect(()=>{ load(); },[]);

  const load = async () => {
    setLoading(true);
    const list = await DB.getUsers(user.id);
    setUsers(list);
    setLoading(false);
  };

  const requestMatch = async (target) => {
    if (pct<20) { setToast({msg:"소울과 더 대화해봐요!\n(프로파일 20% 이상 필요)",type:"error"}); return; }
    setMatchLoading(target.id);
    const tVec = target.soul_vectors?.[0]||{};
    const dyn = await calcMatch(myVec||{}, tVec, user.nickname, target.nickname);
    await DB.createMatch(user.id, target.id, dyn.score, dyn.tier, dyn);
    setToast({msg:`${target.nickname}님께 매칭을 신청했어요! ✦`,type:"success"});
    setMatchLoading(null);
    onMatch();
  };

  return <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    <TNav center="탐색" right={<button onClick={load} style={{fontSize:10,color:C.dim,background:"none",border:"none",cursor:"pointer",letterSpacing:".06em"}}>새로고침</button>}/>
    <div style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"16px 18px"}}>
        {pct<20&&<Glass style={{padding:"13px 14px",marginBottom:16,borderLeft:`3px solid ${C.gold}`}}>
          <p style={{fontSize:12,color:C.ink,lineHeight:1.7}}>소울과 먼저 대화해봐요<br/>대화할수록 더 잘 맞는 사람을 찾아줘요</p>
          <div style={{marginTop:9,height:2,background:C.rule}}><div style={{height:"100%",width:`${pct/20*100}%`,background:C.gold,transition:"width 1s"}}/></div>
          <p style={{fontSize:10,color:C.dim,marginTop:5}}>20%까지 {20-pct}% 남았어요</p>
        </Glass>}

        {loading?<Spin text="소울메이트 탐색 중"/>:<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:16}}>
            <span style={{fontSize:10,color:C.dim,letterSpacing:".16em",textTransform:"uppercase"}}>지금 활동 중</span>
            <span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:13,color:C.dim}}>{users.length}명</span>
          </div>

          {users.length===0?<div style={{textAlign:"center",padding:"44px 0"}}>
            <p style={{fontSize:24,marginBottom:10}}>🌿</p>
            <p style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:20,marginBottom:8}}>아직 다른 사용자가 없어요</p>
            <p style={{fontSize:12,color:C.dim,lineHeight:1.7}}>친구를 초대해봐요</p>
          </div>:users.map(u=>{
            const uVec = u.soul_vectors?.[0]||{};
            const isAI = u.nickname?.startsWith("[소울]");
            return <div key={u.id} style={{marginBottom:11}}>
              <Glass style={{padding:"15px"}}>
                <div style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:11}}>
                  <div style={{position:"relative"}}>
                    <Ava user={u} vec={uVec} size={46}/>
                    {isAI&&<div style={{position:"absolute",bottom:-2,right:-2,width:14,height:14,borderRadius:"50%",background:"#5A9A5A",border:"2px solid #F9F5EF",display:"flex",alignItems:"center",justifyContent:"center"}}>
                      <span style={{fontSize:7,color:"#fff"}}>AI</span>
                    </div>}
                  </div>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                      <span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:19}}>{isAI?u.nickname.replace("[소울]",""):u.nickname}</span>
                      <span style={{fontSize:9,color:C.dim}}>프로파일 {u.profile_pct||0}%</span>
                    </div>
                    {uVec.core_emotion&&<p style={{fontSize:11,color:C.dim,marginBottom:5}}>{uVec.core_emotion} · {ATT_MAP[uVec.attachment]||""} · {LOVE_MAP[uVec.love_lang]||""}</p>}
                    {uVec.fear&&<p style={{fontSize:11,color:C.dim,fontStyle:"italic",marginBottom:7}}>"{ uVec.fear}를 두려워해요"</p>}
                    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                      {(uVec.tags||[]).slice(0,4).map(t=><span key={t} style={{fontSize:9,color:C.dim,border:`1px solid ${C.rule}`,padding:"3px 8px"}}>{t}</span>)}
                    </div>
                  </div>
                </div>
                <Btn label={matchLoading===u.id?"분석 중...":"매칭 신청 ✦"} onClick={()=>requestMatch(u)} disabled={matchLoading===u.id||pct<20} full/>
              </Glass>
            </div>;
          })}
        </>}
      </div>
    </div>
    <Toast msg={toast.msg} type={toast.type} onClose={()=>setToast({msg:"",type:"info"})}/>
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: MATCHES
// ════════════════════════════════════════════════════════
function MatchesScreen({user,myVec,onOpenChat,onOpenSim}) {
  const [matches,setMatches] = useState([]);
  const [loading,setLoading] = useState(true);
  const [toast,setToast] = useState("");

  useEffect(()=>{
    load();
    const unsub = DB.listenMatches(user.id, m=>{
      setMatches(prev=>[m,...prev.filter(x=>x.id!==m.id)]);
      setToast("새 매칭 신청이 들어왔어요! 💌");
    });
    return unsub;
  },[]);

  const load = async () => { setLoading(true); const l=await DB.getMatches(user.id); setMatches(l); setLoading(false); };

  const accept = async (m) => {
    const room = await DB.acceptMatch(m.id);
    if (room) {
      // ④ AI 아이스브레이커 메시지 자동 전송
      const otherVec = {}; // 실제로는 상대방 벡터 불러와야
      const dyn = typeof m.dynamics==="string" ? JSON.parse(m.dynamics||"{}") : m.dynamics||{};
      const icebreaker = await getIcebreaker(myVec||{}, otherVec, user.nickname, "상대방", dyn);
      if (icebreaker) await DB.sendMsg(room.id, "system", `💌 소울이 추천하는 첫 대화: "${icebreaker}"`);
      onOpenChat(m, room);
    }
    load();
  };

  const getDyn = m => { try { return typeof m.dynamics==="string"?JSON.parse(m.dynamics||"{}"):m.dynamics||{}; } catch { return {}; } };

  return <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    <TNav center="매칭" right={<span style={{fontSize:11,color:C.dim}}>{matches.length}개</span>}/>
    <div style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"16px 18px"}}>
        {loading?<Spin text="매칭 불러오는 중"/>:matches.length===0?
          <div style={{textAlign:"center",padding:"48px 0"}}>
            <p style={{fontSize:32,marginBottom:12}}>💌</p>
            <p style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:22,marginBottom:8}}>아직 매칭이 없어요</p>
            <p style={{fontSize:13,color:C.dim,lineHeight:1.7,marginBottom:20}}>탐색 탭에서 마음에 드는 사람에게<br/>매칭을 신청해보세요</p>
          </div>:
          matches.map(m=>{
            const dyn = getDyn(m);
            const isReceiver = m.user_b===user.id;
            return <div key={m.id} style={{marginBottom:11}}>
              <Glass style={{padding:"15px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:11}}>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:17}}>{isReceiver?"나에게 신청":"내가 신청"}</span>
                      <span style={{fontSize:9,color:m.status==="accepted"?C.gold:m.status==="rejected"?"#B83232":C.dim,border:`1px solid ${m.status==="accepted"?C.gold:m.status==="rejected"?"#B83232":C.rule}`,padding:"2px 7px"}}>
                        {m.status==="accepted"?"매칭됨":m.status==="rejected"?"거절됨":"대기중"}
                      </span>
                    </div>
                    {dyn.chemistry&&<p style={{fontSize:11,color:C.dim}}>{dyn.chemistry}</p>}
                  </div>
                  <div style={{textAlign:"right"}}>
                    <span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:28,color:C.gold}}>{m.score}</span>
                    <p style={{fontSize:9,color:C.dim}}>{TIER_MAP[m.tier]||m.tier}</p>
                  </div>
                </div>
                {dyn.tension&&<div style={{padding:"8px 11px",background:"rgba(26,17,8,.03)",marginBottom:11,borderLeft:`2px solid ${C.rule}`}}>
                  <p style={{fontSize:10,color:C.dim}}>긴장 — {dyn.tension}</p>
                  <p style={{fontSize:10,color:C.dim,marginTop:2}}>접착제 — {dyn.glue}</p>
                  {dyn.why&&<p style={{fontSize:10,color:C.dim,marginTop:2}}>분석 — {dyn.why}</p>}
                </div>}
                <div style={{display:"flex",gap:8}}>
                  {m.status==="pending"&&isReceiver&&<>
                    <Btn label="수락 ✦" onClick={()=>accept(m)} full/>
                    <Btn label="거절" onClick={()=>DB.acceptMatch&&load()} ghost full/>
                  </>}
                  {m.status==="accepted"&&<>
                    <Btn label="100년 시뮬" onClick={()=>onOpenSim(m)} ghost full/>
                    <Btn label="채팅 →" onClick={async()=>{ const room=await DB.getRoomByMatch(m.id); if(room)onOpenChat(m,room); }} full/>
                  </>}
                  {m.status==="pending"&&!isReceiver&&<p style={{fontSize:11,color:C.dim,textAlign:"center",padding:"8px 0",width:"100%"}}>상대방의 수락을 기다리고 있어요...</p>}
                </div>
              </Glass>
            </div>;
          })
        }
      </div>
    </div>
    <Toast msg={toast} onClose={()=>setToast("")}/>
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: SIM
// ════════════════════════════════════════════════════════
function SimScreen({match,user,myVec,onBack}) {
  const [stories,setStories] = useState([]);
  const [running,setRunning] = useState(true);
  const [report,setReport] = useState(null);
  const [loaderText,setLoaderText] = useState("이야기 시작 중");
  const [failedAt,setFailedAt] = useState(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(new AbortController());
  const runRef = useRef(true);
  const dyn = typeof match.dynamics==="string" ? JSON.parse(match.dynamics||"{}") : match.dynamics||{};
  const nA = user.nickname, nB = "상대방";
  const vA = myVec||{}, vB = {};

  useEffect(()=>{ run(0,[]); return()=>{runRef.current=false;abortRef.current.abort();}; },[]);
  useEffect(()=>{ scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight,behavior:"smooth"}); },[stories]);

  const run = async (start, history) => {
    for (let i=start; i<STAGES.length; i++) {
      if (!runRef.current||abortRef.current.signal.aborted) return;
      setLoaderText(`${STAGES[i].l} 이야기 쓰는 중`);
      setFailedAt(null);
      setStories(s=>[...s.slice(0,i),{stage:STAGES[i],text:"",idx:i,streaming:true}]);
      try {
        await genStage(STAGES[i],vA,vB,dyn,nA,nB,
          t=>{if(runRef.current)setStories(s=>s.map((x,j)=>j===i?{...x,text:t}:x));},
          abortRef.current.signal
        );
        setStories(s=>s.map((x,j)=>j===i?{...x,streaming:false}:x));
        history.push(STAGES[i].l);
      } catch(e) { if(e.name==="AbortError")return; setFailedAt(i);setRunning(false);return; }
      await new Promise(r=>setTimeout(r,200));
    }
    const rep = await genReport(vA,vB,dyn,nA,nB);
    setReport(rep);
    setRunning(false);
  };

  const retry = () => {
    if (failedAt==null) return;
    abortRef.current=new AbortController(); runRef.current=true;
    setRunning(true); setFailedAt(null);
    run(failedAt, stories.slice(0,failedAt).map(s=>s.stage.l));
  };

  return <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    <TNav
      left={<button onClick={onBack} style={{fontSize:18,color:C.dim,background:"none",border:"none",cursor:"pointer",padding:4}}>←</button>}
      center={`${nA} × ${nB}`}
      right={<span style={{fontSize:9,color:C.dim}}>{stories.length}/{STAGES.length}</span>}
    />
    <div style={{flexShrink:0,height:3,background:C.rule}}>
      <div style={{display:"flex",height:"100%"}}>
        {STAGES.map((_,i)=><div key={i} style={{flex:1,background:i<stories.length?SC[i]:"transparent",transition:"background .5s"}}/>)}
      </div>
    </div>
    <div ref={scrollRef} style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"16px 18px"}}>
        <Glass style={{padding:"11px 13px",marginBottom:16}} gold>
          <p style={{fontSize:8,color:C.gold,letterSpacing:".15em",textTransform:"uppercase",marginBottom:3}}>두 사람의 역학</p>
          <p style={{fontSize:11,color:C.ink}}>{dyn.chemistry||"서로를 알아가는 중"}</p>
          <p style={{fontSize:10,color:C.dim,marginTop:2}}>점수 {match.score} · {TIER_MAP[match.tier]||match.tier}</p>
        </Glass>
        {stories.map(({stage,text,idx,streaming},i)=>(
          <div key={i} className="si" style={{display:"flex",gap:10,marginBottom:16}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:20}}>
              <div style={{width:18,height:18,border:`1px solid ${SC[idx]}66`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:7,color:SC[idx],flexShrink:0}}>{stage.icon}</div>
              {i<stories.length-1&&<div style={{width:1,flex:1,minHeight:8,background:`linear-gradient(${SC[idx]}44,transparent)`,marginTop:2}}/>}
            </div>
            <div style={{flex:1}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:10,color:C.ink,fontWeight:500}}>{stage.l}</span>
                <span style={{fontSize:9,color:C.dim}}>{stage.age}</span>
              </div>
              <p style={{fontSize:12,color:C.dim,lineHeight:1.85,fontWeight:300}}>{text}{streaming&&<span className="cursor"/>}</p>
            </div>
          </div>
        ))}
        {running&&<Spin text={loaderText}/>}
        {failedAt!=null&&!running&&<div style={{textAlign:"center",padding:"16px 0"}}>
          <p style={{fontSize:12,color:C.dim,marginBottom:12}}>{STAGES[failedAt].l} 이야기를 쓰다 오류가 났어요</p>
          <Btn label="이어서 쓰기 →" onClick={retry} sm/>
        </div>}
        {report&&<>
          <div style={{marginTop:8,padding:18,background:C.ink,color:C.bg}}>
            <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:12}}>
              <span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:34,color:C.gold}}>{match.score}</span>
              <span style={{fontSize:11,color:"rgba(249,245,239,.6)"}}>/ 100 · {TIER_MAP[match.tier]||match.tier}</span>
            </div>
            <p style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:17,marginBottom:8}}>"{report.title}"</p>
            <p style={{fontSize:11,color:"rgba(249,245,239,.7)",marginBottom:14,lineHeight:1.7}}>{report.why_works}</p>
            <p style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:14,color:"rgba(249,245,239,.85)"}}>"{report.message}"</p>
          </div>
          {/* ⑥ 바이럴 공유 */}
          <div style={{marginTop:10,padding:"15px",border:`1px solid ${C.rule}`,background:C.paper}}>
            <p style={{fontSize:12,color:C.dim,marginBottom:8}}>"{report.share_quote}"</p>
            <Btn label="결과 공유하기 ↗" onClick={()=>{
              const text=`AI가 분석한 나와 ${nB}의 100년\n${match.tier} · ${match.score}점\n"${report.title}"\n\nsoulscope.ai에서 나도 해보기 →`;
              navigator.share?navigator.share({title:"Soulscope",text}).catch(()=>{}):navigator.clipboard?.writeText(text).then(()=>alert("복사됐어요!"));
            }} full/>
          </div>
        </>}
      </div>
    </div>
    {!running&&report&&<ABar><Btn label="채팅으로 이어가기 →" onClick={onBack} full/></ABar>}
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: CHAT ④
// ════════════════════════════════════════════════════════
function ChatScreen({user,match,room,onBack}) {
  const [msgs,setMsgs] = useState([]);
  const [input,setInput] = useState("");
  const [loading,setLoading] = useState(false);
  const scrollRef = useRef(null);
  const dyn = typeof match.dynamics==="string" ? JSON.parse(match.dynamics||"{}") : match.dynamics||{};

  useEffect(()=>{
    load();
    const unsub = DB.listenMsgs(room.id, m=>{
      setMsgs(prev=>[...prev.filter(x=>x.id!==m.id),m].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)));
    });
    return unsub;
  },[]);

  useEffect(()=>{ scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight,behavior:"smooth"}); },[msgs]);

  const load = async () => { const m=await DB.getMsgs(room.id); setMsgs(m); };

  const send = async () => {
    if (!input.trim()||loading) return;
    const txt=input; setInput(""); setLoading(true);
    await DB.sendMsg(room.id, user.id, txt);
    setLoading(false);
  };

  const isSystem = id => id==="system";
  const isMe = id => id===user.id;

  return <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    <TNav
      left={<button onClick={onBack} style={{fontSize:18,color:C.dim,background:"none",border:"none",cursor:"pointer",padding:4}}>←</button>}
      center="채팅"
      right={<span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:12,color:C.gold}}>{match.score}점</span>}
    />
    {dyn.chemistry&&<div style={{padding:"8px 18px",background:C.paper,borderBottom:`1px solid ${C.rule}`,flexShrink:0}}>
      <p style={{fontSize:11,color:C.dim,textAlign:"center"}}>{dyn.chemistry} · {TIER_MAP[match.tier]||match.tier}</p>
    </div>}
    <div ref={scrollRef} style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"16px 18px"}}>
        {msgs.map((m,i)=>{
          if (isSystem(m.sender_id)) return (
            <div key={m.id||i} style={{textAlign:"center",margin:"10px 0",padding:"8px 14px",background:`${C.gold}18`,border:`1px solid ${C.gold}33`}}>
              <p style={{fontSize:11,color:C.dim,lineHeight:1.6}}>{m.content}</p>
            </div>
          );
          return <div key={m.id||i} className="mi" style={{display:"flex",justifyContent:isMe(m.sender_id)?"flex-end":"flex-start",marginBottom:10}}>
            <div style={{maxWidth:"78%"}}>
              <div style={{background:isMe(m.sender_id)?C.ink:C.paper,color:isMe(m.sender_id)?C.bg:C.ink,padding:"10px 14px",border:`1px solid ${isMe(m.sender_id)?C.ink:C.rule}`}}>
                <p style={{fontSize:13,lineHeight:1.7}}>{m.content}</p>
              </div>
              <p style={{fontSize:9,color:C.dim,marginTop:2,textAlign:isMe(m.sender_id)?"right":"left"}}>
                {new Date(m.created_at).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})}
              </p>
            </div>
          </div>;
        })}
        {msgs.length===0&&<div style={{textAlign:"center",padding:"32px 0"}}>
          <p style={{fontSize:22,marginBottom:10}}>💌</p>
          <p style={{fontSize:12,color:C.dim,lineHeight:1.7}}>첫 번째 메시지를 보내봐요</p>
        </div>}
      </div>
    </div>
    <ABar>
      <input value={input} onChange={e=>setInput(e.target.value)}
        onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&send()}
        placeholder="메시지 입력..."
        style={{flex:1,background:C.bg,border:`1px solid ${C.rule}`,padding:"11px 13px",fontSize:13,color:C.ink,fontWeight:300,outline:"none",transition:"border .2s"}}
        onFocus={e=>e.target.style.borderColor=C.ink} onBlur={e=>e.target.style.borderColor=C.rule}/>
      <Btn label="전송" onClick={send} disabled={!input.trim()} sm/>
    </ABar>
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: ME ③
// ════════════════════════════════════════════════════════
function MeScreen({user,vec,onUpdate}) {
  const [editing,setEditing] = useState(false);
  const [bio,setBio] = useState(user.bio||"");
  const [saving,setSaving] = useState(false);
  const pct = user.profile_pct||0;
  const mode = getSoulMode(pct);
  const unlocks = getUnlocks(pct);
  const nextUnlock = getUnlocks(100).find(u=>!unlocks.includes(u));

  const save = async () => {
    setSaving(true);
    await DB.updateUser(user.id,{bio});
    onUpdate({...user,bio});
    setEditing(false); setSaving(false);
  };

  return <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    <TNav center="나의 소울" left={<span/>}/>
    <div style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"22px 18px"}}>
        {/* 프로파일 헤더 */}
        <div className="a1" style={{display:"flex",alignItems:"center",gap:13,marginBottom:20}}>
          <Ava user={user} vec={vec} size={54}/>
          <div>
            <h2 style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:23,marginBottom:3}}>{user.nickname}</h2>
            <p style={{fontSize:11,color:mode.color}}>{mode.label} · {pct}%</p>
          </div>
        </div>

        {/* 소울 모드 + 진행 */}
        <div style={{padding:"14px 16px",background:`${mode.color}11`,border:`1px solid ${mode.color}33`,marginBottom:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9}}>
            <span style={{fontSize:10,color:mode.color,letterSpacing:".12em",textTransform:"uppercase",fontWeight:500}}>{mode.mode} 모드</span>
            <span style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:18,color:mode.color}}>{pct}%</span>
          </div>
          <div style={{height:3,background:"rgba(26,17,8,.08)",borderRadius:2}}>
            <div style={{height:"100%",width:`${pct}%`,background:mode.color,transition:"width 1s",borderRadius:2}}/>
          </div>
          <p style={{fontSize:11,color:C.dim,marginTop:8,lineHeight:1.6}}>{mode.desc}</p>
        </div>

        {/* ③ 언락 목록 */}
        <div style={{marginBottom:18}}>
          <p style={{fontSize:9,color:C.dim,letterSpacing:".15em",textTransform:"uppercase",marginBottom:12}}>해금된 기능</p>
          {unlocks.length===0?<p style={{fontSize:12,color:C.dim}}>소울과 대화를 시작해봐요</p>:
            unlocks.map((u,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:`1px solid ${C.rule}`}}>
              <span style={{fontSize:16}}>{u.icon}</span>
              <div><p style={{fontSize:12,color:C.ink,fontWeight:400}}>{u.label}</p><p style={{fontSize:10,color:C.dim}}>{u.desc}</p></div>
              <div style={{marginLeft:"auto",width:16,height:16,borderRadius:"50%",background:C.gold,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <span style={{fontSize:9,color:C.bg}}>✓</span>
              </div>
            </div>)
          }
          {pct<100&&<div style={{marginTop:10,padding:"11px 13px",border:`1px dashed ${C.rule}`,opacity:.6}}>
            <p style={{fontSize:11,color:C.dim}}>다음 단계까지 {20-pct%20}% 남았어요</p>
          </div>}
        </div>

        {/* AI 분석 */}
        {vec?.core_emotion&&<>
          {rule}
          <div className="a2" style={{padding:"16px 0"}}>
            <p style={{fontSize:9,color:C.dim,letterSpacing:".15em",textTransform:"uppercase",marginBottom:13}}>AI가 파악한 나</p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9,marginBottom:11}}>
              {[["핵심 감정",vec.core_emotion],["애착 유형",ATT_MAP[vec.attachment]||vec.attachment],["갈등 방식",CONF_MAP[vec.conflict]||vec.conflict],["사랑 언어",LOVE_MAP[vec.love_lang]||vec.love_lang]].filter(([,v])=>v).map(([k,v])=>(
                <Glass key={k} style={{padding:"11px 13px"}}>
                  <p style={{fontSize:8,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:4}}>{k}</p>
                  <p style={{fontSize:13,color:C.ink}}>{v}</p>
                </Glass>
              ))}
            </div>
            {vec.fear&&<Glass style={{padding:"12px 14px",marginBottom:9,borderLeft:`3px solid ${C.gold}`}}>
              <p style={{fontSize:8,color:C.gold,letterSpacing:".1em",textTransform:"uppercase",marginBottom:4}}>내가 두려워하는 것</p>
              <p style={{fontSize:13,color:C.ink}}>"{vec.fear}"</p>
            </Glass>}
            {vec.shine&&<Glass style={{padding:"12px 14px"}}>
              <p style={{fontSize:8,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:4}}>내가 빛나는 순간</p>
              <p style={{fontSize:13,color:C.ink}}>"{vec.shine}"</p>
            </Glass>}
          </div>
        </>}

        {/* 소개 */}
        {rule}
        <div style={{padding:"16px 0"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <p style={{fontSize:9,color:C.dim,letterSpacing:".15em",textTransform:"uppercase"}}>한 줄 소개</p>
            {!editing&&<button onClick={()=>setEditing(true)} style={{fontSize:10,color:C.dim,background:"none",border:"none",cursor:"pointer"}}>편집</button>}
          </div>
          {editing?(
            <><textarea value={bio} onChange={e=>setBio(e.target.value)} rows={3}
              style={{width:"100%",background:C.bg,border:`1px solid ${C.ink}`,padding:"11px 13px",fontSize:13,color:C.ink,lineHeight:1.7,marginBottom:9}}/>
              <div style={{display:"flex",gap:8}}>
                <Btn label={saving?"저장 중...":"저장"} onClick={save} disabled={saving} full/>
                <Btn label="취소" onClick={()=>setEditing(false)} ghost full/>
              </div></>
          ):(
            <p style={{fontSize:13,color:bio?C.ink:C.dim,lineHeight:1.7}}>{bio||"아직 소개가 없어요"}</p>
          )}
        </div>
      </div>
    </div>
  </div>;
}

// ════════════════════════════════════════════════════════
// ROOT APP
// ════════════════════════════════════════════════════════
export default function App() {
  const [screen,setScreen] = useState("loading");
  const [user,setUser] = useState(null);
  const [vec,setVec] = useState({});
  const [tab,setTab] = useState("soul");
  const [chatState,setChatState] = useState(null);
  const [simMatch,setSimMatch] = useState(null);
  const [pendingCount,setPendingCount] = useState(0);

  useEffect(()=>{ init(); },[]);

  const init = async () => {
    const sess = loadSess();
    if (sess?.userId) {
      try {
        const u = await DB.getUser(sess.userId);
        if (u) {
          setUser(u);
          const v = await DB.getVector(u.id);
          setVec(v||{});
          // 대기 매칭 수 로드
          const m = await DB.getMatches(u.id);
          setPendingCount(m.filter(x=>x.status==="pending"&&x.user_b===u.id).length);
          setScreen("main"); return;
        }
      } catch {}
    }
    setScreen("join");
  };

  const onJoin = async (u) => {
    setUser(u); setVec({});
    await DB.upsertVector(u.id,{emoji:"✨",color:C.gold,tags:[]});
    setScreen("main");
  };

  const openChat = (match,room) => { setChatState({match,room}); setTab("chat"); };
  const openSim = (match) => { setSimMatch(match); setTab("sim"); };

  const setTabSafe = (t) => {
    if (t==="chat"&&!chatState) { setTab("matches"); return; }
    setSimMatch(null); setTab(t);
  };

  const updatePct = (newPct) => {
    setUser(u => ({...u, profile_pct:newPct}));
  };

  if (screen==="loading") return (
    <div style={{background:C.bg,height:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <style>{CSS}</style>
      <div style={{textAlign:"center"}}>
        <p style={{fontFamily:"'Cormorant',serif",fontStyle:"italic",fontSize:28,marginBottom:16,color:C.ink}}>Soulscope</p>
        <Spin/>
      </div>
    </div>
  );

  if (screen==="join") return (
    <div style={{background:C.bg,height:"100vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
      <style>{CSS}</style>
      <JoinScreen onDone={onJoin}/>
    </div>
  );

  return (
    <div style={{background:C.bg,height:"100vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
      <style>{CSS}</style>
      <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
        {tab==="soul"&&<SoulScreen user={user} vec={vec}
          onVecUpdate={v=>setVec(v)}
          onPctChange={updatePct}/>}
        {tab==="explore"&&<ExploreScreen user={user} myVec={vec} onMatch={()=>setTab("matches")}/>}
        {tab==="matches"&&!simMatch&&<MatchesScreen user={user} myVec={vec} onOpenChat={openChat} onOpenSim={openSim}/>}
        {tab==="matches"&&simMatch&&<SimScreen match={simMatch} user={user} myVec={vec} onBack={()=>setSimMatch(null)}/>}
        {tab==="chat"&&chatState&&<ChatScreen user={user} match={chatState.match} room={chatState.room} onBack={()=>setTab("matches")}/>}
        {tab==="chat"&&!chatState&&<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12}}>
          <p style={{fontSize:22}}>💬</p>
          <p style={{fontSize:13,color:C.dim}}>매칭 후 채팅이 시작돼요</p>
          <Btn label="매칭 탭으로 →" onClick={()=>setTab("matches")} sm/>
        </div>}
        {tab==="me"&&<MeScreen user={user} vec={vec} onUpdate={u=>{setUser(u);saveSess({...loadSess(),userId:u.id});}}/>}
      </div>
      <BNav tab={simMatch?"matches":tab} set={setTabSafe} matchCount={pendingCount}/>
    </div>
  );
}
