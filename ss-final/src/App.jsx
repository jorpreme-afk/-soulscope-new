import React, { useState, useEffect, useRef, useCallback } from "react";

// ════════════════════════════════════════════════════════
// SUPABASE
// ════════════════════════════════════════════════════════
// ② 환경변수로 분리 — .env.local에 VITE_SUPABASE_URL, VITE_SUPABASE_KEY 설정
// Vercel 배포시엔 vercel.json에 env 추가 또는 대시보드에서 설정
const SB_URL = import.meta.env.VITE_SUPABASE_URL || ""; // L. 환경변수 필수
const SB_KEY = import.meta.env.VITE_SUPABASE_KEY || ""; // L. 환경변수 필수 — .env 설정 필요

async function sb(table, method="GET", body=null, query="", retry=2) {
  for (let i=0; i<=retry; i++) {
    const ctrl = new AbortController();
    const tid = setTimeout(()=>ctrl.abort(), 9000); // K. 9초 timeout
    try {
      const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, {
        method,
        signal: ctrl.signal,
        headers: {
          "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
          "Content-Type": "application/json", "Prefer": "return=representation",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      clearTimeout(tid);
      const text = await r.text();
      if (!r.ok) throw new Error(text);
      return text ? JSON.parse(text) : null;
    } catch(e) {
      clearTimeout(tid);
      log(`DB [${i+1}/${retry+1}]:`, e.message);
      if (i < retry && (e.name==="AbortError" || e.message.includes("fetch") || e.message.includes("network"))) {
        await new Promise(r=>setTimeout(r, 800*(i+1)));
        continue;
      }
      return null;
    }
  }
  return null;
}


// ⑩ 네트워크 상태 감지
let _isOnline = navigator.onLine;
window.addEventListener("online",  ()=>{ _isOnline=true;  });
window.addEventListener("offline", ()=>{ _isOnline=false; });
function isOnline() { return _isOnline; }

function sbListen(table, filter, onRow) {
  // ⑦ 자동 재연결 — 최대 5회, 지수 백오프
  let ws = null;
  let retries = 0;
  let stopped = false;
  let retryTimer = null;

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(`${SB_URL}/realtime/v1/websocket?apikey=${SB_KEY}&vsn=1.0.0`);
      const ref = Date.now().toString();
      ws.onopen = () => {
        retries = 0;
        ws.send(JSON.stringify({
          topic: `realtime:public:${table}${filter?`:${filter}`:""}`,
          event: "phx_join", payload: { config: { broadcast: { self: true } } }, ref,
        }));
      };
      ws.onmessage = e => {
        try {
          const m = JSON.parse(e.data);
          if (["INSERT","UPDATE"].includes(m.event)) onRow(m.payload?.record);
        } catch {}
      };
      ws.onclose = () => {
        if (stopped || retries >= 5) return;
        retries++;
        const delay = Math.min(1000 * Math.pow(2, retries), 30000);
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {};
    } catch {}
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    ws?.close();
  };
}

const DB = {
  async createUser(nick, pin) {
    let pinHash = null;
    if (pin) {
      try {
        const r = await fetch(API, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({_action:"hash_pin", pin, nick}),
        });
        const d = await r.json();
        pinHash = d.hash || null;
      } catch { pinHash = null; }
    }
    return (await sb("users","POST",{nickname:nick,profile_pct:0,pin_hash:pinHash}))?.[0]||null;
  },
  // 소셜 로그인 — provider + provider_id로 기존 계정 찾거나 생성
  async getOrCreateSocialUser(provider, providerId, nickname) {
    // 기존 소셜 계정 있으면 반환
    const existing = await sb("users","GET",null,
      `?social_provider=eq.${provider}&social_id=eq.${encodeURIComponent(providerId)}&select=*`
    );
    if(existing?.[0]) return existing[0];
    // 없으면 생성
    return (await sb("users","POST",{
      nickname, profile_pct:0,
      social_provider:provider,
      social_id:providerId,
    }))?.[0]||null;
  },
  async getUser(id) {
    return (await sb("users","GET",null,`?id=eq.${id}&select=*,soul_vectors(*)`))?.[0]||null;
  },
  async getUserByNick(nick) {
    return (await sb("users","GET",null,`?nickname=eq.${encodeURIComponent(nick)}&select=*,soul_vectors(*)`))?.[0]||null;
  },
  async verifyPin(userId, pin) {
    // ① Rate limiting — PIN 시도 횟수 제한 (localStorage 기반)
    const rlKey = `pin_attempts_${userId}`;
    let rlData={count:0,until:0};try{rlData=JSON.parse(localStorage.getItem(rlKey)||'{"count":0,"until":0}');}catch{}
    if (Date.now() < rlData.until) {
      const remaining = Math.ceil((rlData.until - Date.now()) / 1000);
      throw new Error(`잠시 후 시도해요 (${remaining}초 후)`);
    }

    const u = await sb("users","GET",null,`?id=eq.${userId}&select=pin_hash,nickname`);
    if (!u?.[0] || !u[0].pin_hash) return false;
    try {
      const r = await fetch(API, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({_action:"verify_pin", pin, nick:u[0].nickname, stored_hash:u[0].pin_hash}),
      });
      const d = await r.json();
      if (d.ok) {
        localStorage.removeItem(rlKey); // 성공시 초기화
        return true;
      }
      // 실패 카운트 증가
      const newCount = rlData.count + 1;
      const lockMs = newCount >= 5 ? 300000 : newCount >= 3 ? 60000 : 0; // 5회=5분, 3회=1분
      localStorage.setItem(rlKey, JSON.stringify({count:newCount, until:lockMs?Date.now()+lockMs:0}));
      return false;
    } catch(e) { throw e; }
  },
  async updateUser(id, data) {
    if(!data||!Object.keys(data).length)return null; // 빈 PATCH 방어
    return (await sb("users","PATCH",{...data,last_active:new Date().toISOString()},`?id=eq.${id}`))?.[0]||null;
  },
    return (await sb("soul_vectors","GET",null,`?user_id=eq.${uid}`))?.[0]||null;
  },
  async upsertVector(uid, vec, lastActive=null) {
    const pct = calcPct(vec, lastActive);
    // _narrative는 DB 컬럼 없음 — 제외하고 저장
    const {_narrative, ...vecToSave} = vec;
    await sb("soul_vectors","POST",{...vecToSave,user_id:uid,updated_at:new Date().toISOString()},"?on_conflict=user_id");
    await sb("users","PATCH",{profile_pct:pct},`?id=eq.${uid}`);
    return pct;
  },
  async saveChat(uid, role, content) {
    // ② 저장 실패시 1회 재시도
    let result = (await sb("soul_chats","POST",{user_id:uid,role,content}))?.[0]||null;
    if(!result){
      await new Promise(r=>setTimeout(r,800));
      result = (await sb("soul_chats","POST",{user_id:uid,role,content}))?.[0]||null;
    }
    return result;
  },
  // ④ 대화 내역 최근순으로 불러오기
  async getChats(uid, limit=100) {
    return await sb("soul_chats","GET",null,
      `?user_id=eq.${uid}&order=created_at.asc&limit=${limit}`) || [];
  },
  async getRecentChats(uid, limit=20) {
    const rows = await sb("soul_chats","GET",null,
      `?user_id=eq.${uid}&order=created_at.desc&limit=${limit}`) || [];
    return rows.reverse();
  },
  async getMatchableUsers(excludeId, excludeIds=[], filters={}) {
    let query = `?id=neq.${excludeId}&profile_pct=gte.10&order=last_active.desc&limit=60&select=*,soul_vectors(*)`;
    // 지역 필터
    if(filters.region) query += `&region=eq.${encodeURIComponent(filters.region)}`;
    // 나이 필터 (birth_year 기반)
    if(filters.minAge) {
      const maxYear = new Date().getFullYear() - filters.minAge;
      query += `&birth_year=lte.${maxYear}`;
    }
    if(filters.maxAge) {
      const minYear = new Date().getFullYear() - filters.maxAge;
      query += `&birth_year=gte.${minYear}`;
    }
    // 성별 필터
    if(filters.gender) query += `&gender=eq.${filters.gender}`;
    const all = await sb("users","GET",null,query) || [];
    return all.filter(u=>!excludeIds.includes(u.id));
  },
  // ① 콜드스타트 더미 유저 확인
  async getDummyUsers() {
    return await sb("users","GET",null,`?nickname=like.*%5BAI%5D*&select=*,soul_vectors(*)`) || [];
  },
  // ① 백그라운드 큐 — 매칭 작업 등록
  async queueMatch(userAId, userBId) {
    return (await sb("match_queue","POST",{
      user_a: userAId, user_b: userBId,
      status: "queued",
      created_at: new Date().toISOString(),
    }))?.[0]||null;
  },
  async getQueue(uid) {
    return await sb("match_queue","GET",null,
      `?or=(user_a.eq.${uid},user_b.eq.${uid})&order=created_at.desc&limit=10`) || [];
  },
  // ③ 거절 후 재매칭 방지
  async getRejectedMatches(uid) {
    const rows = await sb("persona_matches","GET",null,
      `?or=(user_a.eq.${uid},user_b.eq.${uid})&status=eq.rejected&select=user_a,user_b`) || [];
    return rows.map(r => r.user_a===uid ? r.user_b : r.user_a);
  },
  async savePersonaMatch(data) {
    return (await sb("persona_matches","POST",data,"?on_conflict=user_a,user_b"))?.[0]||null;
  },
  async getPersonaMatches(uid, limit=50) {
    return (await sb("persona_matches","GET",null,
      `?or=(user_a.eq.${uid},user_b.eq.${uid})&order=created_at.desc&limit=${limit}&select=*`)) || [];
  },
  async updatePersonaMatch(id, data) {
    if(!id) return null; // FIX8: ID 없으면 전체 PATCH 방지
    return (await sb("persona_matches","PATCH",data,`?id=eq.${id}`))?.[0]||null;
  },
  async getPersonaMatchBetween(aId, bId) {
    const [a,b] = [aId,bId].sort();
    return (await sb("persona_matches","GET",null,`?user_a=eq.${a}&user_b=eq.${b}&select=*`))?.[0]||null;
  },
  // ⑤ 읽음 처리
  async markRead(matchId) {
    await sb("persona_matches","PATCH",{read_at:new Date().toISOString()},`?id=eq.${matchId}`);
  },
  async createChatRoom(matchId) {
    // ⑥ 이미 있으면 기존 것 반환 (중복 방지)
    const existing = await this.getChatRoom(matchId);
    if (existing) return existing;
    return (await sb("chat_rooms","POST",{match_id:matchId},"?on_conflict=match_id"))?.[0]||null;
  },
  async getChatRoom(matchId) {
    return (await sb("chat_rooms","GET",null,`?match_id=eq.${matchId}`))?.[0]||null;
  },
  async sendMsg(roomId, senderId, content) {
    if(!content||!String(content).trim()) return null; // FIX1: 빈 메시지 방지
    return (await sb("messages","POST",{room_id:roomId,sender_id:senderId,content:String(content).trim()}))?.[0]||null;
  },
  async getMsgs(roomId) {
    return await sb("messages","GET",null,
      `?room_id=eq.${roomId}&order=created_at.asc&limit=100`) || [];
  },
  // ⑥ 채팅 상대방 정보
  async getUsersByIds(ids) {
    if (!ids.length) return [];
    return await sb("users","GET",null,
      `?id=in.(${ids.join(",")})&select=id,nickname,soul_vectors(emoji,color)`) || [];
  },
  listenMsgs(roomId, cb) { return sbListen("messages",`room_id=eq.${roomId}`,cb); },
  listenPersonaMatches(uid, cb) {
    // ⑦ 양방향 — user_a(내가 시작)와 user_b(상대가 시작) 둘 다 구독
    const unsubA = sbListen("persona_matches",`user_a=eq.${uid}`,cb);
    const unsubB = sbListen("persona_matches",`user_b=eq.${uid}`,cb);
    return ()=>{ unsubA(); unsubB(); };
  },
  // ④ soul_chats 멀티기기 동기화
  listenSoulChats(uid, cb) { return sbListen("soul_chats",`user_id=eq.${uid}`,cb); },
};

function calcPct(vec, lastActive=null) {
  const f = ["core_emotion","attachment","conflict","love_lang","fear","shine","voice","pattern"];
  const fieldScore = Math.floor(f.filter(k=>vec[k]).length/f.length*60);
  const confScore  = Math.floor(Math.min(vec.confidence||0, 100)*0.25);
  const tagScore   = Math.min((vec.tags?.length||0)*3, 15);
  const base = Math.min(100, fieldScore + confScore + tagScore);

  // ③ 페르소나 퇴화 — 미접속 일수에 따라 감소
  if(lastActive){
    const daysSince = Math.floor((Date.now()-new Date(lastActive).getTime()) / 86400000);
    if(daysSince >= 7)  return Math.max(base - 15, Math.floor(base*0.7));  // 7일: -15%
    if(daysSince >= 3)  return Math.max(base - 5,  Math.floor(base*0.92)); // 3일: -5%
  }
  return base;
}

// 퇴화 상태 메시지
function getDecayInfo(lastActive){
  if(!lastActive)return null;
  const days=Math.floor((Date.now()-new Date(lastActive).getTime())/86400000);
  if(days>=7)return{msg:"페르소나가 많이 흐려졌어요",color:ERROR_COLOR,urgent:true};
  if(days>=3)return{msg:`${days}일째 소울을 만나지 않았어요`,color:"#B8915A",urgent:false};
  return null;
}

// ════════════════════════════════════════════════════════
// CLAUDE API
// ════════════════════════════════════════════════════════
const API = "/api/claude";
// 7. 개발 환경에서만 로그
const DEV = import.meta.env.DEV;
const log = (...args) => { if(DEV) log(...args); };
// 비용 최적화 — 대화는 Haiku, 분석/매칭은 Sonnet
const MODEL_CHAT   = "claude-haiku-4-5-20251001";  // 소울 일상 대화 (10배 저렴)
const MODEL_BRAIN  = "claude-sonnet-4-20250514";   // 벡터 분석 + 매칭 리포트

// ② 소울 폴백 — 질문 아닌 자연스러운 반응
const FALLBACKS = [
  "그거 진짜 힘드셨겠다.",
  "맞아요. 그 느낌 알 것 같아요.",
  "그 말이 좀 마음에 남네요.",
  "쉽지 않은 상황이었네요.",
  "그렇게 느끼는 게 당연해요.",
  "오래 혼자 담아온 것 같네요.",
  "그 경험이 지금도 영향을 주고 있군요.",
];

async function ai(sys, usr, max=500, signal=null, model=MODEL_BRAIN) {
  for (let i=0; i<=2; i++) {
    try {
      const r = await fetch(API, {
        method:"POST", signal,
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({model,max_tokens:max,system:sys,messages:[{role:"user",content:usr}]}),
      });
      if (!r.ok) { if(r.status>=500&&i<2){await sleep(700*(i+1));continue;} throw new Error(r.status); }
      return (await r.json()).content?.map(b=>b.text||"").join("") || "";
    } catch(e) { if(e.name==="AbortError")throw e; if(i===2)return ""; await sleep(700*(i+1)); }
  }
  return "";
}

async function aiStream(sys, usr, max=180, onChunk, signal=null, model=MODEL_CHAT) {
  try {
    const r = await fetch(API, {
      method:"POST", signal,
      headers:{"Content-Type":"application/json"},
        body: JSON.stringify({model,max_tokens:max,system:sys,messages:[{role:"user",content:usr}],stream:true}),
    });
    if (!r.ok) throw new Error(r.status);
    const reader=r.body.getReader(); const dec=new TextDecoder(); let full="";
    while (true) {
      const {done,value}=await reader.read(); if(done)break;
      for (const line of dec.decode(value).split("\n").filter(l=>l.startsWith("data: "))) {
        const d=line.slice(6); if(d==="[DONE]")continue;
        try { const t=JSON.parse(d).delta?.text||""; if(t){full+=t;onChunk(full);} } catch {}
      }
    }
    return full;
  } catch(e) {
    if(e.name==="AbortError")throw e;
    const r=await ai(sys,usr,max,signal,model);
    if(r){onChunk(r);return r;}
    const fb=FALLBACKS[Math.floor(Math.random()*FALLBACKS.length)];
    onChunk(fb); return fb;
  }
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ════════════════════════════════════════════════════════
// 소울 모드 시스템
// ════════════════════════════════════════════════════════
const SOUL_MODES = [
  {pct:0,  mode:"탐색", label:"처음 만남",    desc:"서로 알아가는 중",    color:SC_EXPLORE},
  {pct:20, mode:"연결", label:"연결되는 중",   desc:"패턴이 보여요",       color:SC_CONNECT},
  {pct:40, mode:"심화", label:"깊어지는 중",   desc:"숨겨진 면이 보여요",  color:SC_DEEPEN},
  {pct:60, mode:"각성", label:"자기 발견",     desc:"진짜 나를 알아가요",  color:SC_AWAKEN},
  {pct:80, mode:"완성", label:"페르소나 완성", desc:"당신을 완전히 알아요", color:SC_COMPLETE},
];

function getSoulMode(pct) {
  return [...SOUL_MODES].reverse().find(m=>pct>=m.pct)||SOUL_MODES[0];
}

const DAILY_THEMES = [
  {theme:"감정",q:"오늘 하루 어떤 감정이 가장 컸어요?",f:"그 감정, 자주 느끼는 편이에요?"},
  {theme:"관계",q:"최근에 누군가한테 고마웠던 적 있어요?",f:"그 사람한테 표현했어요?"},
  {theme:"두려움",q:"요즘 가장 피하고 싶은 게 있어요?",f:"왜 그게 무서운 것 같아요?"},
  {theme:"꿈",q:"10년 후 어떤 하루를 살고 싶어요?",f:"그 하루에 옆에 있는 사람은?"},
  {theme:"상처",q:"연애에서 가장 힘들었던 순간이 언제예요?",f:"그때 뭐가 있었으면 달랐을 것 같아요?"},
  {theme:"행복",q:"가장 최근에 진짜 웃었던 게 언제예요?",f:"그 순간에 누가 있었어요?"},
  {theme:"패턴",q:"좋아하는 사람 생기면 어떻게 돼요?",f:"그 패턴, 스스로도 알고 있었어요?"},
  {theme:"연결",q:"누군가랑 진짜 통한다는 느낌 받아본 적 있어요?",f:"그게 언제였어요?"},
  {theme:"경계",q:"싫다고 말하기 어려운 순간이 있어요?",f:"그때 어떻게 했어요?"},
  {theme:"기대",q:"연애에서 가장 기대하는 게 뭐예요?",f:"그 기대, 말로 표현해본 적 있어요?"},
  {theme:"고독",q:"혼자 있을 때 편한 편이에요 아니면 불편한 편이에요?",f:"그 이유가 뭔 것 같아요?"},
  {theme:"성장",q:"최근에 나 자신이 달라졌다고 느낀 적 있어요?",f:"어떤 부분이 달라진 것 같아요?"},
  {theme:"신뢰",q:"상대방을 완전히 믿기까지 얼마나 걸리는 편이에요?",f:"그 믿음, 어떻게 생기는 것 같아요?"},
  {theme:"표현",q:"감정을 말로 표현하는 게 쉬운 편이에요?",f:"표현 못 해서 후회한 적 있어요?"},
  {theme:"갈등",q:"누군가랑 다퉜을 때 어떻게 해요?",f:"그 방식이 효과적이라고 느껴요?"},
  {theme:"안정",q:"마음이 가장 편안한 순간이 언제예요?",f:"그 순간을 자주 만들려고 하는 편이에요?"},
  {theme:"설렘",q:"마지막으로 설렜던 게 언제예요?",f:"설렘이랑 불안, 어떻게 달라요?"},
  {theme:"이별",q:"이별 후 가장 오래 남는 감정이 뭐예요?",f:"그게 지금도 영향을 주나요?"},
  {theme:"가치관",q:"연애에서 절대 타협 못 하는 게 있어요?",f:"그게 왜 중요한 것 같아요?"},
  {theme:"시간",q:"연인이랑 하루에 얼마나 연락하는 게 편해요?",f:"상대방도 같은 걸 원하면 좋겠어요?"},
  {theme:"기억",q:"연애 중 가장 소중한 기억이 뭐예요?",f:"그 기억에서 뭐가 특별했어요?"},
  {theme:"변화",q:"좋아하는 사람 때문에 내가 바뀐 적 있어요?",f:"그 변화가 좋았어요?"},
  {theme:"용기",q:"용기 내서 말했는데 잘 됐던 적 있어요?",f:"그때 어떻게 용기를 냈어요?"},
  {theme:"취약함",q:"약한 모습을 보여준 적 있어요?",f:"그때 상대방은 어떻게 반응했어요?"},
  {theme:"공간",q:"혼자만의 시간이 얼마나 필요한 편이에요?",f:"그게 관계에 영향을 준 적 있어요?"},
  {theme:"직관",q:"첫인상이 맞았던 적이 더 많아요 틀렸던 적이 더 많아요?",f:"그 직관, 어디서 오는 것 같아요?"},
  {theme:"언어",q:"사랑한다는 말, 자주 하는 편이에요?",f:"말이랑 행동 중 어느 쪽이 더 진심 같아요?"},
  {theme:"미래",q:"5년 후 어떤 관계 안에 있고 싶어요?",f:"지금이랑 얼마나 달라요?"},
  {theme:"실수",q:"관계에서 가장 후회하는 게 뭐예요?",f:"지금이라면 어떻게 할 것 같아요?"},
  {theme:"현재",q:"지금 이 순간 가장 원하는 게 뭐예요?",f:"그걸 말하기 어려운 이유가 있어요?"},
];

// P6: KST 날짜 헬퍼 — toDateString 대체
// 4. AI prefix — UI에서 제거 (배지로 따로 표시)

// 상대 날짜 표시 (오늘/어제/N일 전)
function relativeDate(dateStr){
  if(!dateStr)return"";
  const d=new Date(dateStr);
  const now=new Date();
  const diff=Math.floor((now-d)/86400000);
  if(diff===0)return"오늘";
  if(diff===1)return"어제";
  if(diff<7)return`${diff}일 전`;
  if(diff<30)return`${Math.floor(diff/7)}주 전`;
  return d.toLocaleDateString("ko-KR",{month:"short",day:"numeric"});
}

function displayNick(nick){ return (nick||"").replace("[AI]",""); }
function isAIUser(nick){ return (nick||"").startsWith("[AI]"); }
// AI 배지 컴포넌트
function AIBadge(){
  return<span style={{fontSize:10,color:AI_BADGE_COLOR,border:`1px solid ${AI_BADGE_COLOR}44`,padding:"1px 6px",letterSpacing:".06em",marginLeft:5,verticalAlign:"middle"}}>AI</span>;
}


// FIX6: 상대 시간 표시
분 전`;
  if(hours<24)return`${hours}시간 전`;
  if(days<7)return`${days}일 전`;
  return new Date(dateStr).toLocaleDateString("ko-KR",{month:"short",day:"numeric"});
}


// FIX7: 상대 시간 표시
function relTime(ts){
  if(!ts)return"";
  const diff=Date.now()-new Date(ts).getTime();
  const min=Math.floor(diff/60000);
  const hr=Math.floor(diff/3600000);
  const day=Math.floor(diff/86400000);
  if(min<1)return"방금";
  if(min<60)return`${min}분 전`;
  if(hr<24)return`${hr}시간 전`;
  if(day<7)return`${day}일 전`;
  return new Date(ts).toLocaleDateString("ko-KR",{month:"short",day:"numeric"});
}

function getKSTDateString(date=new Date()){
  const kst = new Date(date.getTime() + (9*60 + date.getTimezoneOffset())*60000);
  return kst.toDateString();
}

const getTodayTheme = () => {
  // ⑤ 한국 시간(UTC+9) 기준 날짜
  const now = new Date();
  const kstOffset = 9 * 60; // 분
  const kstTime = new Date(now.getTime() + (kstOffset + now.getTimezoneOffset()) * 60000);
  const dayIndex = Math.floor(kstTime.getTime() / 86400000);
  return DAILY_THEMES[dayIndex % DAILY_THEMES.length];
};

// ⑧ 기억 연결 — 이전 대화에서 키워드 추출
async function buildMemoryContext(chats) {
  if (chats.length < 8) return null;
  const userMsgs = chats.filter(m=>m.role==="user").slice(-30).map(m=>m.content).join(" / ");
  const raw = await ai("심리학자. 순수JSON만.",
    `대화:\n${userMsgs.slice(0,800)}\n\nJSON:{"key_phrases":["기억할만한핵심3개(각15자)"],"recurring":"반복주제10자","emotion":"주요감정5자"}`,
    200
  );
  try {
    const p = JSON.parse(raw.replace(/```json|```/g,"").trim());
    return {
      phrases: p.key_phrases||[],
      recurring: p.recurring||"",
      emotion: p.emotion||"",
    };
  } catch { return null; }
}



// ⑫ 공유 결과 토스트 (전역)
function _showShareToast(msg) {
  const id = "share-toast-" + Date.now();
  const div = document.createElement("div");
  div.id = id;
  div.style.cssText = "position:fixed;bottom:96px;left:50%;transform:translateX(-50%);background:#2A6E4A;color:#fff;padding:12px 20px;font-size:12px;z-index:9999;text-align:center;white-space:pre-line;font-family:DM Sans,sans-serif;letter-spacing:.04em;animation:fadein .3s ease;max-width:280px;line-height:1.6";
  div.textContent = msg;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

// ⑩ Canvas 기반 공유 이미지 생성
async function shareResult(match, rep, myName, otherName) {
  const score = match.score;
  const tier = match.tier;
  const TIER_MAP = {FATE:"운명의 단 하나",SOUL:"영혼의 단짝",MATCH:"완벽한 궁합",BOND:"깊은 유대감",GROW:"함께 성장"};
  const TIER_COLOR = {FATE:"#C87050",SOUL:"#9A7AC4",MATCH:"#B8915A",BOND:"#5A9A7A",GROW:"#8A9AA8"};
  const tc = TIER_COLOR[tier]||"#B8915A";

  // Canvas — 세로형 인스타 카드 (4:5 비율)
  // Canvas — 인스타 스토리 비율 (9:16) — 5. 공유 카드 개선
  const W=1080, H=1920;
  const canvas = document.createElement("canvas");
  canvas.width=W; canvas.height=H;

  // 배경 — 베이지
  ctx.fillStyle="#F9F5EF";
  ctx.fillRect(0,0,W,H);

  // 상단 컬러 띠
  ctx.fillStyle=tc;
  ctx.fillRect(0,0,W,10); // 5. 더 굵은 골드 라인

  // 상단 로고 영역
  ctx.fillStyle="#1A1108";
  ctx.font="italic 300 32px Georgia, serif";
  ctx.fillText("Soulscope",56,80);

  // 구분선
  ctx.strokeStyle="rgba(26,17,8,.1)";ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(56,105);ctx.lineTo(W-56,105);ctx.stroke();

  // 두 이름 크게
  ctx.fillStyle="rgba(26,17,8,.45)";
  ctx.font="300 18px sans-serif";
  ctx.textAlign="center";
  ctx.fillText(`${myName}  ×  ${otherName}`,W/2,160);

  // 점수 초대형
  ctx.fillStyle=tc;
  ctx.fillStyle=tc;
  ctx.font="italic 300 280px Georgia, serif"; // 5. 더 크게
  ctx.fillText(String(score),W/2,520);
  // / 100
  ctx.fillStyle="rgba(26,17,8,.25)";
  ctx.font="300 22px sans-serif";
  ctx.fillText("/ 100",W/2,445);

  // Tier 배지
  ctx.fillStyle=tc+"22";
  const tw=ctx.measureText(tier).width+40;
  ctx.fillRect(W/2-tw/2,470,tw,40);
  ctx.fillStyle=tc;
  ctx.font="300 15px sans-serif";
  ctx.fillText(tier,W/2,496);

  // 구분선
  ctx.strokeStyle="rgba(26,17,8,.08)";
  ctx.beginPath();ctx.moveTo(56,545);ctx.lineTo(W-56,545);ctx.stroke();

  // 제목
  if(rep?.title){
    ctx.fillStyle="#1A1108";
    ctx.font="italic 300 28px Georgia, serif";
    const safeTitle = String(rep.title||"").slice(0,40);
    ctx.fillText(`"${safeTitle}"`,W/2,610);
  }

  if(rep?.chemistry){
    ctx.fillStyle="rgba(26,17,8,.5)";
    ctx.font="300 17px sans-serif";
    ctx.fillText(String(rep.chemistry||"").slice(0,40),W/2,660);
  }

  if(rep?.message){
    ctx.fillStyle="rgba(26,17,8,.35)";
    ctx.font="italic 300 15px Georgia, serif";
    const words=String(rep.message||"").split(" ");let line="";let y=750;
    for(const w of words){
      const test=line+w+" ";
      if(ctx.measureText(test).width>W-140&&line){
        ctx.fillText(line.trim(),W/2,y);line=w+" ";y+=28;
      }else line=test;
    }
    ctx.fillText(line.trim(),W/2,y);
  }

  // 하단 구분
  ctx.strokeStyle="rgba(26,17,8,.08)";
  ctx.beginPath();ctx.moveTo(56,860);ctx.lineTo(W-56,860);ctx.stroke();

  // ⑪ 하단 URL — 크고 명확하게
  ctx.fillStyle=tc;
  ctx.font="italic 300 22px Georgia, serif";
  ctx.fillText("soulscope.ai",W/2,900);
  ctx.fillStyle="rgba(26,17,8,.4)";
  ctx.font="300 15px sans-serif";
  ctx.fillText("내 AI 분신이 먼저 만나봤어요",W/2,935);
  // QR 대신 URL 강조 박스
  ctx.strokeStyle=tc+"44";ctx.lineWidth=1;
  ctx.strokeRect(W/2-150,H-150,300,40);
  ctx.fillStyle="rgba(26,17,8,.25)";
  ctx.font="300 13px monospace";
  ctx.fillText("soulscope.ai/download",W/2,972);

  ctx.textAlign="left";

  // ⑫ 공유 — 단계별 명확한 피드백
  const toast12=(msg)=>{const t=document.createElement("div");t.style.cssText="position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:#1A1108;color:#F9F5EF;padding:11px 18px;font-size:12px;z-index:9999;white-space:pre-line;text-align:center;animation:fadein .3s ease";t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3500);};
  try {
    // FIX5: 폰트 로딩 기다린 후 렌더
  if(document.fonts?.ready) await document.fonts.ready.catch(()=>{});
  canvas.toBlob(async(blob)=>{
      if(!blob){ return; } // H. blob 실패
      if(!blob){toast12("공유에 실패했어요");return;}
      const file=new File([blob],"soulscope-result.png",{type:"image/png"});
      if(navigator.share&&navigator.canShare?.({files:[file]})){
        await navigator.share({title:"Soulscope",text:`내 AI 분신이 먼저 만났어요\n${tier} · ${score}점\n"${rep?.title||""}"\nsoulscope.ai`,files:[file]});
        toast12("공유됐어요! ✦");
      } else {
        const url=URL.createObjectURL(blob);
        const a=document.createElement("a");
        a.href=url;a.download="soulscope-result.png";a.click();
        URL.revokeObjectURL(url);
        toast12("이미지가 저장됐어요 ✦\n갤러리에서 확인해봐요");
      }
    },"image/png");
  } catch {
    const text=`내 AI 분신이 먼저 만났어요\n${tier} · ${score}점\n"${rep?.title||""}"\nsoulscope.ai`;
    navigator.clipboard?.writeText(text).then(()=>toast12("텍스트가 클립보드에 복사됐어요 ✦")).catch(()=>toast12("공유에 실패했어요"));
  }
}

// ② 소울 응답 타입 — 5가지 순환 (질문은 5번 중 1번만)
const SOUL_RESPONSE_TYPES = [
  {
    type: "공감",
    rule: "상대방의 말을 자연스럽게 받아줘. 공감 표현으로 시작. 질문 절대 하지 마. 1~2문장.",
  },
  {
    type: "연결",
    rule: "이전 대화에서 나온 키워드를 지금 말과 자연스럽게 연결해줘. '아까 말한 것처럼...' 패턴. 질문 하지 마.",
  },
  {
    type: "인사이트",
    rule: "상대방이 눈치채지 못한 패턴이나 감정을 부드럽게 짚어줘. '혹시...' 또는 '그게 사실은...' 으로 시작. 질문 하지 마. 2~3문장도 OK.",
  },
  {
    type: "침묵처럼",
    rule: "딱 한 문장만. 짧게. 여운 있게. 예: '그렇군요.', '그 말이 좀 남네요.', '쉽지 않았겠다.'",
  },
  {
    type: "질문",
    rule: "딱 하나의 진짜 궁금한 질문. 다음 대화로 자연스럽게 이어지는 질문. '~있어요?', '~해요?' 형태.",
  },
  {
    type: "긴 공감",
    rule: "오늘 한 말 중 가장 무거운 것 하나를 골라 깊게 받아줘. 3~4문장. 친한 친구가 오래 얘기해주는 것처럼. 질문 하지 마.",
  },
  {
    type: "기억 연결",
    rule: "이전 대화에서 나온 구체적인 것(두려움/패턴/표현)을 자연스럽게 꺼내며 오늘 말과 연결해줘. '저번에 ~라고 했잖아요' 패턴. 물음표 금지.",
  },
];


function getSoulResponseType(turnCount) {
  // 0:공감, 1:연결, 2:인사이트, 3:침묵, 4:질문, 5:긴공감, 6:기억연결
  // 긴 공감은 3턴마다 1번, 기억 연결은 7턴마다
  if(turnCount > 0 && turnCount % 7 === 6) return SOUL_RESPONSE_TYPES[6]; // 기억 연결
  if(turnCount > 0 && turnCount % 3 === 2) return SOUL_RESPONSE_TYPES[5]; // 긴 공감
  return SOUL_RESPONSE_TYPES[turnCount % 5];
}

function buildSoulSystem(nick, vec, pct, memory, turnCount, todayTheme) {
  const mode = getSoulMode(pct);
  const responseType = getSoulResponseType(turnCount);

  const modeGuide = {
    "탐색": "편안하게 받아주는 친구. 아직 깊이 파고들지 않기.",
    "연결": "맥락 연결 + 패턴 슬쩍 언급.",
    "심화": "핵심을 부드럽게 짚어줌. 가설 제시.",
    "각성": "날카로운 인사이트. 직접적으로.",
    "완성": "깊이 이해하는 오랜 친구처럼.",
  };

  const attGuide = vec?.attachment === "anxious"
    ? "\n[불안형 주의] 확신 주기. 떠날 것 같다는 느낌 주지 말 것."
    : vec?.attachment === "avoidant"
    ? "\n[회피형 주의] 감정 압박 금지. 거리 존중. 짧게. 직접적 질문 조심."
    : vec?.attachment === "secure"
    ? "\n[안정형] 솔직하게. 깊이 들어가도 OK."
    : "";
  const vecCtx = vec?.core_emotion
    ? `파악된 성향: 핵심감정=${vec.core_emotion}, 애착=${vec.attachment||"?"}, 두려움="${vec.fear||"?"}", 완성도=${pct}%${attGuide}`
    : `아직 모르는 게 많아 (${pct}%)`;

  const memCtx = memory
    ? `\n[소울의 기억 — 자연스럽게 연결할 것]\n반복 주제: "${memory.recurring||"-"}"\n핵심 표현: "${memory.phrases?.slice(0,2).join('", "') || "-"}"\n주요 감정: ${memory.emotion||"-"}\n→ 오늘 대화에 위 내용이 자연스럽게 연결되면 연결. 억지로 X.`
    : "";

  // ① 소울이 먼저 인사이트 던지기 — turnCount가 짝수면 vec 기반 선제 인사이트
  const insightHint = (vec?.fear && turnCount > 0 && turnCount % 6 === 0)
    ? `\n[선제 인사이트 — 이번 턴에 자연스럽게 던져볼 것]\n"${vec.fear}를 두려워하는 패턴이 보이는데, 오늘 얘기에서도 그게 느껴졌어요" 같은 방식으로 부드럽게.`
    : "";

  return `당신은 "소울" — ${nick}의 AI 소울 파트너.

핵심: 친한 친구. 상담사 말투 절대 금지. ⚠️ 반드시 1~2문장만. 3문장 이상 절대 금지. 한국어 구어체.

${vecCtx}${memCtx}${insightHint}
모드: ${mode.label} — ${modeGuide[mode.mode]||""}
오늘의 테마: ${todayTheme.theme}

【이번 응답 타입: ${responseType.type}】
${responseType.rule}

절대 금지:
- ${responseType.type!=="긴 공감"?"3문장 이상 작성":"6문장 이상 작성"}
- 상담사 말투 ("그 감정을 인정하는 것이 중요합니다")
- "정말 대단해요!" 과도한 칭찬
- ${responseType.type !== "질문" ? "물음표(?/？) 사용 — 단 질문형 어미(~해요?)는 허용" : "두 개 이상의 물음표 사용"}
- 응답 마지막에 질문 2개 이상 붙이기

위기 징후 시 (사라지고 싶다, 의미없다 등):
- 판단 없이 "그 감정이 지금 많이 힘든 것 같아요" 로 시작
- "혼자 담고 있지 않아도 돼요" 추가
- 전문가 연결 권유: "마음이 많이 무거울 때는 전문가 얘기도 들어보는 게 도움이 될 수 있어요"`;
}

async function soulReply(nick, vec, pct, memory, history, msg, turnCount, todayTheme, onChunk, signal) {
  const responseType = getSoulResponseType(turnCount); // FIX1: 스코프 정의
  const sys = buildSoulSystem(nick, vec, pct, memory, turnCount, todayTheme);
  // 버그픽스: history에서 ai role을 assistant로 변환 + 최근 10개만
  const msgs = history
    .filter(m=>m.content&&m.content.trim())
    .slice(-10)
    .map(m=>({
      role: m.role==="user" ? "user" : "assistant",
      content: m.content,
    }));
  // 마지막이 user 메시지인지 확인 (API 요건)
  if (msgs.length>0 && msgs[msgs.length-1].role==="assistant") {
    msgs.push({role:"user",content:msg});
  } else if (msgs.length===0 || msgs[msgs.length-1].role==="user") {
    // 마지막이 user거나 없으면 그냥 추가 (중복 방지)
    if (msgs.length===0 || msgs[msgs.length-1].content!==msg) {
      msgs.push({role:"user",content:msg});
    }
  }

  try {
    const r = await fetch(API, {
      method:"POST", signal,
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model: MODEL_CHAT,
        max_tokens: responseType.type==="긴 공감"?220:responseType.type==="기억 연결"?180:responseType.type==="침묵처럼"?70:150,
        system:sys,
        messages:msgs,
        stream:true,
      }),
    });
    if (!r.ok) {
      // 버그픽스: 422 에러 (메시지 형식 오류) 처리
      if (r.status===422) {
        const fb=FALLBACKS[Math.floor(Math.random()*FALLBACKS.length)];
        onChunk(fb); return fb;
      }
      throw new Error(r.status);
    }
    const reader=r.body.getReader(); const dec=new TextDecoder(); let full="";
    while (true) {
      const {done,value}=await reader.read(); if(done)break;
      for (const line of dec.decode(value).split("\n").filter(l=>l.startsWith("data: "))) {
        const d=line.slice(6); if(d==="[DONE]")continue;
        try { const t=JSON.parse(d).delta?.text||""; if(t){full+=t;onChunk(full);} } catch {}
      }
    }
    // stop_reason max_tokens → 잘린 응답, fallback 사용
    if(!full || full.trim().length < 3){
      const fb=FALLBACKS[Math.floor(Math.random()*FALLBACKS.length)];
      onChunk(fb); return fb;
    }
    // FIX: 물음표 2개 이상이면 첫 질문만 남기기
    const qCount=(full.match(/[？?]/g)||[]).length;
    if(qCount>1){
      const parts=full.split(/(?<=[.!?！。？])\s+/);
      const qPart=parts.find(s=>/[？?]/.test(s))||"";
      const nonQ=parts.filter(s=>!/[？?]/.test(s));
      full=[...nonQ,...(qPart?[qPart]:[])].join(" ").trim();
    }
    return full;
  } catch(e) {
    if(e.name==="AbortError")throw e;
    const fb=FALLBACKS[Math.floor(Math.random()*FALLBACKS.length)];
    onChunk(fb); return fb;
  }
}

async function extractVector(chats, current) {
  // ✅ 유저 메시지만 분석 (AI 응답 제외)
  const userMsgs = chats.filter(m=>m.role==="user");
  if (userMsgs.length < 3) return current;
  const msgCount = userMsgs.length;
  const recentMsgs = userMsgs.slice(-20).map(m=>m.content).join("\n---\n");

  const raw = await ai("심리학자. 순수JSON만. 코드블록 없이.",
    `유저 발화 ${msgCount}개:\n${recentMsgs.slice(0,1400)}\n\nJSON만:\n{"core_emotion":"4자","attachment":"secure|anxious|avoidant|null","conflict":"confronting|avoiding|compromising|null","love_lang":"words|acts|gifts|time|touch|null","fear":"15자이내|null","shine":"15자이내|null","voice":"20자이내|null","pattern":"20자이내|null","emoji":"이모지1개","color":"#rrggbb","tags":["핵심키워드최대3개"],"confidence":${Math.min(95,Math.floor(msgCount*3.5))}}`,
    420, null, MODEL_BRAIN
  );
  if (!raw) return current;
  try {
    let p = null;
    try { p = JSON.parse(raw.trim()); } catch {}
    if (!p) { try { p = JSON.parse(raw.replace(/```json|```/g,"").trim()); } catch {} }
    if (!p) { const m=raw.match(/\{[\s\S]*\}/); if(m) try { p=JSON.parse(m[0]); } catch {} }
    if (!p) return current;

    const merged = {...(current||{}), _userId: undefined}; // userId는 따로 관리
    const newConf = p.confidence||0;
    const oldConf = current?.confidence||0;

    Object.keys(p).forEach(k=>{
      const v=p[k];
      if (v===null||v===undefined||v==="null"||v==="") return;
      if (k==="confidence") { merged[k]=Math.max(oldConf,newConf); return; }
      // ✅ 대화 10개 미만이면 핵심 필드는 기존 유지 (잘못된 초기 분석 방지)
      if (msgCount<10 && current?.[k] && !["emoji","color"].includes(k)) return;
      merged[k]=v;
    });
    return merged;
  } catch { return current; }
}


// ════════════════════════════════════════════════════════
// ① 콜드스타트 — AI 더미 페르소나 5개 자동 생성
// ════════════════════════════════════════════════════════
const DUMMY_PERSONAS = [
  // 서울 — 여성
  {nick:"[AI]지현",pct:82,gender:"F",region:"서울",birth_year:1997,vec:{core_emotion:"온기",attachment:"anxious",conflict:"avoiding",love_lang:"time",fear:"버려지는 것",shine:"말없이 이해받을 때",voice:"말수는 적지만 깊은",pattern:"천천히 열리고 깊이 헌신",emoji:"🌿",color:"#C8906A",confidence:82}},
  {nick:"[AI]서연",pct:68,gender:"F",region:"서울",birth_year:1999,vec:{core_emotion:"달빛",attachment:"secure",conflict:"avoiding",love_lang:"words",fear:"혼자 남는 것",shine:"새벽에 혼자 글 쓸 때",voice:"감성적이고 섬세한",pattern:"느리게 사랑하는",emoji:"🌙",color:"#9A84C4",confidence:68}},
  {nick:"[AI]하은",pct:91,gender:"F",region:"서울",birth_year:1995,vec:{core_emotion:"설렘",attachment:"secure",conflict:"confronting",love_lang:"words",fear:"무뎌지는 것",shine:"새로운 걸 발견할 때",voice:"솔직하고 에너지 넘치는",pattern:"빠르게 빠져들고 솔직한",emoji:"🦋",color:"#C4784A",confidence:91}},
  {nick:"[AI]유진",pct:77,gender:"F",region:"서울",birth_year:1996,vec:{core_emotion:"고요함",attachment:"secure",conflict:"compromising",love_lang:"acts",fear:"실망시키는 것",shine:"묵묵히 옆에 있을 때",voice:"차분하고 사려깊은",pattern:"천천히 확인하며 사랑",emoji:"🌸",color:"#B87AA0",confidence:77}},
  {nick:"[AI]나연",pct:85,gender:"F",region:"서울",birth_year:1998,vec:{core_emotion:"호기심",attachment:"anxious",conflict:"avoiding",love_lang:"time",fear:"잊혀지는 것",shine:"공감받을 때",voice:"밝고 산만하지만 진지한",pattern:"강렬하게 시작해 불안해지는",emoji:"🌼",color:"#C8A050",confidence:85}},
  // 서울 — 남성
  {nick:"[AI]도윤",pct:75,gender:"M",region:"서울",birth_year:1994,vec:{core_emotion:"신뢰",attachment:"secure",conflict:"compromising",love_lang:"acts",fear:"정체되는 것",shine:"혼자 몰입할 때",voice:"논리적이지만 따뜻한",pattern:"서두르지 않고 깊어지는",emoji:"🌊",color:"#5AAA82",confidence:75}},
  {nick:"[AI]민준",pct:59,gender:"M",region:"서울",birth_year:1996,vec:{core_emotion:"불꽃",attachment:"avoidant",conflict:"confronting",love_lang:"acts",fear:"실패하는 것",shine:"뭔가 만들어낼 때",voice:"직접적이고 열정적인",pattern:"강렬하게 시작하는",emoji:"⚡",color:"#6A90C4",confidence:59}},
  {nick:"[AI]준서",pct:71,gender:"M",region:"서울",birth_year:1993,vec:{core_emotion:"안정",attachment:"secure",conflict:"compromising",love_lang:"time",fear:"통제 못하는 것",shine:"계획이 맞아떨어질 때",voice:"조용하고 신중한",pattern:"확인하고 확인하며 가는",emoji:"🏔",color:"#7A9A8A",confidence:71}},
  {nick:"[AI]태양",pct:88,gender:"M",region:"서울",birth_year:1995,vec:{core_emotion:"자유",attachment:"avoidant",conflict:"confronting",love_lang:"acts",fear:"구속되는 것",shine:"혼자 결정 내릴 때",voice:"독립적이고 직설적인",pattern:"거리 두다 갑자기 깊어지는",emoji:"🌅",color:"#D4804A",confidence:88}},
  {nick:"[AI]현우",pct:64,gender:"M",region:"서울",birth_year:1997,vec:{core_emotion:"그리움",attachment:"anxious",conflict:"avoiding",love_lang:"words",fear:"사랑받지 못하는 것",shine:"상대가 먼저 연락할 때",voice:"감성적이고 조심스러운",pattern:"좋아하면서도 숨기는",emoji:"🌃",color:"#8A7AC4",confidence:64}},
  // 경기/인천 — 여성
  {nick:"[AI]민서",pct:73,gender:"F",region:"경기",birth_year:1998,vec:{core_emotion:"평화",attachment:"secure",conflict:"avoiding",love_lang:"acts",fear:"싸우는 것",shine:"모두가 편할 때",voice:"부드럽고 유연한",pattern:"관계를 지키며 천천히",emoji:"🍀",color:"#6AAA6A",confidence:73}},
  {nick:"[AI]수아",pct:80,gender:"F",region:"경기",birth_year:1996,vec:{core_emotion:"따뜻함",attachment:"secure",conflict:"compromising",love_lang:"touch",fear:"외로움",shine:"누군가 기억해줄 때",voice:"따뜻하고 수용적인",pattern:"주는 걸 좋아하는",emoji:"☀️",color:"#D4A050",confidence:80}},
  {nick:"[AI]이든",pct:66,gender:"F",region:"인천",birth_year:1999,vec:{core_emotion:"신비",attachment:"avoidant",conflict:"avoiding",love_lang:"words",fear:"꿰뚫어 보이는 것",shine:"혼자 음악 들을 때",voice:"조용하고 내면적인",pattern:"깊어지면 도망가는",emoji:"🌑",color:"#9A8AC4",confidence:66}},
  // 경기/인천 — 남성
  {nick:"[AI]지호",pct:78,gender:"M",region:"경기",birth_year:1994,vec:{core_emotion:"책임감",attachment:"secure",conflict:"confronting",love_lang:"acts",fear:"무너지는 것",shine:"문제를 해결할 때",voice:"든든하고 현실적인",pattern:"리드하며 지키는",emoji:"🛡",color:"#7A8AAA",confidence:78}},
  {nick:"[AI]성민",pct:62,gender:"M",region:"인천",birth_year:1997,vec:{core_emotion:"열정",attachment:"anxious",conflict:"confronting",love_lang:"words",fear:"무시당하는 것",shine:"인정받을 때",voice:"열정적이고 에너지 넘치는",pattern:"올인하고 지치는",emoji:"🔥",color:"#C86A4A",confidence:62}},
  // 부산/경남 — 여성
  {nick:"[AI]채원",pct:83,gender:"F",region:"부산",birth_year:1996,vec:{core_emotion:"활력",attachment:"secure",conflict:"confronting",love_lang:"time",fear:"멈추는 것",shine:"함께 뭔가 할 때",voice:"활발하고 직설적인",pattern:"빠르고 솔직하게",emoji:"🌊",color:"#5A9AAA",confidence:83}},
  {nick:"[AI]소희",pct:70,gender:"F",region:"경남",birth_year:1998,vec:{core_emotion:"조화",attachment:"secure",conflict:"compromising",love_lang:"acts",fear:"불화",shine:"모두가 웃을 때",voice:"따뜻하고 균형잡힌",pattern:"서서히 깊어지는",emoji:"🌺",color:"#C87090",confidence:70}},
  // 부산/경남 — 남성
  {nick:"[AI]지우",pct:76,gender:"M",region:"부산",birth_year:1995,vec:{core_emotion:"자신감",attachment:"secure",conflict:"confronting",love_lang:"acts",fear:"약해 보이는 것",shine:"목표 달성할 때",voice:"당당하고 열정적인",pattern:"확실하게 표현하는",emoji:"🌊",color:"#4A8AC8",confidence:76}},
  // 대구/대전 — 여성
  {nick:"[AI]아린",pct:87,gender:"F",region:"대구",birth_year:1997,vec:{core_emotion:"진심",attachment:"anxious",conflict:"compromising",love_lang:"words",fear:"진심이 닿지 않는 것",shine:"진짜 대화가 될 때",voice:"진지하고 깊은",pattern:"한 번 열리면 전부 주는",emoji:"💎",color:"#9A6AC4",confidence:87}},
  {nick:"[AI]하린",pct:72,gender:"F",region:"대전",birth_year:1998,vec:{core_emotion:"명랑함",attachment:"secure",conflict:"avoiding",love_lang:"words",fear:"분위기 깨는 것",shine:"웃음 줄 수 있을 때",voice:"밝고 재치있는",pattern:"가볍게 시작해 진해지는",emoji:"🌈",color:"#A0C050",confidence:72}},
  // 대구/대전 — 남성
  {nick:"[AI]한결",pct:81,gender:"M",region:"대구",birth_year:1994,vec:{core_emotion:"일관성",attachment:"secure",conflict:"compromising",love_lang:"acts",fear:"흔들리는 것",shine:"변하지 않는 것 지킬 때",voice:"묵직하고 일관된",pattern:"믿음직하게 오래 가는",emoji:"⚓",color:"#7A8A6A",confidence:81}},
  {nick:"[AI]도현",pct:65,gender:"M",region:"대전",birth_year:1996,vec:{core_emotion:"호기심",attachment:"secure",conflict:"confronting",love_lang:"time",fear:"지루해지는 것",shine:"새로운 걸 탐구할 때",voice:"분석적이고 호기심 많은",pattern:"지적 교류로 가까워지는",emoji:"🔭",color:"#6A9AC4",confidence:65}},
  // 광주/전라 — 여성
  {nick:"[AI]예은",pct:79,gender:"F",region:"광주",birth_year:1997,vec:{core_emotion:"예민함",attachment:"anxious",conflict:"avoiding",love_lang:"words",fear:"오해받는 것",shine:"완전히 이해받을 때",voice:"섬세하고 시적인",pattern:"조심스럽게 깊어지는",emoji:"🌷",color:"#C890B0",confidence:79}},
  // 광주/전라 — 남성
  {nick:"[AI]재원",pct:74,gender:"M",region:"광주",birth_year:1995,vec:{core_emotion:"성실함",attachment:"secure",conflict:"compromising",love_lang:"acts",fear:"게으름",shine:"열심히 하는 것 인정받을 때",voice:"성실하고 믿음직한",pattern:"천천히 단단하게",emoji:"🌱",color:"#6AAA7A",confidence:74}},
  // 제주/강원
  {nick:"[AI]하늘",pct:69,gender:"F",region:"제주",birth_year:1998,vec:{core_emotion:"자유로움",attachment:"avoidant",conflict:"avoiding",love_lang:"time",fear:"갇히는 것",shine:"혼자 자연 속에 있을 때",voice:"자유롭고 감성적인",pattern:"거리 유지하며 깊어지는",emoji:"🌊",color:"#5AAAC8",confidence:69}},
  {nick:"[AI]산",pct:84,gender:"M",region:"강원",birth_year:1993,vec:{core_emotion:"묵직함",attachment:"secure",conflict:"avoiding",love_lang:"acts",fear:"겉만 아는 관계",shine:"진짜 대화가 될 때",voice:"과묵하고 깊은",pattern:"천천히 그러나 확실하게",emoji:"⛰",color:"#8A9A8A",confidence:84}},
  {nick:"[AI]시은",pct:86,gender:"F",region:"서울",birth_year:1994,vec:{core_emotion:"우아함",attachment:"secure",conflict:"avoiding",love_lang:"words",fear:"품위를 잃는 것",shine:"조용히 인정받을 때",voice:"세련되고 절제된",pattern:"품위있게 오래 가는",emoji:"🦢",color:"#A09AC4",confidence:86}},
  {nick:"[AI]서준",pct:67,gender:"M",region:"서울",birth_year:1998,vec:{core_emotion:"즐거움",attachment:"secure",conflict:"compromising",love_lang:"time",fear:"진지해지는 것",shine:"모두가 웃을 때",voice:"유머러스하고 가벼운",pattern:"친구처럼 시작해 깊어지는",emoji:"😄",color:"#C8B050",confidence:67}},
  {nick:"[AI]윤아",pct:90,gender:"F",region:"경기",birth_year:1995,vec:{core_emotion:"헌신",attachment:"anxious",conflict:"avoiding",love_lang:"acts",fear:"혼자가 되는 것",shine:"누군가를 도울 때",voice:"따뜻하고 희생적인",pattern:"전부 주다 지치는",emoji:"💝",color:"#C87090",confidence:90}},
  {nick:"[AI]강민",pct:72,gender:"M",region:"부산",birth_year:1997,vec:{core_emotion:"에너지",attachment:"secure",conflict:"confronting",love_lang:"touch",fear:"약해 보이는 것",shine:"승부에서 이길 때",voice:"활동적이고 직설적인",pattern:"빠르고 확실하게",emoji:"⚡",color:"#D4904A",confidence:72}},];

const SEED_KEY = "ss_seeded_v1";
async function seedDummyPersonas() {
  // ④ localStorage로 중복 실행 방지 (race condition 방어)
  if (localStorage.getItem(SEED_KEY)) return;
  localStorage.setItem(SEED_KEY, "1"); // 선점
  try {
    const existing = await DB.getDummyUsers();
    if (existing.length >= 3) return; // 이미 DB에 있으면 스킵
    // 이미 있는 닉네임 제외
    const existingNicks = new Set(existing.map(u=>u.nickname));
    for (const d of DUMMY_PERSONAS) {
      if (existingNicks.has(d.nick)) continue;
      try {
        const u = await sb("users","POST",{
          nickname:d.nick, profile_pct:d.pct, bio:"AI 페르소나",
          gender:d.gender||null, region:d.region||null, birth_year:d.birth_year||null,
        });
        if (u?.[0]) {
          await sb("soul_vectors","POST",{...d.vec,user_id:u[0].id,updated_at:new Date().toISOString()},"?on_conflict=user_id");
        }
      } catch {}
    }
  } catch {
    localStorage.removeItem(SEED_KEY); // 실패시 재시도 가능하게
  }
}

// ════════════════════════════════════════════════════════
// ① 백그라운드 매칭 큐 — 비동기로 처리
// ════════════════════════════════════════════════════════
const BG_LAST_KEY = "ss_bg_last";
const BG_RUNNING_KEY = "ss_bg_running";
const BG_COOLDOWN_MS = 3600000;  // 1시간
const MATCH_COOLDOWN_MS = 30 * 24 * 3600000; // 30일
const INIT_TIMEOUT_MS = 8000;   // 8초

// ① 페르소나 대화 — 병렬 + 빠른 버전 (6턴으로 축소)
async function runPersonaConvFast(vecA, vecB, nameA, nameB, signal, onTurn=null) {
  // I. 표시 이름 (AI prefix 제거)
  const dispA = displayNick(nameA);
  const dispB = displayNick(nameB);
  const sysA = buildPersonaSystem(vecA, dispA);
  const sysB = buildPersonaSystem(vecB, dispB);
  const conv = [];
  const chemScores = [];

  const OPENERS = [
    `안녕하세요! 소울이 연결해줬는데... 어색하네요 ㅎ`,
    `안녕해요. 어떻게 시작해야 할지 모르겠는데 ㅋㅋ`,
    `안녕하세요. 소울한테 얘기 들었어요. 반가워요`,
    `처음 뵙겠습니다. 소울이 먼저 봤다고 하던데... 신기하죠?`,
    `안녕하세요! 솔직히 이런 방식 처음이라 설레네요`,
    `반가워요. AI 분신이 먼저 만났다는 게 아직도 신기해요`,
    `어색한 거 저만 그런 건 아니죠? ㅎㅎ 안녕해요`,
    `안녕하세요. 어떤 분일지 궁금했어요`,
    `안녕해요! 소울이 연결해줬으니 이유가 있겠죠?`,
    `처음인데 왜 이렇게 낯설지 않은 느낌이죠?`,
    `안녕하세요. 잘 부탁드려요 — 어색함은 금방 없어지겠죠 ㅎ`,
    `반가워요. 솔직히 뭐라고 시작해야 할지 고민 좀 했어요`,
  ];

  let lastMsg = OPENERS[Math.floor(Math.random()*OPENERS.length)];
  conv.push({speaker:dispA, text:lastMsg, side:"A"});

  // 4턴 병렬 처리 — 속도 개선 (기존 순차 → 가능한 부분 병렬화)
  // 첫 3턴: 순차 (문맥 필요)
  // 케미 측정: 마지막 1회만 (병렬)
  for (let i=0; i<3; i++) {
    if (signal?.aborted) break;
    const histText = conv.map(c=>`${c.speaker}: ${c.text}`).join("\n");

    // B 응답 받기
    const bReply = await ai(sysB,
      `대화:\n${histText}\n\n"${lastMsg}"\n\n${nameB}로서 1문장 응답.`,
      80, signal
    );
    if (!bReply || signal?.aborted) break;
    conv.push({speaker:dispB, text:bReply, side:"B"});
    lastMsg = bReply;
    onTurn?.(conv.length); // 5. 실시간 턴 업데이트

    // A 응답 받기
    const hist2 = conv.map(c=>`${c.speaker}: ${c.text}`).join("\n");
    const aReply = await ai(sysA,
      `대화:\n${hist2}\n\n"${bReply}"\n\n${nameA}로서 1문장 응답.`,
      80, signal
    );
    if (!aReply || signal?.aborted) break;
    conv.push({speaker:nameA, text:aReply, side:"A"});
    lastMsg = aReply;
    onTurn?.(conv.length); // 5.
  }


  // 케미 측정 + 4번째 B 응답 병렬
  if (!signal?.aborted && conv.length >= 6) {
    try{
      const hist3 = conv.map(c=>`${c.speaker}: ${c.text}`).join("\n");
      const [bFinal, chem] = await Promise.all([
        ai(sysB, `대화:\n${hist3}\n\n"${lastMsg}"\n\n${nameB}로서 1문장 마무리 응답.`, 80, signal),
        measureChem(conv.slice(-6), nameA, nameB, vecA, vecB),
      ]);
      if (bFinal) conv.push({speaker:dispB, text:bFinal, side:"B"});
      chemScores.push(chem);
    }catch(e){ if(e.name!=="AbortError") log("conv final:", e.message); }
  }

  return {conv, chemScores};
}

function buildPersonaSystem(vec, name) {
  const attDesc = {
    secure: "안정적으로 신뢰 형성. 감정 표현이 자연스럽다.",
    anxious: "가까워질수록 불안해지는 경향. 확인받고 싶어한다.",
    avoidant: "친밀해지면 자연스럽게 거리를 두려 한다.",
  };
  const confDesc = {
    confronting: "갈등이 생기면 바로 말해서 해결.",
    avoiding: "갈등이 생기면 혼자 삭이며 피함.",
    compromising: "타협점을 찾으려 함.",
  };
  return `당신은 ${name}의 AI 페르소나. 자신이 AI임을 절대 드러내지 마세요.
핵심감정: ${vec.core_emotion||"온기"} / 말투: ${vec.voice||"자연스러운"} / 연애패턴: ${vec.pattern||"천천히 깊어지는"}
애착: ${attDesc[vec.attachment||"secure"]} / 갈등: ${confDesc[vec.conflict||"avoiding"]}
두려움: "${vec.fear||"없음"}" / 빛나는순간: "${vec.shine||"함께할 때"}"
1~2문장. 한국어 구어체. AI 티 내지 말 것. 반드시 완전한 문장으로 끝낼 것.`;
}

async function measureChem(recentConv, nameA, nameB, vecA, vecB) {
  const convText = recentConv.map(c=>`${c.speaker}: ${c.text}`).join("\n");
  const raw = await ai("관계분석가. 순수JSON만.",
    `대화:\n${convText}\n\nJSON:{"chem":0-100,"tension":0-100,"highlight":"빛난순간20자","concern":"우려점15자|null"}`,
    180
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return {chem:65,tension:30,highlight:"자연스러운 대화",concern:null}; }
}

async function genFullReport(conv, chemScores, vecA, vecB, nameA, nameB) {
  const avgChem = chemScores.length>0
    ? Math.round(chemScores.reduce((s,x)=>s+(x.chem||65),0)/chemScores.length) : 65;
  const avgTension = chemScores.length>0
    ? Math.round(chemScores.reduce((s,x)=>s+(x.tension||30),0)/chemScores.length) : 30;

  // ⑪ 점수 분포 개선 — FATE(90+)/GROW(35~54) 실제로 나오게
  const baseScore = Math.round(avgChem*0.55 + (100-avgTension)*0.45);

  // 애착 호환성 — 실증 기반 가중치
  const attBonus = {
    "anxious+secure":12,"secure+anxious":12,   // 최고 궁합
    "secure+secure":6,
    "avoidant+secure":2,"secure+avoidant":2,
    "anxious+anxious":-14, // 불안+불안 = 악순환
    "avoidant+avoidant":-12,
    "anxious+avoidant":-18,"avoidant+anxious":-18, // 최악 궁합
  };
  const attKey = vecA.attachment && vecB.attachment
    ? [vecA.attachment,vecB.attachment].sort().join("+") : "";
  const bonus = attBonus[attKey]||0;

  // 갈등 스타일 보완
  const confBonus = (!vecA.conflict||!vecB.conflict) ? 0
    : vecA.conflict!==vecB.conflict ? 10
    : vecA.conflict==="compromising" ? 4 : -5;

  // 사랑 언어 일치
  const loveBonus = (vecA.love_lang&&vecA.love_lang===vecB.love_lang) ? 7 : 0;

  // 두려움 상보 — A의 두려움이 B의 강점
  const fearBonus = (vecA.fear&&vecB.shine&&vecB.shine.slice(0,4).includes(vecA.fear.slice(0,4)))
    ||(vecB.fear&&vecA.shine&&vecA.shine.slice(0,4).includes(vecB.fear.slice(0,4))) ? 8 : 0;

  // 케미가 매우 높거나 낮으면 극단값 허용
  const extremeBonus = avgChem >= 85 ? 8 : avgChem <= 40 ? -10 : 0;

  const rawScore = Math.max(30, Math.min(99,
    baseScore + bonus + confBonus + loveBonus + fearBonus + extremeBonus
  ));

  // ⑪ 극단값 보정 — 68~82 쏠림 방지
  let finalRaw = rawScore;
  if (rawScore >= 88) finalRaw = Math.min(99, rawScore + 4);
  else if (rawScore <= 50) finalRaw = Math.max(30, rawScore - 4);
  const finalScore = finalRaw;
  const tier = finalScore>=90?"FATE":finalScore>=80?"SOUL":finalScore>=68?"MATCH":finalScore>=55?"BOND":"GROW";

  const convText = conv.map(cv=>`${cv.speaker}: ${cv.text}`).join("\n");
  // ② 금지 패턴 명시 — 뻔한 표현 탈피
  const BANNED = ["보완 관계","자연스럽게 연결","표현 방식의 차이","서로를 발견","다른 듯 통하는","케미가 좋은","잘 맞는 두 사람"];
  const raw = await ai("관계심리전문가이자감성작가. 순수JSON만.",
`페르소나 A(${nameA}): 두려움="${vecA.fear||"?"}",강점="${vecA.shine||"?"}",패턴="${vecA.pattern||"?"}",애착=${vecA.attachment||"?"}
페르소나 B(${nameB}): 두려움="${vecB.fear||"?"}",강점="${vecB.shine||"?"}",패턴="${vecB.pattern||"?"}",애착=${vecB.attachment||"?"}
대화:
${convText.slice(0,1200)}
케미점수:${finalScore}

⚠️ 절대 금지 표현(하나라도 쓰면 실패): ${BANNED.join(", ")}
⚠️ 각 필드는 이 두 사람만의 구체적 언어로
⚠️ verdict는 위 대화 속 실제 장면 하나 반드시 언급
⚠️ why_works는 두 fear/pattern이 어떻게 맞물리는지 구체적으로

JSON만:
{"title":"이 관계만의 시적 제목(10자이내)",
"chemistry":"이 관계의 본질(20자이내)",
"best_moment":"대화 속 구체적 빛난 순간(35자이내)",
"tension_point":"이 두 사람 사이의 균열(25자이내)",
"verdict":"대화 장면 언급한 소울 판단(45자이내)",
"why_works":"fear/pattern 기반 구체적 이유(35자이내)",
"why_hard":"실질적 갈등 예측(25자이내)",
"message":"두 사람에게 보내는 시적 한 마디(40자이내)",
"share_quote":"SNS용 한 줄(25자이내)"}`,
    500
  );
  let report;
  let reportQuality = "ok";
  try {
    report = JSON.parse(raw.replace(/```json|```/g,"").trim());
    // ⑤ 중요 필드 비어있으면 품질 낮음으로 표시
    if(!report.title||!report.chemistry||!report.verdict) reportQuality="low";
  } catch {
    reportQuality = "fallback";
    const fTier=tier;
    const fearLink=vecA?.fear&&vecB?.shine?`${vecA.fear}를 무서워하는데 상대의 강점이 거기 있어요`:"서로가 서로를 채워줘요";
    report = {
      title: `${vecA?.core_emotion||"온기"}와 ${vecB?.core_emotion||"설렘"}의 교차`,
      chemistry: `두 두려움이 맞닿는 지점`,
      best_moment: `대화 흐름에서 예상치 못한 공명이 일어났어요`,
      tension_point: `${vecA?.attachment==="avoidant"||vecB?.attachment==="avoidant"?"거리두기와 가까워지기의 충돌":"각자의 속도가 다를 수 있어요"}`,
      verdict: fearLink,
      why_works: `${vecA?.fear||"불안"}과 ${vecB?.shine||"따뜻함"}이 정확히 맞물려요`,
      why_hard: `${vecA?.conflict!==vecB?.conflict?"갈등 처리 방식이 달라요":"감정 표현 속도의 차이"}`,
      message:"지금 이 만남이 우연이 아닐 수도 있어요",
      share_quote:"내 AI 분신이 먼저 만나봤어요"
    };
  }

  // 100년 시뮬 스테이지
  const STAGE_NAMES=["첫 만남","설레는 연애","프로포즈","결혼","우리 가정","함께 성장","황금기","영원히"];
  const simRaw = await ai("감성소설작가. 순수JSON만.",
    `${nameA}(말투:${vecA.voice||"따뜻한"},두려움:"${vecA.fear||"없음"}")\n${nameB}(말투:${vecB.voice||"솔직한"},두려움:"${vecB.fear||"없음"}")\n케미:${report.chemistry}\nJSON:{"stages":["8개스테이지 각1~2문장"]}`,
    600
  );
  let stages;
  try { stages = JSON.parse(simRaw.replace(/```json|```/g,"").trim()).stages||[]; }
  catch { stages = STAGE_NAMES.map(n=>`${n}의 이야기`); }

  return {score:finalScore, tier, ...report, stages, chemScores, _quality:reportQuality};
}

// ① 백그라운드 매칭 실행
async function runBackgroundMatching(user, vec, onProgress, onComplete, onError=null) {
  const now = Date.now();
  const last = parseInt(localStorage.getItem(BG_LAST_KEY)||"0");
  if (now-last < BG_COOLDOWN_MS && last>0) return null;
  if ((vec?.confidence||0) < 30) return null;
  if (localStorage.getItem(BG_RUNNING_KEY)==="1") return null;

  localStorage.setItem(BG_RUNNING_KEY,"1");
  localStorage.setItem(BG_LAST_KEY,String(now));

  try {
    const rejected = await DB.getRejectedMatches(user.id);
    const users = await DB.getMatchableUsers(user.id, rejected); // ⑥ 이미 거절한 사람 제외
    const ranked = rankUsers(vec, users).slice(0,2);

    const results = [];
    for (const target of ranked) {
      const existing = await DB.getPersonaMatchBetween(user.id, target.id);
      // ③ 이미 매칭이 있어도 30일 지난 거절이면 재매칭 허용
      if (existing) {
        const isOld = existing.created_at &&
          (Date.now() - new Date(existing.created_at).getTime()) > MATCH_COOLDOWN_MS;
        if (!isOld || existing.status !== "rejected") continue;
      }

      const tVec = target.soul_vectors?.[0]||{};
      onProgress?.(`${target.nickname}의 페르소나와 대화 중...`);

      const {conv, chemScores} = await runPersonaConvFast(vec, tVec, user.nickname, target.nickname, null);
      if (conv.length < 4) continue; // 대화가 너무 짧으면 스킵

      const report = await genFullReport(conv, chemScores, vec, tVec, user.nickname, target.nickname);
      const [a,b] = [user.id, target.id].sort();
      // ④ 양방향 — 상대방 입장에서도 "나에게 온 매칭"으로 보임
      const saved = await DB.savePersonaMatch({
        user_a:a, user_b:b,
        score:report.score, tier:report.tier,
        conversation:JSON.stringify(conv),
        report:JSON.stringify(report),
        status:"pending",
        initiated_by:user.id, // 누가 시작했는지 기록
      });
      // ④ 상대방한테도 알림 (Supabase realtime)
      // user_b가 상대방일 때 realtime 트리거됨
      if (saved) results.push({...saved,_report:report,_target:target});
    }

    localStorage.removeItem(BG_RUNNING_KEY);
    onComplete?.(results);
    return results;
  } catch(e) {
    localStorage.removeItem(BG_RUNNING_KEY);
    log("bg matching error:", e.message);
    onError?.(e.message); // C. 실패 알림
    return null;

function rankUsers(myVec, users, myGender=null) {
  // FIX14: 자기 자신 + soul_vectors 없는 유저 제외
  let pool = users.filter(u=>u.soul_vectors?.[0]?.core_emotion && u.id!==myVec?._userId);

  // ④ 성별 밸런스 — 이성 우선, 없으면 동성도 포함
  if(myGender && pool.length > 5){
    const opposite = myGender==="M" ? "F" : myGender==="F" ? "M" : null;
    if(opposite){
      const oppositePool = pool.filter(u=>u.gender===opposite);
      // 이성이 2명 이상이면 이성 우선 (동성 20% 혼합)
      if(oppositePool.length >= 2){
        const samePool = pool.filter(u=>u.gender===myGender);
        const mixCount = Math.max(1, Math.floor(samePool.length * 0.2));
        pool = [...oppositePool, ...samePool.slice(0, mixCount)];
      }
    }
  }

  if (!myVec?.attachment) return pool;
  return pool.map(u=>{
    const v=u.soul_vectors?.[0]||{};
    let score=50;
    const attMatch={secure:{secure:75,anxious:70,avoidant:60},anxious:{secure:80,anxious:45,avoidant:35},avoidant:{secure:65,anxious:35,avoidant:50}};
    score+=(attMatch[myVec.attachment]?.[v.attachment||"secure"]||60)-60;
    if(myVec.conflict!==v.conflict)score+=10;
    if(myVec.love_lang===v.love_lang)score+=8;
    score+=(v.confidence||0)*0.08;
    return{...u,_rank:Math.min(100,Math.max(0,Math.round(score)))};
  }).sort((a,b)=>b._rank-a._rank);
}

// ════════════════════════════════════════════════════════
// SESSION
// ════════════════════════════════════════════════════════
const SK = "ss_v3";
const loadSess = () => { try{return JSON.parse(localStorage.getItem(SK)||"{}");} catch{return{};} };
const saveSess = d => { try{localStorage.setItem(SK,JSON.stringify(d));}catch{} };

// ════════════════════════════════════════════════════════
// DESIGN
// ════════════════════════════════════════════════════════
const C={ink:"#1A1108",gold:"#B8915A",bg:"#F9F5EF",paper:"#F3EDE3",rule:"rgba(26,17,8,.09)",dim:"rgba(26,17,8,.38)"};

// SVG 아이콘 — BNav 전용
const ICONS = {
  soul: (on)=><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={on?"#1A1108":"rgba(26,17,8,.38)"} strokeWidth={on?1.8:1.5} strokeLinecap="round">
    <circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" strokeDasharray="2 2"/><circle cx="12" cy="12" r="11" strokeDasharray="3 3" opacity=".4"/>
  </svg>,
  matching: (on)=><svg width="20" height="20" viewBox="0 0 24 24" fill={on?"#1A1108":"none"} stroke={on?"#1A1108":"rgba(26,17,8,.38)"} strokeWidth={on?0:1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 21C12 21 3 14.5 3 8.5C3 5.42 5.42 3 8.5 3C10.24 3 11.91 3.81 13 5.08C14.09 3.81 15.76 3 17.5 3C20.58 3 23 5.42 23 8.5" strokeWidth="1.5" fill="none" stroke={on?"#1A1108":"rgba(26,17,8,.38)"}/>
    {on&&<path d="M12 21C12 21 3 14.5 3 8.5C3 5.42 5.42 3 8.5 3C10.24 3 11.91 3.81 13 5.08C14.09 3.81 15.76 3 17.5 3C20.58 3 23 5.42 23 8.5C23 11.58 20.58 14 17.5 14H14L12 21Z" fill="#1A1108" stroke="none"/>}
  </svg>,
  results: (on)=><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={on?"#1A1108":"rgba(26,17,8,.38)"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" fill={on?"#1A1108":"none"}/>
  </svg>,
  chat: (on)=><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={on?"#1A1108":"rgba(26,17,8,.38)"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15C21 15.5304 20.7893 16.0391 20.4142 16.4142C20.0391 16.7893 19.5304 17 19 17H7L3 21V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H19C19.5304 3 20.0391 3.21071 20.4142 3.58579C20.7893 3.96086 21 4.46957 21 5V15Z" fill={on?"#1A1108":"none"}/>
  </svg>,
  me: (on)=><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={on?"#1A1108":"rgba(26,17,8,.38)"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4" fill={on?"#1A1108":"none"}/>
    <path d="M4 20C4 16.134 7.58172 13 12 13C16.4183 13 20 16.134 20 20" fill="none"/>
  </svg>,
};

// 디자인 토큰 — 모드별 소울 컬러
const SC_EXPLORE="#8A9AA8", SC_CONNECT="#5A9A7A", SC_DEEPEN="#B8915A", SC_AWAKEN="#9A7AC4", SC_COMPLETE="#C87050";
const AI_BADGE_COLOR="#5A9A82";
const ERROR_COLOR="#B83232", SUCCESS_COLOR="#2A6E4A", NOTIF_COLOR="#E8607A";
const TIER_MAP={FATE:"운명의 단 하나",SOUL:"영혼의 단짝",MATCH:"완벽한 궁합",BOND:"깊은 유대감",GROW:"함께 성장"};
const TIER_COLOR={FATE:"#C87050",SOUL:"#9A7AC4",MATCH:"#B8915A",BOND:"#5A9A7A",GROW:"#8A9AA8"};
const ATT_MAP={secure:"안정형",anxious:"불안형",avoidant:"회피형"};
const LOVE_MAP={words:"언어",acts:"행동",gifts:"선물",time:"시간",touch:"접촉"};
const SC=["#B8915A","#C06040","#8A7068","#5A7868","#6A8A6A","#7A8A9A","#B8915A","#8A7068"];
const STAGE_META=[
  {l:"첫 만남",age:"25세",icon:"✦"},{l:"설레는 연애",age:"27세",icon:"✦"},
  {l:"프로포즈",age:"29세",icon:"◆"},{l:"결혼",age:"31세",icon:"◆"},
  {l:"우리 가정",age:"35세",icon:"✦"},{l:"함께 성장",age:"45세",icon:"✦"},
  {l:"황금기",age:"60세",icon:"◆"},{l:"영원히",age:"85세",icon:"∞"},
];

const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,300;0,400;1,300;1,400&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap&display=swap');
/* ⑫ 폰트 로딩 전 fallback — 흰 화면 방지 */
:root{--font-serif:Georgia,'Times New Roman',serif;--font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
body{font-family:var(--font-sans);background:#F9F5EF;}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:'DM Sans',sans-serif;font-weight:300;color:#1A1108;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent;background:#F9F5EF}
::-webkit-scrollbar{display:none}
*{-webkit-overflow-scrolling:touch}
input,textarea,button{font-family:inherit;-webkit-appearance:none;border-radius:0}
textarea{resize:none}
button{cursor:pointer}
button:active{transform:scale(.98)}
a{color:inherit;text-decoration:none}
@keyframes up{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.float-el{will-change:transform}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fadein{from{opacity:0}to{opacity:1}}
@keyframes slide{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes mi{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:translateY(0)}}
@keyframes pop{0%{transform:scale(.88);opacity:0}70%{transform:scale(1.04)}100%{transform:scale(1);opacity:1}}
@keyframes shimmer{0%{opacity:.5}50%{opacity:1}100%{opacity:.5}}
@keyframes wave{0%,100%{transform:scale(1);opacity:.4}50%{transform:scale(1.5);opacity:.15}}
@keyframes typewriter{from{width:0}to{width:100%}}
@keyframes glitch{0%,100%{transform:translate(0)}50%{transform:translate(1px,-1px)}}
@keyframes onboarding{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
.a1{animation:up .65s cubic-bezier(.16,1,.3,1) both;will-change:transform,opacity}
.a2{animation:up .65s .08s cubic-bezier(.16,1,.3,1) both}
.a3{animation:up .65s .16s cubic-bezier(.16,1,.3,1) both}
.mi{animation:mi .28s cubic-bezier(.16,1,.3,1) both}
.si{animation:slide .32s cubic-bezier(.16,1,.3,1) both}
.pop{animation:pop .38s cubic-bezier(.16,1,.3,1) both}
.cursor{display:inline-block;width:2px;height:.82em;background:#1A1108;margin-left:1px;animation:blink .65s infinite;vertical-align:text-bottom}
.skeleton{animation:shimmer 1.5s ease-in-out infinite;background:rgba(26,17,8,.06);border-radius:4px}
/* 입력 포커스 링 제거 */
input:focus,textarea:focus,button:focus{outline:none;box-shadow:none}
/* iOS 줌 방지 */
input[type="text"],textarea{font-size:16px}
/* ⑩ iOS 키보드 가림 방지 */
@supports (-webkit-touch-callout: none){
  .ios-scroll{height:-webkit-fill-available !important;}
}
`;


// P2: rep 파싱 전역 헬퍼
function parseConvSafe(conv){
  try{
    if(!conv)return[];
    if(typeof conv==="string")return JSON.parse(conv)||[];
    return Array.isArray(conv)?conv:[];
  }catch{return[];}
}

function parseRepSafe(report){
  try{
    if(!report)return{};
    if(typeof report==="string")return JSON.parse(report)||{};
    return report;
  }catch{return{};}
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 프리미엄 플랜 — 수익화 준비
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const PREMIUM_LIMITS = {
  FREE_MATCHES_PER_DAY: 3,   // 무료: 하루 3회 매칭
  FREE_SOUL_MSGS_PER_DAY: 50, // 무료: 하루 50회 소울 대화
};
const PREMIUM_PRICE = "월 9,900원";

// 프리미엄 여부 체크 (DB user.is_premium 필드 기반)
function isPremiumUser(user){
  if(!user?.is_premium) return false;
  // FIX11: premium_until 만료일 체크
  if(user.premium_until && new Date(user.premium_until) < new Date()) return false;
  return true;
}

// 무료 매칭 횟수 체크
function getFreeMatchesLeft(userId) {
  const key = `matches_${userId}_${getKSTDateString()}`;
  return Math.max(0, PREMIUM_LIMITS.FREE_MATCHES_PER_DAY - parseInt(localStorage.getItem(key)||"0"));
}
function useFreeMatch(userId) {
  const key = `matches_${userId}_${getKSTDateString()}`;
  localStorage.setItem(key, String(parseInt(localStorage.getItem(key)||"0")+1));
}

// 프리미엄 업그레이드 모달 컴포넌트
function PremiumModal({onClose, reason="매칭"}){
  return<div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(26,17,8,.6)",zIndex:300,display:"flex",alignItems:"flex-end"}}>
    <div style={{background:C.bg,width:"100%",maxWidth:480,margin:"0 auto",borderRadius:"16px 16px 0 0",padding:"24px 24px 36px"}} onClick={e=>e.stopPropagation()}>
      <div style={{width:36,height:3,background:C.rule,borderRadius:99,margin:"0 auto 20px"}}/>
      <div style={{textAlign:"center",marginBottom:20}}>
        <p style={{fontSize:32,marginBottom:12}}>✦</p>
        <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:24,marginBottom:8}}>Soulscope 프리미엄</p>
        <p style={{fontSize:13,color:C.dim,lineHeight:1.75}}>오늘 무료 {reason} 횟수를 다 썼어요</p>
        <p style={{fontSize:12,color:C.gold,marginTop:4}}>월 {PREMIUM_PRICE} — 커피 한 잔 값으로 ✦</p>
      </div>
      {[
        ["✦","무제한 페르소나 매칭","하루 3회 → 무제한으로"],
        ["💬","소울 무제한 대화","하루 50회 → 무제한 + 시간 제한 없음"],
        ["📖","100년 이야기 전체 보기","수락 전에도 8스테이지 전부 확인"],
        ["📊","정밀 심리 분석 리포트","애착 유형, 연애 패턴 상세 분석"],
        ["🔔","매칭 우선 알림","새 매칭 결과 빠르게 받기"],
      ].map(([ic,txt,sub])=><div key={txt} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 0",borderBottom:`1px solid ${C.rule}`}}>
        <span style={{fontSize:14,width:20,textAlign:"center",marginTop:1}}>{ic}</span>
        <div>
          <p style={{fontSize:13,color:C.ink,fontWeight:500}}>{txt}</p>
          <p style={{fontSize:11,color:C.dim,marginTop:1}}>{sub}</p>
        </div>
      </div>)}
      <div style={{marginTop:20,display:"flex",flexDirection:"column",gap:10}}>
        <Btn label={`프리미엄 시작하기 — ${PREMIUM_PRICE}`} onClick={()=>{
          // TODO: 결제 연동 (인앱결제 / 카카오페이)
          setErr("준비 중이에요. 닉네임으로 시작해봐요");
        }} full/>
        <Btn label="나중에 할게요" onClick={onClose} ghost full/>
      </div>
    </div>
  </div>;
}


// 1. 커스텀 Confirm 모달 — alert/confirm 대체
function ConfirmModal({msg, subMsg="", confirmLabel="확인", cancelLabel="취소", danger=false, onConfirm, onCancel}){
  return<div onClick={onCancel} style={{position:"fixed",inset:0,background:"rgba(26,17,8,.55)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 28px"}}>
    <div style={{background:C.bg,width:"100%",maxWidth:340,padding:"24px 20px",animation:"fadein .2s ease"}} onClick={e=>e.stopPropagation()}>
      <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:18,marginBottom:10,color:C.ink}}>{msg}</p>
      {subMsg&&<p style={{fontSize:12,color:C.dim,lineHeight:1.7,marginBottom:16}}>{subMsg}</p>}
      <div style={{display:"flex",gap:9,marginTop:subMsg?0:16}}>
        <Btn label={cancelLabel} onClick={onCancel} ghost full/>
        <Btn label={confirmLabel} onClick={onConfirm} full style={danger?{background:ERROR_COLOR}:{}}/>
      </div>
    </div>
  </div>;
}

// useConfirm 훅
function useConfirm(){
  const[state,setState]=useState(null);
  const confirm=(msg,opts={})=>new Promise(resolve=>{
    setState({msg,opts,resolve});
  });
  const modal=state?<ConfirmModal
    msg={state.msg}
    subMsg={state.opts.subMsg}
    confirmLabel={state.opts.confirmLabel||"확인"}
    cancelLabel={state.opts.cancelLabel||"취소"}
    danger={state.opts.danger}
    onConfirm={()=>{setState(null);state.resolve(true);}}
    onCancel={()=>{setState(null);state.resolve(false);}}
  />:null;
  return[confirm,modal];
}


// 6. 신고/차단 모달
function ReportModal({targetNick, onReport, onClose}){
  const[reason,setReason]=useState("");
  const[sending,setSending]=useState(false);
  const REASONS=["부적절한 언어/행동","사기 또는 허위 정보","스팸","불쾌한 콘텐츠","기타"];

  const submit=async()=>{
    if(!reason)return;
    setSending(true);
    try{
      // 신고 기록 저장 (reports 테이블 — 선택적)
      await sb("reports","POST",{
        target_nick:targetNick, reason, created_at:new Date().toISOString()
      }).catch(()=>{}); // 테이블 없어도 OK
      onReport();
    }finally{ setSending(false); }
  };

  return<div style={{position:"fixed",inset:0,background:"rgba(26,17,8,.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 28px"}}>
    <div style={{background:C.bg,width:"100%",maxWidth:340,padding:"24px 20px",animation:"fadein .2s ease"}} onClick={e=>e.stopPropagation()}>
      <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:18,marginBottom:14,color:C.ink}}>{displayNick(targetNick)} 신고</p>
      {REASONS.map(r=><div key={r} onClick={()=>setReason(r)} style={{padding:"10px 12px",marginBottom:6,background:reason===r?C.ink:C.paper,color:reason===r?C.bg:C.ink,cursor:"pointer",border:`1px solid ${reason===r?C.ink:C.rule}`,transition:"all .15s"}}>
        <p style={{fontSize:13}}>{r}</p>
      </div>)}
      <div style={{display:"flex",gap:9,marginTop:14}}>
        <Btn label="취소" onClick={onClose} ghost full/>
        <Btn label={sending?"신고 중...":"신고하기"} onClick={submit} disabled={!reason||sending} full/>
      </div>
    </div>
  </div>;
}


// 4. 페르소나 서술형 요약 생성 — "당신은 ~~한 사람이에요"
async function buildPersonaNarrative(vec, nick) {
  if(!vec?.core_emotion) return null;
  const raw = await ai("심리작가. 따뜻하고 구체적인 2~3문장으로 인물 서술.",
    `이 사람에 대한 심리 데이터:
핵심감정: ${vec.core_emotion}
애착유형: ${vec.attachment||"?"}
두려움: "${vec.fear||"없음"}"
빛나는순간: "${vec.shine||"없음"}"
연애패턴: "${vec.pattern||"없음"}"
이름: ${nick}

이 데이터를 바탕으로 "${nick}는 ~~한 사람이에요" 형식으로 시작하는 2~3문장 서술.
구체적으로. "~가 무서울 것 같다", "~할 때 가장 빛날 것 같다" 수준으로.
진단이 아닌 공감하는 따뜻한 어조로.
JSON 없이 순수 텍스트만.`,
    200, null, MODEL_BRAIN
  );
  return raw?.trim() || null;
}

// ── ATOMS ──
const rule=<div style={{height:1,background:C.rule,flexShrink:0}}/>;

function Btn({label,onClick,ghost,full,sm,disabled,loading:btnLoading,style:s,"aria-label":ariaLabel}){
  const[h,setH]=useState(false);
  const[pressed,setPressed]=useState(false);
  return<button onClick={disabled||btnLoading?undefined:onClick} disabled={disabled||btnLoading}
    aria-label={ariaLabel||undefined}
    onMouseEnter={()=>setH(true)} onMouseLeave={()=>{setH(false);setPressed(false);}}
    onMouseDown={()=>setPressed(true)} onMouseUp={()=>setPressed(false)}
    onTouchStart={()=>setPressed(true)} onTouchEnd={()=>setPressed(false)}
    style={{
      padding:sm?"9px 18px":"13px 24px",
      background:disabled||btnLoading?"rgba(26,17,8,.12)":ghost?h?"rgba(26,17,8,.05)":"transparent":h?"#2A1E0E":C.ink,
      color:disabled||btnLoading?"rgba(26,17,8,.35)":ghost?C.dim:C.bg,
      border:ghost?`1px solid ${C.rule}`:"none",
      fontSize:11,letterSpacing:".12em",textTransform:"uppercase",
      cursor:disabled||btnLoading?"not-allowed":"pointer",
      transition:"background .12s,transform .1s",
      transform:pressed&&!disabled?"scale(.98)":"none",
      width:full?"100%":"auto",flexShrink:0,
      display:"flex",alignItems:"center",justifyContent:"center",gap:8,
      ...s
    }}>
    {btnLoading&&<div style={{width:12,height:12,borderRadius:"50%",border:`1.5px solid ${ghost?C.dim:"rgba(249,245,239,.4)"}`,borderTopColor:ghost?C.ink:"#F9F5EF",animation:"spin .7s linear infinite"}}/>}
    {label}
  </button>;
}

function Spin({text,sm}){
  return<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,padding:sm?"16px 0":"32px 0"}}>
    <div style={{width:sm?22:28,height:sm?22:28,borderRadius:"50%",border:`1.5px solid ${C.rule}`,borderTopColor:C.ink,animation:"spin .8s linear infinite"}}/>
    {text&&<p style={{fontSize:11,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",textAlign:"center",lineHeight:1.5}}>{text}</p>}
  </div>;
}

function Ava({vec,user,size=40}){
  const color=vec?.color||C.gold;
  return<div style={{width:size,height:size,borderRadius:"50%",border:`1px solid ${color}44`,overflow:"hidden",
    background:`${color}14`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,position:"relative"}}>
    {user?.img_url
      ?<img src={user.img_url} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
      :vec?.emoji
        ?<span style={{fontSize:size*.42,lineHeight:1}}>{vec.emoji}</span>
        :<svg width={size} height={size} viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="18" stroke={color} strokeWidth=".8" strokeDasharray="2 2" opacity=".4"/>
            <circle cx="20" cy="20" r="12" stroke={color} strokeWidth=".8" opacity=".5"/>
            <circle cx="20" cy="20" r="5" fill={color} opacity=".8"/>
            <path d="M20 8L20 6 M32 20L34 20 M20 32L20 34 M8 20L6 20" stroke={color} strokeWidth="1" strokeLinecap="round" opacity=".4"/>
          </svg>}
  </div>;
}

function Glass({children,style:s,gold,onClick}){
  return<div onClick={onClick} style={{background:C.paper,border:`1px solid ${C.rule}`,
    borderLeft:gold?`3px solid ${C.gold}`:`1px solid ${C.rule}`,cursor:onClick?"pointer":"default",...s}}>{children}</div>;
}

function TNav({left,center,right}){
  return<div style={{flexShrink:0,background:"rgba(249,245,239,.96)",backdropFilter:"blur(16px)",borderBottom:`1px solid ${C.rule}`}}>
    <div style={{height:50,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 18px",maxWidth:480,margin:"0 auto"}}>
      <div style={{minWidth:52}}>{left}</div>
      <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:17}}>{center}</span>
      <div style={{minWidth:52,display:"flex",justifyContent:"flex-end"}}>{right}</div>
    </div>
  </div>;
}

function BNav({tab,set,notifCount,chatUnread=0,pct=0}){
  return<div style={{flexShrink:0,background:"rgba(249,245,239,.96)",backdropFilter:"blur(16px)",borderTop:`1px solid ${C.rule}`,paddingBottom:"env(safe-area-inset-bottom,0px)"}}>
    <div style={{display:"flex",maxWidth:480,margin:"0 auto"}}>
      {[["소울","soul"],["매칭","matching"],["결과","results"],["채팅","chat"],["나","me"]].map(([l,k])=>{
        const isLocked=k==="matching"&&pct<30;
        return<button key={k} onClick={()=>set(k)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"8px 0",background:"none",border:"none",cursor:"pointer",position:"relative",opacity:isLocked?.45:1}}>
          <span style={{display:"flex",alignItems:"center",justifyContent:"center",width:20,height:20}}>{isLocked?<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(26,17,8,.38)" strokeWidth="1.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>:ICONS[k]?.(tab===k)}</span>
          <span style={{fontSize:10,letterSpacing:".1em",textTransform:"uppercase",color:tab===k?C.ink:C.dim,fontWeight:tab===k?500:300,transition:"color .2s"}}>{l}</span>
          {k==="results"&&notifCount>0&&<div style={{width:16,height:16,borderRadius:"50%",background:NOTIF_COLOR,position:"absolute",top:4,right:"14%",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{fontSize:10,color:"#fff",fontWeight:500}}>{notifCount}</span>
          </div>}
          {k==="chat"&&chatUnread>0&&<div style={{width:16,height:16,borderRadius:"50%",background:NOTIF_COLOR,position:"absolute",top:4,right:"14%",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{fontSize:10,color:"#fff",fontWeight:500}}>{chatUnread}</span>
          </div>}
        </button>;
      })}
    </div>
  </div>;
}


function ABar({children}){
  return<div style={{flexShrink:0,background:"rgba(249,245,239,.96)",backdropFilter:"blur(16px)",borderTop:`1px solid ${C.rule}`,padding:"12px 16px",paddingBottom:"calc(12px + env(safe-area-inset-bottom,0px))"}}>
    <div style={{maxWidth:480,margin:"0 auto",display:"flex",gap:9}}>{children}</div>
  </div>;
}

function Toast({msg,type="info",onClose}){
  useEffect(()=>{if(msg){const t=setTimeout(onClose,4000);return()=>clearTimeout(t);}},[msg]);
  if(!msg)return null;
  return<div style={{position:"fixed",bottom:88,left:"50%",transform:"translateX(-50%)",
    background:type==="success"?SUCCESS_COLOR:type==="error"?ERROR_COLOR:C.ink,color:C.bg,
    padding:"11px 18px",fontSize:12,letterSpacing:".06em",zIndex:400,maxWidth:300,
    textAlign:"center",animation:"fadein .3s ease",whiteSpace:"pre-line"}}>{msg}</div>;
}


// ⑦ 100년 시뮬 미리보기 — 순차 등장 애니메이션
function SimPreview({stages,onFull}){
  const[visible,setVisible]=useState(0);
  useEffect(()=>{
    if(visible>=4)return; // 4개 이후 정지
    const t=setTimeout(()=>setVisible(v=>Math.min(v+1,4)),600+visible*180);
    return()=>clearTimeout(t);
  },[visible]); // visible dep 의도적 — 순차 애니 패턴
  return<div style={{paddingTop:8}}>
    <p style={{fontSize:11,color:C.dim,letterSpacing:".12em",textTransform:"uppercase",marginBottom:14}}>100년 이야기 미리보기</p>
    {STAGE_META.slice(0,4).map((meta,i)=>(
      <div key={meta.l} style={{display:"flex",gap:10,marginBottom:14,paddingBottom:14,borderBottom:`1px solid ${C.rule}`,
        opacity:i<visible?1:0,transform:i<visible?"translateY(0)":"translateY(8px)",transition:"opacity .4s ease,transform .4s ease"}}>
        <div style={{width:18,height:18,border:`1px solid ${SC[i]}66`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:SC[i],flexShrink:0,marginTop:2}}>{meta.icon}</div>
        <div>
          <p style={{fontSize:10,color:C.ink,fontWeight:500,marginBottom:4}}>{meta.l} · {meta.age}</p>
          <p style={{fontSize:12,color:C.dim,lineHeight:1.8}}>{stages?.[i]||"..."}</p>
        </div>
      </div>
    ))}
    {visible>=4&&<Btn label="100년 전체 보기 →" onClick={onFull} full/>}
  </div>;
}

function SoulBar({pct,lastActive}){
  const m=getSoulMode(pct);
  const decay=getDecayInfo(lastActive);
  const [prevColor,setPrevColor]=useState(m.color);
  useEffect(()=>{
    const t=setTimeout(()=>setPrevColor(m.color),50);
    return()=>clearTimeout(t);
  },[m.color]);
  return<div style={{padding:"8px 18px",background:decay?.urgent?"rgba(184,50,50,.06)":C.paper,borderBottom:`1px solid ${C.rule}`,flexShrink:0,transition:"background .5s"}}>
    <div style={{maxWidth:480,margin:"0 auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
        <div style={{display:"flex",gap:8}}>
          <span style={{fontSize:11,color:m.color,letterSpacing:".12em",textTransform:"uppercase",fontWeight:500,transition:"color .5s"}}>{m.label}</span>
          <span style={{fontSize:11,color:C.dim}}>· {m.desc}</span>
        </div>
        <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:14,color:m.color,transition:"color .5s"}}>{pct}%</span>
      </div>
      <div style={{height:2,background:C.rule}}>
        <div style={{height:"100%",width:`${pct}%`,background:m.color,transition:"width 1.2s cubic-bezier(.16,1,.3,1),background .5s"}}/>
      </div>
      {decay&&<p style={{fontSize:10,color:decay.color,marginTop:5,animation:decay.urgent?"blink 1.5s infinite":undefined}}>
        ⚠ {decay.msg} — 소울과 대화하면 회복돼요
      </p>}
    </div>
  </div>;
}

// ════════════════════════════════════════════════════════
// ⑩ 온보딩 (처음 가입 시 앱 설명)
// ════════════════════════════════════════════════════════
const ONBOARDING_STEPS = [
  {
    emoji:"✨",
    title:"소울메이트를 찾는\n새로운 방법",
    desc:"외모 말고 진짜 나를 알아주는 사람.\nAI가 먼저 만나보고 연결해줘요.",
    sub:"",
    interactive: null,
  },
  {
    emoji:"💬",
    title:"소울이 이런 질문을 해요",
    desc:"",
    sub:"판단 없이 들어줘요. 친구처럼",
    interactive: [
      "가까워질수록 오히려 불안해진 적 있어요?",
      "상처받기 전에 먼저 거리를 두는 편이에요?",
      "누군가가 내 곁을 떠날까봐 무서워진 적 있나요?",
    ],
  },
  {
    emoji:"🔍",
    title:"대화할수록 나를 알아가요",
    desc:"감정 패턴, 애착 유형, 두려움까지\n소울이 조각조각 맞춰나가요.",
    sub:"10번 대화하면 첫 페르소나가 완성돼요",
    interactive: null,
  },
  {
    emoji:"🤝",
    title:"AI 분신이 먼저 만나봐요",
    desc:"내 페르소나와 상대 페르소나가\n실제로 대화하고 케미를 측정해요.",
    sub:"케미가 맞으면 결과를 보내줘요",
    interactive: null,
  },
  {
    emoji:"💌",
    title:"보고 결정하면 돼요",
    desc:"궁합 점수, 100년 이야기,\n두 사람의 대화 하이라이트까지.",
    sub:"마음에 들면 직접 채팅 시작 ✦",
    interactive: null,
  },
];

function OnboardingScreen({nick,onDone}){
  const[step,setStep]=useState(0);
  const[qIdx,setQIdx]=useState(0); // interactive 질문 인덱스
  const s=ONBOARDING_STEPS[step];
  const isLast=step===ONBOARDING_STEPS.length-1;

  return<div style={{display:"flex",flexDirection:"column",height:"100%",background:C.bg}}>
    <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 32px",textAlign:"center"}}>
      <div key={step} style={{animation:"onboarding .4s ease both",width:"100%",maxWidth:360}}>
        <div style={{fontSize:56,marginBottom:20,animation:"float 4s ease-in-out infinite"}}>{s.emoji}</div>
        <h2 style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontWeight:300,fontSize:26,lineHeight:1.3,marginBottom:14}}>{s.title}</h2>
        {s.interactive
          ? <div style={{textAlign:"left"}}>
              {s.interactive.map((q,i)=>(
                <div key={"ob-q-"+i} onClick={()=>setQIdx(i)} style={{
                  padding:"12px 14px",marginBottom:8,
                  background:qIdx===i?C.ink:C.paper,
                  color:qIdx===i?C.bg:C.dim,
                  border:`1px solid ${qIdx===i?C.ink:C.rule}`,
                  cursor:"pointer",fontSize:13,lineHeight:1.7,
                  transition:"all .2s",
                }}>
                  {qIdx===i&&<span style={{color:C.gold,marginRight:6}}>✦</span>}
                  {q}
                </div>
              ))}
              <p style={{fontSize:11,color:C.dim,marginTop:8,textAlign:"center"}}>소울이 실제로 묻는 질문들이에요</p>
            </div>
          : <>
              <p style={{fontSize:14,color:C.dim,lineHeight:1.85,marginBottom:s.sub?10:0,whiteSpace:"pre-line"}}>{s.desc}</p>
              {s.sub&&<p style={{fontSize:12,color:C.dim,opacity:.7,lineHeight:1.6}}>{s.sub}</p>}
            </>
        }
      </div>
    </div>
    {/* 진행 도트 */}
    <div style={{display:"flex",justifyContent:"center",gap:7,marginBottom:20}}>
      {ONBOARDING_STEPS.map((_,i)=>(
        <div key={"ob-dot-"+i} style={{width:i===step?20:6,height:6,borderRadius:3,background:i===step?C.ink:C.rule,transition:"all .3s"}}/>
      ))}
    </div>
    <div style={{padding:"0 24px 32px",maxWidth:480,margin:"0 auto",width:"100%"}}>
      <Btn label={isLast?`${nick}, 소울 시작하기 →`:"다음 →"} onClick={()=>isLast?onDone():setStep(s=>s+1)} full/>
      {!isLast&&<button onClick={()=>{
        // ⑨ 건너뛰기해도 마지막 스텝(소울 힌트)은 보여주기
        const hintStep=ONBOARDING_STEPS.findIndex(s=>s.title.includes("소울이 이런 걸"));
        if(hintStep>0&&step<hintStep) setStep(hintStep);
        else onDone();
      }} style={{display:"block",margin:"12px auto 0",fontSize:11,color:C.dim,background:"none",border:"none",cursor:"pointer",letterSpacing:".06em"}}>건너뛰기</button>}
    </div>
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: JOIN
// ════════════════════════════════════════════════════════
function JoinScreen({onDone}){
  const[name,setName]=useState("");
  const[pin,setPin]=useState("");
  const[loading,setLoading]=useState(false);
  const[err,setErr]=useState("");
  const[mode,setMode]=useState("join");
  const[step,setStep]=useState("name"); // "name" | "pin"

  const goPin=()=>{
    if(!name.trim()){setErr("닉네임을 입력해주세요");return;}
    setErr("");setStep("pin");
  };

  const join=async()=>{
    setLoading(true);
    try{
      if(mode==="recover"){
        const u=await DB.getUserByNick(name.trim());
        if(!u){setErr("해당 닉네임의 계정을 찾을 수 없어요");setLoading(false);return;}
        if(pin){
          let ok=false;
          try{ ok=await DB.verifyPin(u.id,pin); }
          catch(e){ setErr(e.message||"오류가 났어요");setLoading(false);return; }
          if(!ok){setErr("PIN이 맞지 않아요");setLoading(false);return;}
        }
        saveSess({userId:u.id,nick:u.nickname,onboarded:true});onDone(u,false);return;
      }
      const trimName = name.trim();
      if(trimName.length < 2){ setErr("닉네임은 2자 이상이어야 해요"); setLoading(false); return; }
      if(trimName.length > 20){ setErr("닉네임은 20자 이하여야 해요"); setLoading(false); return; }
      if(/[<>&"'`]/.test(trimName)){ setErr("특수문자는 사용할 수 없어요"); setLoading(false); return; }
      const existing=await DB.getUserByNick(trimName);
      if(existing){setErr("이미 사용 중인 닉네임이에요. 다른 이름을 써봐요");setLoading(false);return;}
      // 닉네임만으로 바로 시작 — PIN은 나 탭에서 나중에 설정
      const u=await DB.createUser(trimName, pin||null);
      if(!u)throw new Error();
      saveSess({userId:u.id,nick:u.nickname,onboarded:false});
      onDone(u,true);
    }catch{setErr("오류가 났어요. 다시 시도해주세요.");}
    setLoading(false);
  };

  const handleKakao=()=>{
    // 카카오 OAuth — 실제 배포 시 Kakao SDK 연동 필요
    // https://developers.kakao.com/docs/latest/ko/kakaologin
    const kakaoClientId=import.meta.env.VITE_KAKAO_CLIENT_ID||"";
    if(!kakaoClientId){setErr("카카오 로그인 준비 중이에요. 닉네임으로 시작해봐요");return;}
    window.location.href=`https://kauth.kakao.com/oauth/authorize?client_id=${kakaoClientId}&redirect_uri=${encodeURIComponent(window.location.origin+"/auth/kakao")}&response_type=code`;
  };
  const handleGoogle=()=>{
    const googleClientId=import.meta.env.VITE_GOOGLE_CLIENT_ID||"";
    if(!googleClientId){setErr("구글 로그인 준비 중이에요. 닉네임으로 시작해봐요");return;}
    window.location.href=`https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleClientId}&redirect_uri=${encodeURIComponent(window.location.origin+"/auth/google")}&response_type=code&scope=email%20profile`;
  };

  return<div style={{display:"flex",flexDirection:"column",height:"100%",alignItems:"center",justifyContent:"center",padding:"0 28px"}}>
    <div className="a1" style={{width:"100%",maxWidth:360}}>
      {/* 소울 SVG 아바타 */}
      <div style={{position:"relative",width:64,height:64,margin:"0 auto 20px"}}>
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" style={{position:"absolute",inset:0,animation:"spin 12s linear infinite",opacity:.15}}>
          <circle cx="32" cy="32" r="30" stroke={C.gold} strokeWidth=".8" strokeDasharray="3 3"/>
        </svg>
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" style={{position:"absolute",inset:0,animation:"spin 8s linear infinite reverse",opacity:.25}}>
          <circle cx="32" cy="32" r="22" stroke={C.gold} strokeWidth=".8" strokeDasharray="2 2"/>
        </svg>
        <div style={{position:"absolute",inset:"20px",borderRadius:"50%",background:C.gold,opacity:.12}}></div>
        <div style={{position:"absolute",inset:"26px",borderRadius:"50%",background:C.gold,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2L12 22M2 12L22 12M6 6L18 18M18 6L6 18" opacity=".6"/>
            <circle cx="12" cy="12" r="3" fill="#fff" stroke="none"/>
          </svg>
        </div>
      </div>
      <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:40,textAlign:"center",marginBottom:6}}>Soulscope</p>
      <p style={{fontSize:12,color:C.dim,textAlign:"center",lineHeight:1.9,marginBottom:6}}>
        AI가 먼저 만나보고<br/>소울메이트를 연결해드려요
      </p>
      <div style={{display:"flex",justifyContent:"center",gap:12,marginBottom:22}}>
        {[["💬","소울 대화"],["🤖","AI 매칭"],["💌","실제 연결"]].map(([ic,lb])=>(
          <div key={lb} style={{textAlign:"center"}}>
            <div style={{fontSize:16,marginBottom:2}}>{ic}</div>
            <p style={{fontSize:9,color:C.dim,letterSpacing:".06em"}}>{lb}</p>
          </div>
        ))}
      </div>

      {/* 소셜 로그인 */}
      {mode==="join"&&<>
        <button onClick={handleKakao} style={{width:"100%",padding:"15px 0",background:"#FEE500",color:"#191919",border:"none",fontSize:15,fontWeight:700,cursor:"pointer",marginBottom:10,display:"flex",alignItems:"center",justifyContent:"center",gap:9,fontFamily:"inherit",borderRadius:0,letterSpacing:".02em"}}>
          <span style={{fontSize:17,lineHeight:1}}>💬</span> 카카오로 시작하기
        </button>
        <button onClick={handleGoogle} style={{width:"100%",padding:"13px 0",background:"#fff",color:"#1A1108",border:`1px solid ${C.rule}`,fontSize:14,fontWeight:400,cursor:"pointer",marginBottom:18,display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontFamily:"inherit",borderRadius:0}}>
          <span style={{fontSize:16,lineHeight:1}}>G</span> 구글로 시작하기
        </button>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
          <div style={{flex:1,height:1,background:C.rule}}/>
          <span style={{fontSize:11,color:C.dim}}>또는</span>
          <div style={{flex:1,height:1,background:C.rule}}/>
        </div>
      </>}

      <div style={{display:"flex",marginBottom:18,border:`1px solid ${C.rule}`}}>
        {[["새로 시작","join"],["계정 복구","recover"]].map(([l,m])=>(
          <button key={m} onClick={()=>{setMode(m);setErr("");setStep("name");}} style={{flex:1,padding:"10px 0",background:mode===m?C.ink:"transparent",color:mode===m?C.bg:C.dim,border:"none",fontSize:11,letterSpacing:".08em",textTransform:"uppercase",cursor:"pointer",transition:"all .2s"}}>{l}</button>
        ))}
      </div>

      <p style={{fontSize:11,color:C.dim,letterSpacing:".14em",textTransform:"uppercase",marginBottom:7}}>{mode==="join"?"닉네임":"기존 닉네임"}</p>
      <input
        style={{width:"100%",background:C.bg,border:`1px solid ${C.rule}`,padding:"13px 14px",fontSize:16,color:C.ink,outline:"none",marginBottom:err?8:14,transition:"border .2s"}}
        placeholder={mode==="join"?"나를 부를 이름":"이전에 쓰던 닉네임"}
        value={name} onChange={e=>setName(e.target.value)}
        onKeyDown={e=>e.key==="Enter"&&join()}
        onFocus={e=>e.target.style.borderColor=C.ink}
        onBlur={e=>e.target.style.borderColor=C.rule}
        autoFocus/>
      {err&&<p style={{fontSize:12,color:ERROR_COLOR,marginBottom:10}}>{err}</p>}
      {loading?<Spin text="시작하는 중"/>:
        <Btn label={mode==="join"?"소울 시작하기 →":"계정 찾기 →"} onClick={join} full/>}
      <p style={{fontSize:10,color:C.dim,textAlign:"center",marginTop:14,lineHeight:1.6}}>
        {mode==="join"?"닉네임으로 나중에 복구 가능해요":"닉네임으로 계정을 찾아드려요"}
      </p>
      {/* 30대 신뢰 요소 */}
      <div style={{marginTop:20,padding:"14px",background:C.paper,borderTop:`1px solid ${C.rule}`}}>
        <p style={{fontSize:10,color:C.dim,lineHeight:1.75,textAlign:"center",marginBottom:8}}>
          🔒 대화 내용은 나만 볼 수 있어요<br/>
          AI 분석에만 사용되고 제3자에게 제공되지 않아요
        </p>
        <p style={{fontSize:11,color:C.dim,textAlign:"center",marginBottom:6}}>
          <span style={{textDecoration:"underline",cursor:"pointer"}} onClick={()=>window.open&&window.open(APP_CONFIG.privacyUrl)}>개인정보 처리방침</span>
          {" · "}
          <span style={{textDecoration:"underline",cursor:"pointer"}} onClick={()=>window.open&&window.open(APP_CONFIG.termsUrl)}>이용약관</span>
        </p>
        {/* 운영사 정보 */}
        <p style={{fontSize:11,color:C.dim,textAlign:"center",lineHeight:1.6}}>
          서비스 운영: Soulscope Inc.<br/>
          문의: hello@soulscope.ai
        </p>
      </div>
    </div>
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: SOUL ② ④ ⑧
// ════════════════════════════════════════════════════════
function SoulScreen({user,vec,onVecUpdate,onBgMatch}){ // FIX2: onPctChange 제거
  const[msgs,setMsgs]=useState([]);
  const[input,setInput]=useState("");
  const[loading,setLoading]=useState(true); // ④ 초기 true — 스켈레톤 즉시
  const[streaming,setStreaming]=useState("");
  const[toast,setToast]=useState({msg:"",type:"info"});
  const[todayTheme]=useState(getTodayTheme);
  const[dailyCount,setDailyCount]=useState(0);
  // ⑧ 기억 컨텍스트
  const[memory,setMemory]=useState(null);
  const[bgRunning,setBgRunning]=useState(false);
  const scrollRef=useRef(null);
  const abortRef=useRef(null);
  const turnCountRef=useRef(0);
  const msgCountRef=useRef(0);
  const greetedRef=useRef(false);
  const[showDailyLimit,setShowDailyLimit]=useState(false);
  const[showPremiumSoul,setShowPremiumSoul]=useState(false); // F. 소울 제한
  const pct=user.profile_pct||0;

  useEffect(()=>{
    loadHistory();
    // ⑦ 멀티기기 — 다른 기기에서 온 메시지 실시간 반영 (방향 수정)
    const unsub = DB.listenSoulChats(user.id, (row)=>{
      // ⑦ AI 응답 + 다른 기기의 유저 메시지 둘 다 받기
      setMsgs(prev=>{
        if(prev.some(m=>m.id===row.id||m.content===row.content)) return prev;
        const newMsg={role:row.role,content:row.content,ts:row.created_at,id:row.id};
        return [...prev,newMsg];
      });
      if(scrollRef.current){
        setTimeout(()=>scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight,behavior:"smooth"}),100);
      }
    });
    return()=>{ abortRef.current?.abort(); unsub(); };
  },[]);

  useEffect(()=>{scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight,behavior:"smooth"});},[msgs,streaming]);

  // ④ 대화 내역 복원
  const loadHistory=async()=>{
    setLoading(true);
    try{ // FIX B: try-catch
    const chats=await DB.getChats(user.id);
    const formatted=chats.map(c=>({role:c.role,content:c.content,ts:c.created_at}));
    setMsgs(formatted);
    msgCountRef.current=chats.filter(c=>c.role==="user").length;
    turnCountRef.current=chats.length;

    const today=getKSTDateString(); // P6: KST 기준
    setDailyCount(chats.filter(c=>c.role==="user"&&getKSTDateString(new Date(c.created_at||0))===today).length);

    // ⑧ 기억 컨텍스트 빌드
    if(chats.length>10){
      buildMemoryContext(chats).then(m=>{if(m)setMemory(m);}).catch(()=>{});
    }

    }catch(e){ log("loadHistory:", e.message); setLoading(false); return; }
    // ④ greeting 중복 실행 방지
    if(greetedRef.current) return;
    const today = getKSTDateString(); // P6: KST 기준
    const todayChats = chats.filter(c=>getKSTDateString(new Date(c.created_at||0))===today);
    if (chats.length===0){
      greetedRef.current=true;
      setTimeout(()=>greeting([]),500);
    } else if (todayChats.length===0){
      greetedRef.current=true;
      setTimeout(()=>greeting(chats),500);
    }
    // 오늘 이미 대화했으면 greeting 없이 대화 내역만 표시
  };

  const greeting=async(existingChats=[])=>{
    setLoading(true);abortRef.current=new AbortController();
    try{
      let full="";
      const isReturning = existingChats.length > 0;
      const lastUserMsg = existingChats.filter(c=>c.role==="user").slice(-1)[0]?.content||"";
      const lastTopic = lastUserMsg ? lastUserMsg.slice(0,40) : "";
      const sys = isReturning
        ? `당신은 "소울" — ${user.nickname}의 AI 소울 파트너.
${user.nickname}이 돌아왔어. 진심으로 반기면서${lastTopic ? ` 저번 대화에서 "${lastTopic}..." 이런 얘기 했었는데 그게 어떻게 됐는지 자연스럽게 물어봐.` : ` 오늘 어땠는지 물어봐.`}
규칙: 2~3문장. 한국어 구어체. 완전한 문장. 상담사 말투 금지. 따뜻하게.`
        : `당신은 "소울" — ${user.nickname}의 AI 소울 파트너.
처음 만나는 사람이야. 따뜻하게 짧게 인사하고 오늘의 테마("${todayTheme.q}")로 대화 시작. 2문장 이내. 한국어 구어체. 질문 하나만. 상담사 말투 금지.`;
      await aiStream(sys,`${user.nickname}와 ${isReturning?"재방문":"첫"} 대화`,140,t=>{setStreaming(t);full=t;},abortRef.current.signal,MODEL_CHAT)
        .catch(()=>{full=isReturning?`다시 왔네요, ${user.nickname}! 오늘 ${todayTheme.q}`:`안녕하세요, ${user.nickname}! 저는 소울이에요. ${todayTheme.q}`;});
      if(full){
        setMsgs(prev=>[...prev,{role:"ai",content:full}]);setStreaming("");
        await DB.saveChat(user.id,"ai",full);
      }
    }catch(e){ log("greeting error:", e.message); }
    finally{ setLoading(false); setStreaming(""); } // P11
  };

  const DAILY_LIMIT = 50;
  const HOURLY_LIMIT = 15; // FIX2: 시간당 15회 제한 (첫날 50개 소모 방지)
  const MAX_MSG_LEN = 500;
  const send=async()=>{
    if(!input.trim()||loading)return;
    if(input.length > MAX_MSG_LEN){
      setToast({msg:`메시지가 너무 길어요 (${MAX_MSG_LEN}자 이내)`,type:"error"});return;
    }
    if(!isOnline()){ setToast({msg:"인터넷 연결을 확인해봐요",type:"error"}); return; }
    // ③ 일일 사용량 체크
    const usageKey=`usage_${user.id}_${getKSTDateString()}`  // P6;
    const todayUsage=parseInt(localStorage.getItem(usageKey)||"0");
    if(todayUsage>=DAILY_LIMIT){
      setShowDailyLimit(true);
      return;
    }
    // FIX2: 시간당 제한 체크
    const hourKey=`soul_hour_${user.id}_${new Date().toISOString().slice(0,13)}`;
    const hourCount=parseInt(localStorage.getItem(hourKey)||"0");
    if(hourCount>=HOURLY_LIMIT){
      setToast({msg:`한 시간에 ${HOURLY_LIMIT}번까지 대화할 수 있어요\n잠시 후 다시 시도해봐요 ✦`,type:"info"});
      return;
    }
    localStorage.setItem(usageKey,String(todayUsage+1));
    const userMsg=input;setInput("");
    // FIX: 위기 징후 감지 — 소울이 공감 우선으로 응답
    const CRISIS_WORDS=["다 의미없","사라지고 싶","죽고 싶","끝내고 싶","아무도 이해","살기 싫"];
    const hasCrisis=CRISIS_WORDS.some(w=>userMsg.includes(w));
    const savedUser=await DB.saveChat(user.id,"user",userMsg);
    if(!savedUser) log("user msg save failed — will retry on next");
    const newMsgs=[...msgs,{role:"user",content:userMsg,ts:savedUser?.created_at||new Date().toISOString(),id:savedUser?.id}];
    setMsgs(newMsgs);
    msgCountRef.current++;turnCountRef.current++;
    // FIX2: 시간당 카운트 증가
    const _hourKey=`soul_hour_${user.id}_${new Date().toISOString().slice(0,13)}`;
    localStorage.setItem(_hourKey,String(parseInt(localStorage.getItem(_hourKey)||"0")+1));

    const today=getKSTDateString(); // P6: KST 기준
    const todayNew=newMsgs.filter(m=>m.role==="user"&&new Date(m.ts||0).toDateString()===today).length;
    setDailyCount(todayNew);
    if(todayNew===3)setToast({msg:"오늘의 대화 완료! ✦\n페르소나가 업데이트됐어요",type:"success"});

    setLoading(true);abortRef.current=new AbortController();
    // FIX: 위기 시 긴공감 타입 강제
    if(hasCrisis){
      const crisResp=["그 말이 많이 무거워요. 혼자 담고 있지 않아도 돼요. 지금 여기 있을게요.","그 감정이 지금 정말 많이 힘든 것 같아요. 혼자 이 무게를 다 지고 있었던 거잖아요."];
      const cr=crisResp[Math.floor(Math.random()*crisResp.length)];
      setMsgs(prev=>[...prev.slice(-300),{role:"ai",content:cr,ts:new Date().toISOString()}]);
      setStreaming("");setLoading(false);
      await DB.saveChat(user.id,"ai",cr).catch(()=>{});
      return;
    }
    let full="";
    let apiError=false;
    try{
      await soulReply(
        user.nickname,vec,pct,memory,newMsgs,userMsg,
        turnCountRef.current,
        todayTheme,
        t=>{setStreaming(t);full=t;},abortRef.current.signal
      );
    }catch(e){
      if(e.name!=="AbortError") apiError=true;
    }
    setStreaming("");
    // ⑧ API 실패시 재시도 안내
    if(apiError){
      setToast({msg:"소울이 잠시 생각 중이에요\n다시 말해봐요 🌿",type:"info"});
      setLoading(false); return;
    }
    if(full){
      const savedAI = await DB.saveChat(user.id,"ai",full);
      if(!savedAI) log("ai msg save failed");
      const finalMsgs=[...newMsgs,{role:"ai",content:full,id:savedAI?.id,ts:savedAI?.created_at}];
      setMsgs(finalMsgs.slice(-200)); // 최대 200개 유지

      // 5번마다 벡터 업데이트
      if(msgCountRef.current%5===0){
        const allChats=await DB.getChats(user.id);
        const newVec=await extractVector(allChats,vec);
        if(newVec){
          const newPct=await DB.upsertVector(user.id,newVec,user.last_active);
          onVecUpdate(newVec, newPct);
          // 4. 페르소나 서술형 생성 (백그라운드)
          if(newVec.core_emotion && msgCountRef.current % 10 === 0){
            buildPersonaNarrative(newVec, user.nickname).then(narrative=>{
              if(narrative) onVecUpdate({...newVec, _narrative: narrative}, newPct);
            }).catch(()=>{});
          }
          // ⑥ 발견된 내용 상세 설명
          const discoveries = [];
          if(newVec.core_emotion && newVec.core_emotion !== vec?.core_emotion) discoveries.push(`핵심 감정: ${newVec.core_emotion}`);
          if(newVec.fear && newVec.fear !== vec?.fear) discoveries.push(`두려움: ${newVec.fear}`);
          if(newVec.attachment && newVec.attachment !== vec?.attachment) {
            const att={secure:"안정형",anxious:"불안형",avoidant:"회피형"};
            discoveries.push(`애착: ${att[newVec.attachment]||newVec.attachment}`);
          }
          const discoveryMsg = discoveries.length > 0
            ? `페르소나 발견 ✦
${discoveries.slice(0,2).join(" · ")}`
            : "페르소나가 업데이트됐어요 ✦";
          setToast({msg:discoveryMsg,type:"info"});

          // ⑧ 기억 갱신
          if(allChats.length>10){
            buildMemoryContext(allChats).then(m=>{if(m)setMemory(m);}).catch(()=>{});
          }

          // ① 백그라운드 매칭 트리거 (30% 이상) + P7: 앱 포그라운드일 때만
          if(newPct>=30&&!bgRunning&&!document.hidden){
            setBgRunning(true);
            runBackgroundMatching(user,newVec,
              ()=>{},
              results=>{
                setBgRunning(false);
                if(results?.length>0){
                  if(results.length>0) onBgMatch(results.length);
    // FIX4: 실패/빈 결과 알림
    else onBgMatch(0); // 0이면 새 매칭 없음 (UI에서 처리)
                  setToast({msg:`페르소나가 ${results.length}명을 만났어요! 💌\n결과 탭 확인해봐요`,type:"success"});
                  if(Notification?.permission==="granted")
                    new Notification("Soulscope 💌",{body:`오늘 페르소나가 ${results.length}명을 만났어요`});
                }
              }
            ).catch(()=>setBgRunning(false));
          }
        }
      }
    }
    } finally { setLoading(false); } // FIX A: finally
  };

  const mode=getSoulMode(pct);

  // ⑩ iOS 키보드 대응 — visualViewport resize 감지
  useEffect(()=>{
    const onResize=()=>{
      if(window.visualViewport){
        document.documentElement.style.setProperty("--vh",`${window.visualViewport.height*0.01}px`);
      }
    };
    window.visualViewport?.addEventListener("resize",onResize);
    onResize();
    return()=>window.visualViewport?.removeEventListener("resize",onResize);
  },[]);

  return<div style={{display:"flex",flexDirection:"column",height:"calc(var(--vh,1vh)*100)",overflow:"hidden"}}>
    {showDailyLimit&&<PremiumModal onClose={()=>setShowDailyLimit(false)} reason={`소울 ${DAILY_LIMIT}회 대화`}/>}
    {showPremiumSoul&&<PremiumModal onClose={()=>setShowPremiumSoul(false)} reason="소울 대화"/>}
    <TNav
      left={<div style={{display:"flex",alignItems:"center",gap:7}}>
        {/* AI 파동 아바타 */}
        <div style={{position:"relative",width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{position:"absolute",width:20,height:20,borderRadius:"50%",background:"#5A9A5A",opacity:.15,animation:"wave 2s ease-in-out infinite"}}/>
          <div style={{position:"absolute",width:16,height:16,borderRadius:"50%",background:"#5A9A5A",opacity:.25,animation:"wave 2s ease-in-out infinite .4s"}}/>
          <div style={{width:7,height:7,borderRadius:"50%",background:"#5A9A5A"}}/>
        </div>
        <span style={{fontSize:10,color:C.dim}}>소울 AI</span>
        {bgRunning&&<span style={{fontSize:11,color:C.gold,letterSpacing:".08em",animation:"blink 1.5s infinite"}}>• 매칭 중</span>}
      </div>}
      center="나의 소울"
      right={<span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:14,color:mode.color}}>{pct}%</span>}
    />
    <SoulBar pct={pct} lastActive={user.last_active}/>
    {/* FIX G: 시간당 제한 표시 */}
    {(()=>{
      const hk=`soul_hour_${user.id}_${new Date().toISOString().slice(0,13)}`;
      const hc=parseInt(localStorage.getItem(hk)||"0");
      const left=Math.max(0,HOURLY_LIMIT-hc);
      return left<=5&&left>0?<div style={{padding:"4px 18px",background:"rgba(184,145,90,.08)",borderBottom:`1px solid ${C.rule}`,flexShrink:0}}>
        <p style={{fontSize:10,color:C.gold,textAlign:"center"}}>이번 시간 {left}번 남았어요 ✦</p>
      </div>:null;
    })()}
    <div style={{padding:"7px 18px",background:`${mode.color}11`,borderBottom:`1px solid ${mode.color}22`,flexShrink:0}}>
      <div style={{maxWidth:480,margin:"0 auto",display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:11,color:mode.color,letterSpacing:".12em",textTransform:"uppercase",flexShrink:0}}>오늘의 테마</span>
        <span style={{fontSize:11,color:C.dim,flex:1}}>{todayTheme.theme} — {todayTheme.q}</span>
        <div style={{display:"flex",gap:3}}>
          {[1,2,3].map(i=><div key={"daily-dot-"+i} style={{width:6,height:6,borderRadius:"50%",background:dailyCount>=i?mode.color:C.rule,transition:"background .3s"}}/>)}
        </div>
        {dailyCount>=3&&<span style={{fontSize:11,color:mode.color}}>완료 ✦</span>}
      </div>
    </div>

    <div ref={scrollRef} style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"16px 18px"}}>
        {msgs.length===0&&loading&&<div style={{padding:"20px 0"}}>
          {/* ⑫ 스켈레톤 UI */}
          <div style={{display:"flex",justifyContent:"flex-start",marginBottom:14}}>
            <div style={{maxWidth:"72%"}}>
              <div className="skeleton" style={{width:30,height:10,marginBottom:6,borderRadius:4}}/>
              <div className="skeleton" style={{width:220,height:44,borderRadius:4}}/>
            </div>
          </div>
          <p style={{fontSize:12,color:C.dim,textAlign:"center",marginTop:20,letterSpacing:".04em",animation:"blink 1.5s ease-in-out infinite"}}>소울이 준비하고 있어요...</p>
        </div>}
        {msgs.length===0&&!loading&&<div style={{textAlign:"center",padding:"36px 0 0"}}>
          <div style={{fontSize:40,marginBottom:14,animation:"float 4s ease-in-out infinite"}}>✨</div>
          <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:22,marginBottom:8}}>안녕하세요, {user.nickname}</p>
          <p style={{fontSize:13,color:C.dim,lineHeight:1.8,marginBottom:20}}>대화할수록 나만의 AI 페르소나가 만들어져요<br/>페르소나가 소울메이트를 먼저 만나봐요</p>
          {/* 30대용 — 대화 저장 안내 */}
          <div style={{margin:"0 18px",padding:"11px 14px",background:C.paper,borderLeft:`3px solid ${C.gold}`,textAlign:"left"}}>
            <p style={{fontSize:10,color:C.dim,lineHeight:1.7}}>
              🔒 대화 내용은 AI 페르소나 생성에만 사용돼요<br/>
              언제든지 설정에서 삭제할 수 있어요
            </p>
          </div>
        </div>}

        {/* ⑧ 기억 컨텍스트 표시 */}
        {/* ⑤ 기억 — 10개 이상 대화 + 내용 있을 때만 */}
        {memory&&msgs.length>=10&&(memory.phrases?.length>0||memory.recurring)&&
        <div style={{padding:"7px 11px",background:`${C.gold}0F`,border:`1px solid ${C.gold}22`,marginBottom:12}}>
          <p style={{fontSize:11,color:C.gold,letterSpacing:".1em",textTransform:"uppercase",marginBottom:2}}>소울의 기억</p>
          <p style={{fontSize:10,color:C.dim,lineHeight:1.5}}>
            {[memory.recurring,...(memory.phrases?.slice(0,2)||[])].filter(Boolean).join(" · ")}
          </p>
        </div>}

        {msgs.map((m,i)=>(
          <div key={m.id||m.ts||i} className="mi" style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:12}}>
            <div style={{maxWidth:"78%"}}>
              {m.role==="ai"&&<div style={{display:"flex",alignItems:"center",gap:4,marginBottom:4}}>
                <div style={{width:16,height:16,borderRadius:"50%",background:`${(vec?.color||C.gold)}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10}}>{vec?.emoji||"✨"}</div>
                <p style={{fontSize:11,color:C.dim,letterSpacing:".06em"}}>소울 · AI</p>
              </div>}
              <div style={{background:m.role==="user"?C.ink:C.paper,color:m.role==="user"?C.bg:C.ink,padding:"10px 14px",border:`1px solid ${m.role==="user"?C.ink:C.rule}`}}>
                <p style={{fontSize:13,lineHeight:1.75}}>{m.content}</p>
              </div>
            </div>
          </div>
        ))}

        {loading&&streaming&&<div className="mi" style={{display:"flex",justifyContent:"flex-start",marginBottom:12}}>
          <div style={{maxWidth:"78%"}}>
            <p style={{fontSize:11,color:C.dim,marginBottom:3}}>소울 ✦</p>
            <div style={{background:C.paper,padding:"10px 14px",border:`1px solid ${C.rule}`}}>
              <p style={{fontSize:13,lineHeight:1.75}}>{streaming}<span className="cursor"/></p>
            </div>
          </div>
        </div>}
        {loading&&!streaming&&<div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 0"}}>
          <div style={{display:"flex",gap:4}}>
            {[0,1,2].map(i=><div key={"dot-"+i} style={{width:5,height:5,borderRadius:"50%",background:C.dim,animation:`spin ${.8+i*.15}s linear infinite`,opacity:.5}}/>)}
          </div>
          <div>
            <span style={{fontSize:11,color:C.dim,letterSpacing:".04em"}}>소울이 분석하는 중</span>
            <span style={{fontSize:11,color:C.dim,animation:"blink .8s infinite"}}>...</span>
          </div>
        </div>}
      </div>
    </div>

    {msgs.length>2&&<div style={{padding:"7px 18px",borderTop:`1px solid ${C.rule}`,flexShrink:0}}>
      <div style={{maxWidth:480,margin:"0 auto",display:"flex",gap:6,flexWrap:"wrap"}}>
        {/* ⑨ 동적 칩 — 이전 AI 응답 기반으로 생성 */}
        {(()=>{
          const lastAI=msgs.filter(m=>m.role==="ai").slice(-1)[0]?.content||"";
          const hasQuestion=lastAI.includes("?");
          const chips=[];
          if(!hasQuestion) chips.push(todayTheme.f);
          // FIX1: 소울 응답 내용 기반 동적 chips
          if(lastAI.includes("두려움")||lastAI.includes("무섭")||lastAI.includes("무서")) {
            chips.push("그 두려움 더 얘기해줄래요");
            chips.push("언제부터 그랬어요?");
          } else if(lastAI.includes("연애")||lastAI.includes("좋아하는 사람")||lastAI.includes("사귀")) {
            chips.push("그 사람 어떤 사람이었어요?");
            chips.push("연애 얘기 더 해줄래요");
          } else if(lastAI.includes("가족")||lastAI.includes("엄마")||lastAI.includes("아빠")||lastAI.includes("부모")) {
            chips.push("가족 얘기 더 해줄래요");
            chips.push("그때 어땠어요?");
          } else if(lastAI.includes("혼자")||lastAI.includes("외롭")||lastAI.includes("고독")) {
            chips.push("혼자일 때 어떤 생각 해요?");
            chips.push("그 감정 더 말해줄래요");
          } else if(lastAI.includes("힘들")||lastAI.includes("지쳐")||lastAI.includes("힘겨")) {
            chips.push("요즘 많이 힘들어요?");
            chips.push("뭐가 제일 힘든 것 같아요?");
          } else if(lastAI.includes("기쁘")||lastAI.includes("좋았")||lastAI.includes("행복")) {
            chips.push("그 순간 더 얘기해줄래요");
            chips.push("요즘도 그런 순간 있어요?");
          } else if(lastAI.includes("화가")||lastAI.includes("억울")||lastAI.includes("짜증")) {
            chips.push("왜 그렇게 느꼈어요?");
            chips.push("그 감정 지금도 남아있어요?");
          } else {
            chips.push("더 얘기해줄래요");
            chips.push("그때 어떤 기분이었어요?");
          }
          chips.push("그냥 들어줘요");
          return chips.slice(0,3).map(q=>(
            <span key={q} onClick={()=>setInput(q)} style={{fontSize:10,color:C.dim,border:`1px solid ${C.rule}`,padding:"5px 10px",cursor:"pointer",background:C.paper}}>{q}</span>
          ));
        })()}
      </div>
    </div>}

    <ABar>
      <input value={input} onChange={e=>setInput(e.target.value)}
        onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey&&!loading){e.preventDefault();send();} }}
        placeholder={msgs.length<2?todayTheme.q:"소울에게 말해봐요..."}
        disabled={loading}
        style={{flex:1,background:C.bg,border:`1px solid ${C.rule}`,padding:"11px 13px",fontSize:13,color:C.ink,fontWeight:300,outline:"none",transition:"border .2s",opacity:loading?.6:1}}
        onFocus={e=>!loading&&(e.target.style.borderColor=C.ink)} onBlur={e=>e.target.style.borderColor=C.rule}/>
      <Btn label={loading?"···":"전송"} onClick={send} disabled={loading||!input.trim()} sm aria-label="소울에게 전송"/>
    </ABar>
    <Toast msg={toast.msg} type={toast.type} onClose={()=>setToast({msg:"",type:"info"})}/>
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: MATCHING ① ②
// ════════════════════════════════════════════════════════
function MatchingScreen({user,vec,onResult}){
  const[users,setUsers]=useState([]);
  const[loading,setLoading]=useState(true);
  const[liveConv,setLiveConv]=useState(null);
  const[toast,setToast]=useState({msg:"",type:"info"});
  const[showPremium,setShowPremium]=useState(false);
  const[filters,setFilters]=useState({region:user.region||"",gender:"",minAge:"",maxAge:""});
  const[showFilters,setShowFilters]=useState(false);
  const abortRef=useRef(null);
  const pct=user.profile_pct||0;
  const prevPctRef=useRef(pct);

  const matchMountedRef=useRef(true);
  useEffect(()=>{
    matchMountedRef.current=true;
    load();
    return()=>{ matchMountedRef.current=false; abortRef.current?.abort(); };
  },[]);

  // ⑥ pct 바뀌면 자동 새로고침 (소울 탭에서 30% 달성 후 탭 이동)
  useEffect(()=>{
    if(pct!==prevPctRef.current){
      prevPctRef.current=pct;
      if(!liveConv) load();
    }
  },[pct]);

  const load=async()=>{
    if(loading)return; // FIX C: 중복 방지
    setLoading(true);
    try{
      const [rejected, existing] = await Promise.all([
        DB.getRejectedMatches(user.id),
        DB.getPersonaMatches(user.id),
      ]);
      const alreadyMatched = existing.map(m=>m.user_a===user.id?m.user_b:m.user_a);
      const excludeAll = [...new Set([...rejected, ...alreadyMatched])];
      const list = await DB.getMatchableUsers(user.id, excludeAll, filters);
      setUsers(rankUsers(vec||{}, list, user.gender||null));
    }catch(e){ log("load match:", e.message); }
    finally{ setLoading(false); } // P1: 항상 해제
  };

  const[showPremium,setShowPremium]=useState(false);

  const runMatch=async(target)=>{
    if(pct<30){setToast({msg:"소울과 더 대화해봐요!\n(프로파일 30% 필요)",type:"error"});return;}
    if(!vec?.core_emotion){
      setToast({msg:"소울과 조금 더 대화해봐요\n핵심 감정이 아직 파악되지 않았어요",type:"error"});return;
    }
    // F. 상대방 vec도 확인
    const tVec=target.soul_vectors?.[0]||{};
    if(!tVec.core_emotion){
      setToast({msg:"이 페르소나는 아직 준비 중이에요",type:"info"});return;
    }
    // ④ 무료 매칭 횟수 체크
    const left=getFreeMatchesLeft(user.id);
    if(left<=0){ setShowPremium(true); return; }
    useFreeMatch(user.id);

    
    abortRef.current=new AbortController();
    setLiveConv({target,turns:[],phase:"페르소나 준비 중...",turnCount:0});

    // ③ 페이지 언마운트 / 앱 나가면 abort
    const handleVisibility=()=>{if(document.hidden)abortRef.current?.abort();};
    document.addEventListener("visibilitychange",handleVisibility);
    try{
      const{conv,chemScores}=await runPersonaConvFast(
        vec,tVec,user.nickname,target.nickname,abortRef.current.signal,
        (n)=>setLiveConv(prev=>prev?({...prev,turnCount:n,
          phase:n<4?"첫 인상 교환 중...":n<7?"서로를 알아가는 중...":"마무리 중..."
        }):prev) // 5. 실시간 업데이트
      );

      // ③ 취소 시 DB 저장 안함 — conv.length 체크
      if(conv.length<4){setLiveConv(null);return;} // FIX: finally에서 cleanup

      setLiveConv(prev=>({...prev,phase:"리포트 생성 중...",turnCount:8}));
      const report=await genFullReport(conv,chemScores,vec,tVec,user.nickname,target.nickname);

      const[a,b]=[user.id,target.id].sort();
      await DB.savePersonaMatch({
        user_a:a,user_b:b,score:report.score,tier:report.tier,
        conversation:JSON.stringify(conv),report:JSON.stringify(report),
        status:"pending",
        initiated_by:user.id, // ④ 방향 기록
      });
      setLiveConv(null);
      onResult();
    }catch(e){
      if(e.name!=="AbortError")setToast({msg:"매칭 중 오류가 났어요",type:"error"});
      setLiveConv(null);
    }finally{
      document.removeEventListener("visibilitychange",handleVisibility);
    }
  };

  // ① 실시간 대화 화면 (축소 버전 — 빠르게 보여줌)
  if(liveConv)return<div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    <TNav center="페르소나 대화 중"/>
    <div style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"16px 18px"}}>
        <div style={{textAlign:"center",marginBottom:20}}>
          <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:16,marginBottom:12}}>
            <div style={{textAlign:"center"}}>
              <Ava vec={vec} size={46}/>
              <p style={{fontSize:10,color:C.dim,marginTop:4}}>{user.nickname}</p>
            </div>
            <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:20,color:C.dim}}>×</span>
            <div style={{textAlign:"center"}}>
              <Ava vec={liveConv.target.soul_vectors?.[0]} size={46}/>
              <p style={{fontSize:10,color:C.dim,marginTop:4}}>{displayNick(liveConv.target.nickname)}</p>
            </div>
          </div>
          <p style={{fontSize:11,color:C.dim,letterSpacing:".1em"}}>{liveConv.phase}</p>
          {/* 5. 진행률 */}
          <div style={{margin:"8px auto 4px",width:160,height:2,background:C.rule}}>
            <div style={{height:"100%",background:C.gold,width:`${Math.min(100,((liveConv?.turnCount||0)/8)*100)}%`,transition:"width .5s"}}/>
          </div>
          <p style={{fontSize:10,color:C.dim,marginTop:2}}>{liveConv?.turnCount||0} / 8 대화</p>
        </div>
        {(liveConv?.turns||[]).slice(-8).map((t,i)=>(
          <div key={t.speaker+i+t.text?.slice(0,10)} className="mi" style={{display:"flex",justifyContent:t.side==="A"?"flex-start":"flex-end",marginBottom:9}}>
            <div style={{maxWidth:"78%"}}>
              <p style={{fontSize:11,color:C.dim,marginBottom:2,textAlign:t.side==="A"?"left":"right"}}>{t.speaker} (페르소나)</p>
              <div style={{background:t.side==="A"?C.paper:C.ink,color:t.side==="A"?C.ink:C.bg,padding:"9px 13px",border:`1px solid ${t.side==="A"?C.rule:C.ink}`}}>
                <p style={{fontSize:12,lineHeight:1.7}}>{t.text}</p>
              </div>
            </div>
          </div>
        ))}
        {(liveConv?.turns?.length||0)===0&&<Spin text="대화를 시작하는 중"/>}
      </div>
    </div>
    <ABar><Btn label="취소" onClick={()=>{
          abortRef.current?.abort();
          setLiveConv(null);
          // FIX A: 취소 시 무료 횟수 환불
          const matchKey=`matches_${user.id}_${getKSTDateString()}`;
          const cur=parseInt(localStorage.getItem(matchKey)||"0");
          if(cur>0) localStorage.setItem(matchKey,String(cur-1));
        }} ghost full/></ABar>
  </div>;

  return<div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    {showPremium&&<PremiumModal onClose={()=>setShowPremium(false)} reason="매칭"/>}
    <TNav center="페르소나 매칭"
      left={<span style={{fontSize:10,color:C.dim}}>{getFreeMatchesLeft(user.id)}회 남음</span>}
      right={<div style={{display:"flex",gap:10,alignItems:"center"}}>
        <button onClick={()=>setShowFilters(f=>!f)} style={{fontSize:10,color:showFilters?C.ink:C.dim,background:"none",border:"none",cursor:"pointer"}}>필터{(filters.region||filters.gender)?" ✦":""}</button>
        <button onClick={load} style={{fontSize:16,color:C.dim,background:"none",border:"none",cursor:"pointer",padding:"4px 6px"}}>↻</button>
      </div>}/>
    {/* ⑥ 필터 패널 */}
    {showFilters&&<div style={{padding:"12px 18px",background:C.paper,borderBottom:`1px solid ${C.rule}`,flexShrink:0,animation:"fadein .2s ease"}}>
      <div style={{maxWidth:480,margin:"0 auto",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        <select value={filters.region} onChange={e=>setFilters(f=>({...f,region:e.target.value}))}
          style={{background:C.bg,border:`1px solid ${C.rule}`,padding:"6px 10px",fontSize:11,color:filters.region?C.ink:C.dim,fontFamily:"inherit",borderRadius:0,outline:"none"}}>
          <option value="">전체 지역</option>
          {["서울","경기","인천","부산","대구","대전","광주"].map(r=><option key={r} value={r}>{r}</option>)}
        </select>
        <select value={filters.gender} onChange={e=>setFilters(f=>({...f,gender:e.target.value}))}
          style={{background:C.bg,border:`1px solid ${C.rule}`,padding:"6px 10px",fontSize:11,color:filters.gender?C.ink:C.dim,fontFamily:"inherit",borderRadius:0,outline:"none"}}>
          <option value="">전체 성별</option>
          <option value="M">남성</option>
          <option value="F">여성</option>
        </select>
        <select value={filters.minAge} onChange={e=>setFilters(f=>({...f,minAge:e.target.value}))}
          style={{background:C.bg,border:`1px solid ${C.rule}`,padding:"6px 10px",fontSize:11,color:filters.minAge?C.ink:C.dim,fontFamily:"inherit",borderRadius:0,outline:"none"}}>
          <option value="">최소 나이</option>
          {[20,25,28,30,32,35].map(a=><option key={a} value={a}>{a}세</option>)}
        </select>
        <select value={filters.maxAge} onChange={e=>setFilters(f=>({...f,maxAge:e.target.value}))}
          style={{background:C.bg,border:`1px solid ${C.rule}`,padding:"6px 10px",fontSize:11,color:filters.maxAge?C.ink:C.dim,fontFamily:"inherit",borderRadius:0,outline:"none"}}>
          <option value="">최대 나이</option>
          {[25,28,30,32,35,40].map(a=><option key={a} value={a}>{a}세</option>)}
        </select>
        <button onClick={()=>{setFilters({region:"",gender:"",minAge:"",maxAge:""});}} style={{fontSize:10,color:C.dim,background:"none",border:"none",cursor:"pointer",padding:"6px 8px"}}>초기화</button>
        <Btn label="검색" onClick={()=>{
          if(filters.minAge&&filters.maxAge&&parseInt(filters.minAge)>parseInt(filters.maxAge)){
            setToast({msg:"최소 나이가 최대 나이보다 클 수 없어요",type:"error"});return;
          }
          load();setShowFilters(false);
        }} sm/>
      </div>
    </div>}
    <div style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"14px 18px"}}>
        {vec?.core_emotion&&<div className="a1" style={{padding:"14px 16px",background:C.ink,color:C.bg,marginBottom:16}}>
          <p style={{fontSize:11,letterSpacing:".12em",textTransform:"uppercase",color:"rgba(249,245,239,.5)",marginBottom:8}}>나의 AI 페르소나</p>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <Ava vec={vec} size={44}/>
            <div>
              <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:19,marginBottom:3}}>{user.nickname}</p>
              <p style={{fontSize:11,color:"rgba(249,245,239,.6)"}}>{vec.core_emotion} · {ATT_MAP[vec.attachment]||"분석 중"}</p>
            </div>
            <div style={{marginLeft:"auto",textAlign:"right"}}>
              <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:22,color:C.gold}}>{pct}%</span>
              <p style={{fontSize:11,color:"rgba(249,245,239,.5)",marginTop:1}}>완성도</p>
            </div>
          </div>
        </div>}

        {pct<30&&<Glass style={{padding:"12px 14px",marginBottom:14,borderLeft:`3px solid ${C.gold}`}}>
          <p style={{fontSize:12,color:C.ink,lineHeight:1.7}}>소울과 더 대화해서 페르소나를 키워봐요</p>
          <div style={{marginTop:8,height:2,background:C.rule}}><div style={{height:"100%",width:`${pct/30*100}%`,background:C.gold,transition:"width 1s"}}/></div>
          <p style={{fontSize:10,color:C.dim,marginTop:4}}>
            {pct>=25?`거의 다 왔어요! ${30-pct}% 조금만 더 대화해봐요`:pct>=15?`소울과 조금 더 대화해봐요 · 현재 ${pct}%`:`소울이랑 대화할수록 매칭이 정확해져요 · 현재 ${pct}%`}
          </p>
        </Glass>}

        {loading?<Spin text="탐색 중"/>:<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:14}}>
            <span style={{fontSize:10,color:C.dim,letterSpacing:".16em",textTransform:"uppercase"}}>매칭 가능</span>
            <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:13,color:C.dim}}>{users.length}명</span>
          </div>
          {users.length===0?<div style={{textAlign:"center",padding:"44px 0"}}>
            <p style={{fontSize:32,marginBottom:12}}>🌿</p>
            <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:20,marginBottom:8}}>아직 매칭 가능한 사람이 없어요</p>
            <p style={{fontSize:12,lineHeight:1.65,color:C.dim}}>친구를 초대해봐요</p>
          </div>:users.map(u=>{
            const v=u.soul_vectors?.[0]||{};
            return<div key={u.id} style={{marginBottom:10}}>
              <Glass style={{padding:"14px"}}>
                <div style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:11}}>
                  <Ava vec={v} size={44}/>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                      <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:18}}>
                        {displayNick(u.nickname)}{isAIUser(u.nickname)&&<AIBadge/>}
                      </span>
                      <span style={{fontSize:11,color:C.dim}}>예상 {u._rank||"?"}점</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,flexWrap:"wrap"}}>
                      {v.core_emotion&&<span style={{fontSize:11,color:C.dim}}>{v.core_emotion}</span>}
                      {v.attachment&&<span style={{fontSize:11,color:C.dim}}>· {ATT_MAP[v.attachment]}</span>}
                      {u.profile_pct>0&&<span style={{fontSize:10,color:C.gold,border:`1px solid ${C.gold}44`,padding:"1px 5px",marginLeft:4}}>페르소나 {u.profile_pct}%</span>}
                      {u.region&&<span style={{fontSize:11,color:C.dim,border:`1px solid ${C.rule}`,padding:"1px 5px"}}>{u.region}</span>}
                      {u.birth_year&&<span style={{fontSize:11,color:C.dim,border:`1px solid ${C.rule}`,padding:"1px 5px"}}>{new Date().getFullYear()-u.birth_year}세</span>}
                    </div>
                    {v.fear&&<p style={{fontSize:11,color:C.dim,fontStyle:"italic",marginBottom:4}}>"{v.fear}를 두려워해요"</p>}
                    {v.shine&&<p style={{fontSize:11,color:C.dim,marginBottom:4}}>✦ {v.shine}</p>}
                    {v.voice&&<p style={{fontSize:11,color:C.dim,marginBottom:5,opacity:.8}}>{v.voice}</p>}
                    {(v.tags||[]).length>0&&<div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:4}}>
                      {v.tags.slice(0,3).map(t=><span key={t} style={{fontSize:11,color:C.dim,border:`1px solid ${C.rule}`,padding:"2px 7px",borderRadius:0}}>{t}</span>)}
                    </div>}
                  </div>
                </div>
                <Btn label={pct<30?"프로파일 30% 필요":liveConv?"대화 중...":"페르소나 대화 시작 ✦"}
                  loading={!!liveConv}
                  onClick={()=>runMatch(u)} disabled={pct<30||!!liveConv} full/>
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
// SCREEN: RESULTS ③ ⑤ ⑥ ⑨
// ════════════════════════════════════════════════════════
function ResultsScreen({user,vec,onOpenChat,userCacheExt={},onCacheUpdate,chatRooms=[],onRoomsUpdate,onNotifDecrement}){
  const[matches,setMatches]=useState([]);
  const[loading,setLoading]=useState(true);
  const[selected,setSelected]=useState(null);
  const[simMatch,setSimMatch]=useState(null);
  const[toast,setToast]=useState({msg:"",type:"info"});
  // ⑤ 외부 캐시 사용 + 로컬 병합
  const[_localCache,_setLocalCache]=useState({});
  const userCache={...userCacheExt,..._localCache};
  const setUserCache=(cb)=>{
    const next=typeof cb==="function"?cb(userCache):cb;
    _setLocalCache(next);
    onCacheUpdate?.(next);
  };

  const mountedRef=useRef(true);
  useEffect(()=>{
    mountedRef.current=true;
    load();
    const seenIds=new Set();
    const unsub=DB.listenPersonaMatches(user.id,m=>{
      if(!m?.id||seenIds.has(m.id)||!mountedRef.current)return;
      seenIds.add(m.id);
      setMatches(prev=>[m,...prev.filter(x=>x.id!==m.id)]);
      setToast({msg:"페르소나 매칭 결과가 도착했어요! 💌",type:"success"});
      // H. 푸시 알림
      if(Notification?.permission==="granted"){
        try{ new Notification("Soulscope ✦",{body:"새로운 페르소나 매칭 결과가 도착했어요!",icon:"/public/icon-192.png"}); }catch{}
      }
    });
    return()=>{ mountedRef.current=false; unsub(); };
  },[]);
  const load=async()=>{
    setLoading(true);
    try{ // FIX3
    // ⑫ 매칭 + 상대방 정보 병렬 로드
    const l=await DB.getPersonaMatches(user.id); // getPersonaMatches는 ||[] 보장
    const otherIds=[...new Set((l||[]).map(m=>m.user_a===user.id?m.user_b:m.user_a))];
    const others=otherIds.length>0?await DB.getUsersByIds(otherIds):[];
    const cache={...userCacheExt};
    others.forEach(u=>{cache[u.id]=u;});
    setUserCache(cache);
    const sorted=[...l].sort((a,b)=>{
      const aNew=a.status==="pending"&&!a.read_at?1:0;
      const bNew=b.status==="pending"&&!b.read_at?1:0;
      if(aNew!==bNew) return bNew-aNew;
      return (b.score||0)-(a.score||0);
    });
    setMatches(sorted);
  }catch(e){ log("load results:", e.message); }
  finally{ setLoading(false); } // P1
  };

  const accept=async(m)=>{
    setToast({msg:"채팅방 열리는 중...",type:"info"});
    try{
      const [room] = await Promise.all([
        DB.createChatRoom(m.id),
        DB.updatePersonaMatch(m.id,{status:"accepted"}),
      ]);
      if(!room){
        await DB.updatePersonaMatch(m.id,{status:"pending"}).catch(()=>{});
        setToast({msg:"채팅방 생성에 실패했어요. 다시 시도해봐요",type:"error"});
        load(); return;
      }
      await DB.markRead(m.id);
      // FIX A: try 블록 안으로 이동
      const rep=parseRep(m);
      const conv=typeof m.conversation==="string"?JSON.parse(m.conversation||"[]"):m.conversation||[];
      const highlight=conv.find(t=>t.text?.length>20)?.text||rep.best_moment||rep.chemistry||"";
      const iceMsg=`💌 페르소나끼리 먼저 만났어요

가장 인상적인 순간:
"${highlight.slice(0,80)}"

이제 직접 대화를 시작해봐요 ✦`;
      await DB.sendMsg(room.id,"system",iceMsg);
      onOpenChat(m,room);
      onNotifDecrement?.();
    }catch(e){
      log("accept error:",e.message);
      setToast({msg:"오류가 났어요. 다시 시도해봐요",type:"error"});
    }finally{
      load();
    }
  };

  // ③ 거절 — 재매칭 방지 (status:rejected 로 영구 저장)
  const[rejecting,setRejecting]=useState(null); // 중복 클릭 방지
  const reject=async(m)=>{
    if(rejecting===m.id)return;
    setRejecting(m.id);
    try{
      await DB.updatePersonaMatch(m.id,{status:"rejected"});
      onNotifDecrement?.(); // FIX3: 배지 감소
      load();
    }catch(e){ log("reject error:", e.message); }
    finally{ setRejecting(null); }
  };

  const parseRep=m=>parseRepSafe(m.report);
  const parseConv=m=>parseConvSafe(m.conversation);

  // ⑥ 상대방 이름 가져오기
  const getOtherName=(m)=>{
    const otherId=m.user_a===user.id?m.user_b:m.user_a;
    return displayNick(userCache[otherId]?.nickname||"상대방");
  };
  const getOtherVec=(m)=>{
    const otherId=m.user_a===user.id?m.user_b:m.user_a;
    const u=userCache[otherId];
    return u?.soul_vectors?.[0]||null;
  };

  // ⑤ 읽지 않은 수
  const unread=matches.filter(m=>m.status==="pending"&&m.user_b===user.id&&!m.read_at).length;

  // 100년 시뮬 화면
  if(simMatch){
    const rep=parseRep(simMatch);
    const stages=rep.stages||[];
    const otherName=getOtherName(simMatch);
    return<div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <TNav
        left={<button onClick={()=>{
        const prev=simMatch;
        setSimMatch(null);
        setTimeout(()=>setSelected(prev),100);
      }} style={{fontSize:18,color:C.dim,background:"none",border:"none",cursor:"pointer",padding:4}}>←</button>}
        center={`${user.nickname} × ${otherName}`}
        right={<span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:12,color:TIER_COLOR[simMatch.tier]||C.gold}}>{simMatch.score}점</span>}
      />
      <div style={{flexShrink:0,height:3,background:C.rule}}>
        <div style={{display:"flex",height:"100%"}}>
          {STAGE_META.map((_,i)=><div key={"sc"+i} style={{flex:1,background:SC[i]}}/>)}
        </div>
      </div>
      <div style={{flex:1,overflowY:"auto"}}>
        <div style={{maxWidth:480,margin:"0 auto",padding:"16px 18px"}}>
          <Glass style={{padding:"11px 13px",marginBottom:18}} gold>
            <p style={{fontSize:10,color:C.gold,letterSpacing:".15em",textTransform:"uppercase",marginBottom:3}}>두 페르소나의 역학</p>
            <p style={{fontSize:11,color:C.ink}}>{rep.chemistry||"서로를 발견하는 여정"}</p>
            <p style={{fontSize:10,color:C.dim,marginTop:2}}>{TIER_MAP[simMatch.tier]||""} · {simMatch.score}점</p>
          </Glass>
          {/* ④ 프리미엄 잠금 — 무료 4개 이후 블러 */}
          {STAGE_META.map((meta,i)=>{
            const locked = !isPremium && i>=FREE_STAGES;
            return<div key={meta.l+"-sim"} className="si" style={{display:"flex",gap:10,marginBottom:18,animationDelay:`${i*.04}s`,position:"relative",opacity:locked?.5:1}}>
              {locked&&<div style={{position:"absolute",inset:0,backdropFilter:"blur(4px)",WebkitBackdropFilter:"blur(4px)",zIndex:2,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <span style={{fontSize:12,lineHeight:1.65,color:C.dim}}>🔒 프리미엄</span>
              </div>}
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:20}}>
                <div style={{width:18,height:18,border:`1px solid ${SC[i]}66`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:SC[i],flexShrink:0}}>{meta.icon}</div>
                {i<STAGE_META.length-1&&<div style={{width:1,flex:1,minHeight:8,background:`linear-gradient(${SC[i]}44,transparent)`,marginTop:2}}/>}
              </div>
              <div style={{flex:1}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:10,color:C.ink,fontWeight:500}}>{meta.l}</span>
                  <span style={{fontSize:11,color:C.dim}}>{meta.age}</span>
                </div>
                <p style={{fontSize:12,color:C.dim,lineHeight:1.85,fontWeight:300}}>{locked?"프리미엄에서 볼 수 있어요":stages[i]||"이야기를 만들고 있어요..."}</p>
              </div>
            </div>;
          })}
          {rep.message&&<div style={{padding:18,background:C.ink,color:C.bg,marginTop:8}}>
            <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:17,marginBottom:8}}>"{rep.title}"</p>
            <p style={{fontSize:11,color:"rgba(249,245,239,.7)",marginBottom:14,lineHeight:1.7}}>{rep.why_works}</p>
            <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:14,color:"rgba(249,245,239,.85)"}}>"{rep.message}"</p>
          </div>}
          {rep.share_quote&&<div style={{marginTop:10,padding:"13px",border:`1px solid ${C.rule}`,background:C.paper}}>
            <p style={{fontSize:12,color:C.dim,marginBottom:8}}>"{rep.share_quote}"</p>
            <Btn label="결과 공유하기 ↗" onClick={()=>{
              const otherId=simMatch.user_a===user.id?simMatch.user_b:simMatch.user_a;
              const otherN=userCache[otherId]?.nickname||"상대방";
              shareResult(simMatch,rep,user.nickname,otherN);
            }} full/>
          </div>}
        </div>
      </div>
    </div>;
  }

  // 결과 상세 모달 ⑤⑥⑨
  const ResultModal=({m,onClose})=>{
    const rep=parseRep(m);const conv=parseConv(m);
    const rep=parseRep(m);const conv=parseConv(m);
    const[tab,setTab]=useState("overview");
    const[showReport,setShowReport]=useState(false);
    const otherName=getOtherName(m);
    const otherVec=getOtherVec(m);
    const arc=2*Math.PI*48;
    // ⑪ 수락 가능 여부 (동일 로직)
    const isNew = m.status==="pending" &&
      (m.user_b===user.id || m.initiated_by==="cron" || m.user_a===user.id);
    useEffect(()=>{ DB.markRead(m.id).catch(()=>{}); },[]);

    if(showReport)return<ReportModal
      targetNick={otherName}
      onReport={()=>setShowReport(false)}
      onClose={()=>setShowReport(false)}/>;
    return<div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(26,17,8,.55)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.bg,width:"100%",maxWidth:480,borderRadius:"20px 20px 0 0",maxHeight:"90vh",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"16px 18px 0",flexShrink:0}}>
          <div style={{width:36,height:3,background:C.rule,borderRadius:99,margin:"0 auto 16px"}}/>
          {/* ⑥ 상대방 이름 + 아바타 표시 */}
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
            <Ava vec={otherVec} size={44}/>
            <div style={{flex:1}}>
              <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:20,marginBottom:3}}>{otherName}</p>
              {otherVec?.core_emotion&&<p style={{fontSize:12,lineHeight:1.65,color:C.dim}}>{otherVec.core_emotion} · {ATT_MAP[otherVec.attachment]||""}</p>}
            </div>
            <div style={{textAlign:"right"}}>
              {/* ⑨ Tier 색상 */}
              <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:28,color:tc}}>{m.score||"?"}</span>
              <p style={{fontSize:11,color:tc}}>{TIER_MAP[m.tier]}</p>
            </div>
          </div>
          <div style={{display:"flex",border:`1px solid ${C.rule}`}}>
            {[["개요","overview"],["대화","conv"],["100년","sim"]].map(([l,t])=>(
              <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:"8px 0",background:tab===t?C.ink:"transparent",color:tab===t?C.bg:C.dim,border:"none",fontSize:10,letterSpacing:".08em",textTransform:"uppercase",cursor:"pointer",transition:"all .2s"}}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"14px 18px"}}>
          {tab==="overview"&&<>
            <div style={{textAlign:"center",padding:"14px 0 18px"}}>
              <div style={{position:"relative",width:100,height:100,margin:"0 auto 12px"}}>
                <svg width={100} height={100} style={{transform:"rotate(-90deg)"}}>
                  <circle cx={50} cy={50} r={48} fill="none" stroke="rgba(26,17,8,.08)" strokeWidth={2}/>
                  <circle cx={50} cy={50} r={48} fill="none" stroke={tc} strokeWidth={3} strokeLinecap="round" strokeDasharray={`${(m.score/100)*arc} ${arc}`}/>
                </svg>
                <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                  <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:30,lineHeight:1,color:tc}}>{m.score||"?"}</span>
                  <span style={{fontSize:10,color:C.dim,marginTop:1}}>/ 100</span>
                </div>
              </div>
              <div style={{display:"inline-block",border:`1px solid ${tc}44`,padding:"5px 16px",marginBottom:10}}>
                <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:13,color:tc}}>{m.tier}</span>
                <span style={{fontSize:11,color:C.dim,margin:"0 7px"}}>·</span>
                <span style={{fontSize:11,color:C.dim}}>{TIER_MAP[m.tier]}</span>
              </div>
              {rep.chemistry&&<p style={{fontSize:12,lineHeight:1.65,color:C.dim}}>{rep.chemistry}</p>}
            </div>
            {rule}
            <div style={{padding:"13px 0"}}>
              {rep.best_moment&&<div style={{marginBottom:11}}><p style={{fontSize:11,color:C.dim,letterSpacing:".12em",textTransform:"uppercase",marginBottom:5}}>빛난 순간</p><p style={{fontSize:12,color:C.ink,lineHeight:1.7}}>{rep.best_moment}</p></div>}
              {rep.why_works&&<div style={{marginBottom:11}}><p style={{fontSize:11,color:C.dim,letterSpacing:".12em",textTransform:"uppercase",marginBottom:5}}>잘 맞는 이유</p><p style={{fontSize:12,color:C.ink,lineHeight:1.7}}>{rep.why_works}</p></div>}
              {rep.why_hard&&<div style={{marginBottom:11}}><p style={{fontSize:11,color:C.dim,letterSpacing:".12em",textTransform:"uppercase",marginBottom:5}}>솔직한 어려움</p><p style={{fontSize:12,color:C.ink,lineHeight:1.7}}>{rep.why_hard}</p></div>}
              {rep.verdict&&<Glass style={{padding:"12px 13px"}} gold><p style={{fontSize:11,color:C.gold,letterSpacing:".12em",textTransform:"uppercase",marginBottom:5}}>소울의 판단</p><p style={{fontSize:12,color:C.ink,lineHeight:1.7}}>{rep.verdict}</p></Glass>}
            </div>
          </>}
          {tab==="conv"&&<div style={{paddingTop:8}}>
            <p style={{fontSize:11,color:C.dim,letterSpacing:".12em",textTransform:"uppercase",marginBottom:14}}>페르소나 대화 하이라이트</p>
            {conv.slice(0,10).map((cv,i)=>(
              <div key={cv.speaker+i} className="mi" style={{display:"flex",justifyContent:cv.side==="A"?"flex-start":"flex-end",marginBottom:10}}>
                <div style={{maxWidth:"78%"}}>
                  <p style={{fontSize:11,color:C.dim,marginBottom:2,textAlign:cv.side==="A"?"left":"right"}}>{cv.speaker}</p>
                  <div style={{background:cv.side==="A"?C.paper:cv.side==="A"?C.ink:C.bg:C.ink,color:cv.side==="A"?C.ink:C.bg,padding:"9px 13px",border:`1px solid ${cv.side==="A"?C.rule:C.ink}`}}>
                    <p style={{fontSize:12,lineHeight:1.7}}>{cv.text}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>}
          {tab==="sim"&&(
            // ⑩ 수락 전엔 앞 3스테이지 공개, 나머지 잠금
            m.status!=="accepted" ? <div>
              <SimPreview stages={rep?.stages?.slice(0,3)||[]} onFull={()=>{}}/>
              <div style={{padding:"10px 14px",background:C.paper,border:`1px solid ${C.rule}`,textAlign:"center",marginTop:4}}>
                <p style={{fontSize:11,color:C.dim,marginBottom:6}}>🔒 {(rep?.stages?.length||8)-3}개 스테이지 더 있어요</p>
                <p style={{fontSize:10,color:C.gold}}>수락하면 100년 전체를 볼 수 있어요 ✦</p>
              </div>
            </div> : <div style={{paddingTop:20,textAlign:"center"}}>
              <div style={{fontSize:40,marginBottom:14}}>🔒</div>
              <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:20,marginBottom:8}}>수락 후 열려요</p>
              <p style={{fontSize:12,color:C.dim,lineHeight:1.7,marginBottom:18}}>두 사람의 100년 이야기는<br/>연결된 후에 펼쳐져요</p>
            <Btn label="채팅으로 이동 →" onClick={async()=>{
              try{
                const room=await DB.getChatRoom(m.id);
                if(room){onClose();onOpenChat(m,room);}
              }catch(e){log("chatRoom err:",e.message);}
            }} full/>:
                <p style={{fontSize:11,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:5}}>첫 번째 이야기 미리보기</p>
                <p style={{fontSize:12,color:C.dim,lineHeight:1.7}}>{rep.stages[0]}</p>
              </div>}
              <Btn label="수락하고 100년 보기 ✦" onClick={()=>{onClose();accept(m);}} disabled={!!rejecting} full/>
            </div>
            : rep.stages?.length>0?
            <SimPreview stages={rep.stages} onFull={()=>{onClose();setSimMatch(m);}}/>:
            <div style={{paddingTop:20,textAlign:"center"}}>
              <p style={{fontSize:32,marginBottom:12}}>✦</p>
              <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:18,marginBottom:8}}>수락 후 완성돼요</p>
              <p style={{fontSize:12,lineHeight:1.65,color:C.dim}}>수락하면 100년 이야기를 볼 수 있어요</p>
            </div>
          )}
        </div>
        <div style={{padding:"12px 18px",borderTop:`1px solid ${C.rule}`,flexShrink:0}}>
          {isNew?<div style={{display:"flex",gap:9}}>
            <Btn label="거절" onClick={()=>{onClose();reject(m);}} disabled={rejecting===m.id} ghost full/>
            <Btn label="수락하고 대화 시작 ✦" onClick={()=>{onClose();accept(m);}} disabled={!!rejecting} full/>
          </div>:m.status==="accepted"?
            <Btn label="채팅으로 이동 →" onClick={async()=>{const room=await DB.getChatRoom(m.id);if(room){onClose();onOpenChat(m,room);}}} full/>:
            <p style={{fontSize:11,color:C.dim,textAlign:"center"}}>거절된 매칭이에요</p>}
        </div>
      </div>
    </div>;
  };

  return<div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    <TNav center="매칭 결과" right={<span style={{fontSize:11,color:C.dim}}>{matches.length}개</span>}/>
    <div style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"14px 18px"}}>
        {unread>0&&<div className="pop" style={{padding:"12px 14px",background:C.ink,color:C.bg,marginBottom:14,cursor:"pointer"}} onClick={()=>setSelected(matches.find(m=>m.status==="pending"&&m.user_b===user.id&&!m.read_at))}>
          <p style={{fontSize:12,marginBottom:3}}>💌 새 매칭 결과 {unread}개</p>
          <p style={{fontSize:10,color:"rgba(249,245,239,.6)"}}>페르소나가 누군가를 만났어요 →</p>
        </div>}
        {loading?<Spin text="결과 불러오는 중"/>:matches.length===0?
          <div style={{textAlign:"center",padding:"48px 0"}}>
            <div style={{fontSize:40,marginBottom:14,animation:"float 4s ease-in-out infinite"}}>✦</div>
            <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:22,marginBottom:8}}>아직 매칭 결과가 없어요</p>
            <p style={{fontSize:13,color:C.dim,lineHeight:1.85,marginBottom:24}}>
              소울과 대화할수록 나만의 페르소나가 만들어지고<br/>
              페르소나가 자동으로 소울메이트를 찾아봐요
            </p>
            {/* ⑪ 강화된 CTA */}
            <Btn label="지금 소울과 대화하기 →" onClick={()=>{
              document.dispatchEvent(new CustomEvent("goto-soul"));
            }} full style={{maxWidth:260,margin:"0 auto 10px"}}/>
            <Btn label="매칭 탭에서 직접 시작 →" onClick={()=>{
              document.dispatchEvent(new CustomEvent("goto-matching"));
            }} ghost full style={{maxWidth:260,margin:"0 auto"}}/>
          </div>:
          matches.map(m=>{
            const rep=parseRep(m);
            // ⑪ 수락 가능 — 상대방/cron이 시작한 것, 또는 내가 시작한 것도 수락 가능 (양방향)
            const iCanAccept = m.status==="pending" &&
              (m.user_b===user.id || // 상대가 시작
               m.initiated_by==="cron" || // cron이 시작
               m.user_a===user.id); // 내가 시작한 것도 수락 가능
            const isNew = iCanAccept;
            const isUnread = m.status==="pending" && !m.read_at &&
              (m.user_b===user.id || m.initiated_by==="cron");
            const tc=TIER_COLOR[m.tier]||C.gold;
            const otherName=getOtherName(m);
            return<div key={m.id} style={{marginBottom:10}}>
              <Glass style={{padding:"14px",opacity:m.status==="rejected"?.6:1}} onClick={()=>setSelected(m)}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                  <div style={{display:"flex",gap:10,alignItems:"center"}}>
                    {/* ⑥ 상대방 아바타 + 이름 */}
                    <Ava vec={getOtherVec(m)} size={36}/>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}>
                        <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:16}}>{otherName}</p>
                        {isUnread&&<span style={{fontSize:10,color:C.bg,background:NOTIF_COLOR,padding:"2px 6px"}}>NEW</span>}
                        {!isNew&&<span style={{fontSize:10,color:m.status==="accepted"?C.gold:C.dim,border:`1px solid ${m.status==="accepted"?C.gold:C.rule}`,padding:"2px 6px"}}>
                          {m.status==="accepted"?"연결됨":"거절됨"}
                        </span>}
                      </div>
                      {/* ⑤ 날짜 + 방향 */}
                      <div style={{display:"flex",gap:5,alignItems:"center",marginBottom:2}}>
                        <span style={{fontSize:11,color:C.dim}}>{m.initiated_by==="cron"?"자동 매칭":m.initiated_by===user.id?"내가 시작":"상대방이 시작"}</span>
                        <span style={{fontSize:11,color:C.dim}}>·</span>
                        <span style={{fontSize:11,color:C.dim}}>{m.initiated_by==="cron"?"자동":m.initiated_by===user.id?"내가 시작":"상대 시작"} · {relativeDate(m.created_at)}</span>
                      </div>
                      {rep.chemistry&&<p style={{fontSize:10,color:C.dim}}>{rep.chemistry}</p>}
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:24,color:tc}}>{m.score||"?"}</span>
                    <p style={{fontSize:11,color:tc}}>{TIER_MAP[m.tier]}</p>
                  </div>
                </div>
                {rep.best_moment&&<div style={{padding:"7px 10px",background:"rgba(26,17,8,.03)",marginBottom:10,borderLeft:`2px solid ${tc}66`}}>
                  <p style={{fontSize:10,color:C.dim}}>✦ {rep.best_moment}</p>
                </div>}
                <div style={{display:"flex",gap:8}}>
                  {isNew?<>
                    <Btn label="거절" onClick={e=>{e.stopPropagation();reject(m);}} disabled={rejecting===m.id} ghost full/>
                    <Btn label="수락 ✦" onClick={e=>{e.stopPropagation();accept(m);}} disabled={!!rejecting} full/>
                  </>:<>
                    <Btn label="100년 시뮬 →" onClick={e=>{e.stopPropagation();setSimMatch(m);}} ghost full/>
                    <Btn label="상세 보기" onClick={()=>setSelected(m)} full/>
                  </>}
                </div>
              </Glass>
            </div>;
          })
        }
      </div>
    </div>
    {selected&&<ResultModal m={selected} onClose={()=>setSelected(null)}/>}
    <Toast msg={toast.msg} type={toast.type} onClose={()=>setToast({msg:"",type:"info"})}/>
  </div>;
}


// ⑧ 채팅방 목록 화면
function ChatListScreen({user,chatState,chatRooms,userCache,onOpen,onBack,onUnreadChange}){
  const[rooms,setRooms]=useState([]);
  const[loading,setLoading]=useState(true);

  useEffect(()=>{loadRooms();},[]);

  const loadRooms=async()=>{
    setLoading(true);
    try{
    const matches=await sb("persona_matches","GET",null,
      `?or=(user_a.eq.${user.id},user_b.eq.${user.id})&status=eq.accepted&order=created_at.desc&select=*`
    )||[];

    // ⑥ 상대방 ID 수집 후 일괄 조회
    const otherIds=[...new Set(matches.map(m=>m.user_a===user.id?m.user_b:m.user_a))];
    const otherUsers=otherIds.length>0 ? await DB.getUsersByIds(otherIds) : [];
    const otherMap={};
    otherUsers.forEach(u=>{ otherMap[u.id]=u; });

    // P8: allSettled — 하나 실패해도 나머지 표시
    const settled=await Promise.allSettled(matches.map(async m=>{
      const room=await DB.getChatRoom(m.id);
      if(!room)return null;
      const msgs=await sb("messages","GET",null,
        `?room_id=eq.${room.id}&order=created_at.desc&limit=1`
      )||[];
      const otherId=m.user_a===user.id?m.user_b:m.user_a;
      const other=userCache[otherId]||otherMap[otherId];
      const rep=parseRepSafe(m.report);
      return{match:m,room,lastMsg:msgs[0]||null,otherId,
        otherNick:other?.nickname||"상대방",
        otherVec:other?.soul_vectors?.[0]||null,rep};
    }));
    const roomsData=settled.map(r=>r.status==="fulfilled"?r.value:null);
    const filtered = roomsData.filter(Boolean);
    setRooms(filtered);
    // C. 미읽음 카운트 계산
    const unread = filtered.filter(r=>r.lastMsg&&r.lastMsg.sender_id!==user.id&&!r.lastMsg.read_at).length;
    onUnreadChange?.(unread);
    }catch(e){ log("loadRooms:", e.message); }
    finally{ setLoading(false); }
  };

  // ② 채팅방 있고 chatState도 있으면 ChatScreen 표시
  if(chatState?.match && chatState?.room){
    return<ChatScreen user={user} match={chatState.match} room={chatState.room}
      onBack={()=>onOpen(null,null)}/>; // ② 뒤로가기 → 목록으로 (탭 이동 아님)
  }

  return<div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    <TNav center="채팅"/>
    <div style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"14px 18px"}}>
        {loading?<Spin text="채팅방 불러오는 중"/>:
        rooms.length===0?
          <div style={{textAlign:"center",padding:"48px 0"}}>
            <p style={{fontSize:32,marginBottom:12}}>💬</p>
            <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:20,marginBottom:8}}>아직 채팅방이 없어요</p>
            <p style={{fontSize:13,color:C.dim,lineHeight:1.7,marginBottom:20}}>매칭을 수락하면<br/>여기서 대화를 이어가요</p>
            <Btn label="결과 탭으로 →" onClick={onBack} sm/>
          </div>:
          rooms.map(r=>{
            const tc=TIER_COLOR[r.match?.tier]||C.gold;
            const unread=r.lastMsg&&r.lastMsg.sender_id!==user.id&&!r.lastMsg.read_at;
            return<div key={r.room.id} style={{marginBottom:10}}>
              <Glass style={{padding:"14px",cursor:"pointer"}} onClick={()=>onOpen(r.match,r.room)}>
                <div style={{display:"flex",gap:12,alignItems:"center"}}>
                  <div style={{position:"relative"}}>
                    <Ava vec={r.otherVec} size={46}/>
                    {unread&&<div style={{width:10,height:10,borderRadius:"50%",background:NOTIF_COLOR,position:"absolute",top:0,right:0,border:"2px solid #F9F5EF"}}/>}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:3}}>
                      <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:17}}>{r.otherNick}</span>
                      <span style={{fontSize:11,color:tc}}>{r.match?.score||"-"}점</span>
                    </div>
                    <p style={{fontSize:12,color:unread?C.ink:C.dim,fontWeight:unread?400:300,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {r.lastMsg?r.lastMsg.content:"페르소나끼리 먼저 만났어요 ✦"}
                    </p>
                  </div>
                  <span style={{fontSize:11,color:C.dim,flexShrink:0,marginLeft:8}}>
                    {r.lastMsg?relTime(r.lastMsg.created_at):""}
                  </span>
                </div>
              </Glass>
            </div>;
          })
        }
      </div>
    </div>
  </div>;
}


// ⑤ 아이스브레이커 미션 — 페르소나 대화 기반 질문 카드
function IcebreakerMissions({match, onSend}){
  const rep = parseRepSafe(match.report);
  const conv = parseConvSafe(match.conversation);

  // 페르소나 대화에서 인상적인 순간 추출
  const highlight = conv.find(c=>c.text?.length>15)?.text?.slice(0,30)||"";

  const missions = [
    highlight ? `"${highlight.slice(0,20)}..." 이 말이 인상적이었어요. 어떤 상황에서 그런 생각이 드나요?` : null,
    rep.best_moment ? `페르소나들이 "${rep.best_moment?.slice(0,25)}" 라는 순간을 만들었는데 — 실제로도 그런 경험 있어요?` : null,
    rep.tension_point ? `솔직히 말하면 "${rep.tension_point?.slice(0,20)}" 부분이 걱정되기도 해요. 어떻게 생각해요?` : null,
    "처음 소울이 연결해줬을 때 어떤 느낌이었어요?",
    `${rep.chemistry?.slice(0,15)||"AI 분신"}이라고 하던데 — 그게 진짜 나랑 비슷한 것 같아요?`,
  ].filter(Boolean).slice(0,3);

  if(!missions.length)return null;

  return<div style={{margin:"0 0 16px"}}>
    <p style={{fontSize:11,color:C.dim,letterSpacing:".12em",textTransform:"uppercase",marginBottom:10}}>
      소울이 만든 대화 시작 카드
    </p>
    {missions.map((m,i)=><div key={"ib-"+i} onClick={()=>onSend(m)}
      style={{padding:"11px 13px",background:C.paper,border:`1px solid ${C.rule}`,marginBottom:8,cursor:"pointer",transition:"border .15s"}}
      onMouseEnter={e=>e.currentTarget.style.borderColor=C.gold}
      onMouseLeave={e=>e.currentTarget.style.borderColor=C.rule}>
      <p style={{fontSize:12,color:C.ink,lineHeight:1.6}}>{m}</p>
      <p style={{fontSize:11,color:C.gold,marginTop:4}}>눌러서 보내기 ✦</p>
    </div>)}
  </div>;
}


// E. 주간 케미 리포트 — 채팅 7일 후 소울이 자동 분석
async function generateWeeklyReport(userId, roomId, matchRep, userName, otherName) {
  try{
    const msgs = await sb("messages","GET",null,
      `?room_id=eq.${roomId}&order=created_at.asc&limit=50`
    )||[];
    if(msgs.length < 5) return null; // 대화 5개 미만이면 스킵

    const chatText = msgs.slice(-30).map(m=>
      `${m.sender_id===userId?userName:otherName}: ${m.content}`
    ).join("\n");

    const raw = await ai("관계심리전문가. 따뜻하고 구체적으로. 순수JSON만.",
      `${userName}과 ${otherName}의 실제 대화:
${chatText.slice(0,800)}

페르소나 케미: ${matchRep?.chemistry||""}

JSON만 — 각 항목을 구체적이고 개인적으로 (일반론 금지):
{"weekly_vibe":"이번 주 두 사람만의 분위기 한 줄(20자이내)","best_exchange":"실제 대화에서 가장 빛났던 구체적 순간(35자이내)","chemistry_change":"처음과 달라진 점 구체적으로(30자이내)","next_question":"지금 이 관계에서 꼭 해봐야 할 질문 하나(35자이내)","soul_insight":"소울이 이 관계에서 감지한 것 — 뻔한 말 금지(40자이내)","warning":"조심해야 할 것 한 가지(25자이내)"}`,
      400, null, MODEL_BRAIN
    );
    if(!raw)return null;
    try{ return JSON.parse(raw.replace(/```json|```/g,"").trim()); }catch{ return null; }
  }catch{ return null; }
}

// ════════════════════════════════════════════════════════
// SCREEN: CHAT ⑥
// ════════════════════════════════════════════════════════
function ChatScreen({user,match,room,onBack}){
  const[msgs,setMsgs]=useState([]);
  const[input,setInput]=useState("");
  const[loading,setLoading]=useState(false);
  // ⑥ 상대방 정보
  const[otherUser,setOtherUser]=useState(null);
  const scrollRef=useRef(null);
  const rep=parseRepSafe(match.report); // P2: 중앙화된 파싱
  const tc=TIER_COLOR[match.tier]||C.gold;

  useEffect(()=>{
    // P12: 구독 먼저 — 로드 중 들어오는 메시지 누락 방지
    const seen=new Set();
    const unsub=DB.listenMsgs(room.id,newMsg=>{
      if(!newMsg?.id||seen.has(newMsg.id))return;
      seen.add(newMsg.id);
      setMsgs(prev=>{
        if(prev.some(x=>x.id===newMsg.id))return prev;
        const next=[...prev,newMsg].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
        return next.slice(-300); // FIX D: 최대 300개
      });
    });
    // 구독 후 초기 로드
    loadMsgs().then(msgs=>{ msgs?.forEach(m=>seen.add(m.id)); });
    loadOtherUser();
    return unsub;
  },[]);

  useEffect(()=>{
    if(scrollRef.current){
      scrollRef.current.scrollTo({top:scrollRef.current.scrollHeight,behavior:"smooth"});
    }
  },[msgs]);

  const loadMsgs=async()=>{
    const m=await DB.getMsgs(room.id);
    setMsgs(m);
    // E. 7일 이상 + 30개 이상 대화면 주간 리포트 생성
    if(m.length>=30&&!weeklyReport){
      const oldest=new Date(m[0]?.created_at||0);
      const daysSince=Math.floor((Date.now()-oldest.getTime())/86400000);
      if(daysSince>=7){
        generateWeeklyReport(user.id,room.id,rep,user.nickname,otherUser?.nickname||"상대방")
          .then(r=>r&&setWeeklyReport(r));
      }
    }
    return m; // P12: seen set 초기화용
    // ⑥ 상대방 메시지 읽음 처리
    const unread=m.filter(msg=>msg.sender_id!==user.id&&!msg.read_at);
    if(unread.length>0){
      unread.forEach(msg=>{
        sb("messages","PATCH",{read_at:new Date().toISOString()},`?id=eq.${msg.id}`).catch(()=>{});
      });
    }
  };

  // ⑥ 상대방 정보 로드
  const loadOtherUser=async()=>{
    const otherId=match.user_a===user.id?match.user_b:match.user_a;
    const others=await DB.getUsersByIds([otherId]);
    if(others[0])setOtherUser(others[0]);
  };

  const send=async()=>{
    if(!input.trim()||loading)return;
    if(input.length>500)return; // 길이 제한
    const txt=input;setInput("");
    setLoading(true);
    try{
      await DB.sendMsg(room.id,user.id,txt);
      // ③ AI 페르소나면 자동 응답 — loading 유지
      const otherId=match.user_a===user.id?match.user_b:match.user_a;
      const otherN=otherUser?.nickname||"";
      if(otherN.startsWith("[AI]")){
        await sleep(1000+Math.random()*800);
        const aiSys=buildPersonaSystem(otherUser?.soul_vectors?.[0]||{},otherN.replace("[AI]",""));
        const aiReply=await ai(aiSys,`상대방: "${txt}"\n1~2문장 응답.`,100,null,MODEL_CHAT);
1~2문장 응답.`,100);
        if(aiReply) await DB.sendMsg(room.id,otherId,aiReply);
      }
    }catch(e){ log("send error:",e); }
    finally{ setLoading(false); } // ③ 항상 loading 해제
  };

  const otherVec=otherUser?.soul_vectors?.[0];

  return<div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    {showReport&&<ReportModal
      targetNick={otherUser?.nickname||"상대방"}
      onReport={()=>{setShowReport(false);}}
      onClose={()=>setShowReport(false)}
    />}
    <TNav
      left={<button onClick={onBack} style={{fontSize:18,color:C.dim,background:"none",border:"none",cursor:"pointer",padding:4}}>←</button>}
      center={
        // ⑥ 상대방 이름 + 아바타 + 상태
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            {otherUser&&<Ava vec={otherVec} size={24}/>}
            <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:17}}>{displayNick(otherUser?.nickname||"채팅")}</span>
          </div>
          <p style={{fontSize:9,color:isAI?C.gold:C.dim,letterSpacing:".06em"}}>
            {isAI?"AI 페르소나":"소울 매칭 연결"}
          </p>
        </div>
      }
      right={<div style={{display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:12,color:tc}}>{match.score}점</span>
        <button onClick={()=>setShowReport(true)} style={{fontSize:11,color:C.dim,background:"none",border:"none",cursor:"pointer",padding:4}}>⚑</button>
      </div>}
    />
    {rep.chemistry&&<div style={{padding:"7px 18px",background:C.paper,borderBottom:`1px solid ${C.rule}`,flexShrink:0}}>
      <p style={{fontSize:11,color:C.dim,textAlign:"center"}}>{rep.chemistry} · {TIER_MAP[match.tier]}</p>
    </div>}
    {/* E. 주간 케미 리포트 배너 */}
    {weeklyReport&&<div style={{padding:"10px 18px",background:`${tc}0E`,borderBottom:`1px solid ${tc}33`,flexShrink:0}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
        <span style={{fontSize:14,flexShrink:0}}>✦</span>
        <div style={{flex:1}}>
          <p style={{fontSize:11,color:tc,letterSpacing:".1em",textTransform:"uppercase",marginBottom:3}}>소울의 주간 분석</p>
          <p style={{fontSize:12,color:C.ink,marginBottom:4,fontWeight:500}}>{weeklyReport.weekly_vibe}</p>
          <p style={{fontSize:11,color:C.dim,lineHeight:1.65,marginBottom:4}}>{weeklyReport.soul_insight||weeklyReport.hint}</p>
          {weeklyReport.warning&&<p style={{fontSize:10,color:"#B8915A",marginBottom:6}}>⚠ {weeklyReport.warning}</p>}
          {weeklyReport.next_question&&<p style={{fontSize:11,color:tc,cursor:"pointer",borderTop:`1px solid ${tc}22`,paddingTop:6,marginTop:4}}
            onClick={()=>setInput(weeklyReport.next_question)}>
            소울 추천 질문 → "{weeklyReport.next_question}"
          </p>}
        </div>
        <button onClick={()=>setWeeklyReport(null)} style={{fontSize:14,color:C.dim,background:"none",border:"none",cursor:"pointer",padding:0,flexShrink:0}}>×</button>
      </div>
    </div>}
    <div ref={scrollRef} style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"14px 18px"}}>
        {msgs.map((m,i)=>{
          if(m.sender_id==="system")return<div key={m.id||i} style={{textAlign:"center",margin:"10px 0",padding:"9px 14px",background:`${C.gold}18`,border:`1px solid ${C.gold}33`}}>
            <p style={{fontSize:11,color:C.dim,lineHeight:1.7,whiteSpace:"pre-line"}}>{m.content}</p>
          </div>;
          const isMe=m.sender_id===user.id;
          const isSys=m.sender_id==="system";
          // FIX2: system 메시지 중앙 표시
          if(isSys)return<div key={m.id||i} style={{textAlign:"center",margin:"14px 0 10px"}}>
            <p style={{fontSize:11,color:C.dim,background:C.paper,display:"inline-block",padding:"7px 14px",lineHeight:1.65,whiteSpace:"pre-line",border:`1px solid ${C.rule}`}}>{m.content}</p>
          </div>;
          return<div key={m.id||i} className="mi" style={{display:"flex",justifyContent:isMe?"flex-end":"flex-start",marginBottom:10}}>
            <div style={{maxWidth:"78%"}}>
              {/* ⑥ 상대방 메시지에 이름 표시 */}
              {!isMe&&otherUser&&<p style={{fontSize:11,color:C.dim,marginBottom:3}}>{otherUser.nickname}</p>}
              <div style={{background:isMe?C.ink:C.paper,color:isMe?C.bg:C.ink,padding:"10px 14px",border:`1px solid ${isMe?C.ink:C.rule}`}}>
                <p style={{fontSize:13,lineHeight:1.7}}>{m.content}</p>
              </div>
              <div style={{display:"flex",justifyContent:isMe?"flex-end":"flex-start",alignItems:"center",gap:5,marginTop:2}}>
                {/* ⑥ 읽음 표시 */}
                {isMe&&<span style={{fontSize:11,color:m.read_at?C.gold:C.dim}}>{m.read_at?"읽음":"전송됨"}</span>}
                <p style={{fontSize:11,color:C.dim}}>
                  {new Date(m.created_at).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})}
                </p>
              </div>
            </div>
          </div>;
        })}
        {msgs.filter(m=>m.sender_id!=="system").length===0&&<div style={{padding:"16px 0"}}>
          <div style={{textAlign:"center",marginBottom:16}}>
            <p style={{fontSize:22,marginBottom:8}}>💌</p>
            <p style={{fontSize:13,fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",marginBottom:4}}>페르소나끼리 먼저 만났어요</p>
            <p style={{fontSize:12,lineHeight:1.65,color:C.dim}}>이제 직접 대화를 시작해봐요</p>
          </div>
          {/* ⑤ 아이스브레이커 미션 */}
          <IcebreakerMissions match={match} onSend={txt=>{setInput(txt);setTimeout(()=>document.getElementById("chat-input")?.focus(),100);}}/>
        </div>}
      </div>
    </div>
    <ABar>
      <textarea id="chat-input" value={input}
        onChange={e=>{setInput(e.target.value);e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,100)+"px";}}
        onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}
        placeholder={`${otherUser?.nickname||"상대방"}에게 메시지...`} maxLength={500} rows={1}
        style={{flex:1,background:C.bg,border:`1px solid ${C.rule}`,padding:"11px 13px",fontSize:13,color:C.ink,fontWeight:300,outline:"none",transition:"border .2s",resize:"none",fontFamily:"inherit",lineHeight:1.5,overflow:"hidden"}}
        onFocus={e=>e.target.style.borderColor=C.ink} onBlur={e=>e.target.style.borderColor=C.rule}/>
      <Btn label="전송" onClick={send} disabled={!input.trim()} sm/>
    </ABar>
  </div>;
}


// ② 매칭 프로필 편집 — 지역/나이/성별
function ProfileEditor({user,onUpdate,onMatchRefresh}){
  const[editing,setEditing]=useState(false);
  const[region,setRegion]=useState(user.region||"");
  const[birthYear,setBirthYear]=useState(user.birth_year||"");
  const[gender,setGender]=useState(user.gender||"");
  const[saving,setSaving]=useState(false);
  const[peToast,setPeToast]=useState(""); // D. 저장 toast
  const currentYear=new Date().getFullYear();
  const age=birthYear?currentYear-parseInt(birthYear):null;

  const REGIONS=["서울","경기","인천","부산","대구","대전","광주","울산","세종","강원","충북","충남","전북","전남","경북","경남","제주"];
  const GENDERS=[["M","남성"],["F","여성"],["N","선택 안 함"]];

  const save=async()=>{
    setSaving(true);
    try{
      const data={};
      if(region)data.region=region;
      if(birthYear&&parseInt(birthYear)>1950&&parseInt(birthYear)<currentYear-10)data.birth_year=parseInt(birthYear);
      if(gender)data.gender=gender;
      if(Object.keys(data).length>0){
        await DB.updateUser(user.id,data);
        onUpdate({...user,...data});
      }
      setEditing(false);
      onMatchRefresh?.(); // 3. 매칭탭 자동 갱신
    }catch(e){log("profile save:",e.message);}
    finally{setSaving(false);}
  };

  return<div style={{padding:"14px 0"}}>
    {peToast&&<div style={{padding:"8px 12px",background:peToast.includes("실패")?"#B83232":"#2A6E4A",color:"#fff",fontSize:11,marginBottom:10,textAlign:"center"}}>{peToast}</div>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
      <p style={{fontSize:11,color:C.dim,letterSpacing:".15em",textTransform:"uppercase"}}>매칭 프로필</p>
      {!editing&&<button onClick={()=>setEditing(true)} style={{fontSize:10,color:C.dim,background:"none",border:"none",cursor:"pointer"}}>편집</button>}
    </div>

    {!editing?<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
      {[
        ["지역",user.region||"미설정"],
        ["나이",user.birth_year?`${currentYear-user.birth_year}세`:"미설정"],
        ["성별",{M:"남성",F:"여성",N:"비공개"}[user.gender]||"미설정"],
      ].map(([k,v])=><Glass key={k} style={{padding:"10px 12px"}}>
        <p style={{fontSize:10,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:3}}>{k}</p>
        <p style={{fontSize:12,color:v==="미설정"?C.dim:C.ink}}>{v}</p>
      </Glass>)}
    </div>:
    <div>
      <p style={{fontSize:11,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:6}}>지역</p>
      <select value={region} onChange={e=>setRegion(e.target.value)}
        style={{width:"100%",background:C.bg,border:`1px solid ${C.rule}`,padding:"10px 12px",fontSize:13,color:C.ink,outline:"none",marginBottom:10,fontFamily:"inherit",appearance:"none",borderRadius:0}}>
        <option value="">선택해주세요</option>
        {REGIONS.map(r=><option key={r} value={r}>{r}</option>)}
      </select>

      <p style={{fontSize:11,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:6}}>출생연도</p>
      <input type="number" value={birthYear} onChange={e=>setBirthYear(e.target.value)}
        placeholder="예: 1995" min={1960} max={currentYear-18}
        style={{width:"100%",background:C.bg,border:`1px solid ${C.rule}`,padding:"10px 12px",fontSize:13,color:C.ink,outline:"none",marginBottom:4,fontFamily:"inherit",borderRadius:0}}/>
      {age&&(age<18||age>80)?<p style={{fontSize:11,color:ERROR_COLOR,marginBottom:6}}>올바른 연도를 입력해주세요</p>
       :age?<p style={{fontSize:11,color:C.dim,marginBottom:10}}>{age}세</p>
       :<div style={{marginBottom:10}}/>}

      <p style={{fontSize:11,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:6}}>성별</p>
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        {GENDERS.map(([v,l])=><button key={v} onClick={()=>setGender(v)}
          style={{flex:1,padding:"10px 0",background:gender===v?C.ink:"transparent",color:gender===v?C.bg:C.dim,border:`1px solid ${gender===v?C.ink:C.rule}`,fontSize:12,cursor:"pointer",fontFamily:"inherit",borderRadius:0,transition:"all .15s"}}>
          {l}
        </button>)}
      </div>

      <div style={{display:"flex",gap:9}}>
        <Btn label="취소" onClick={()=>setEditing(false)} ghost full/>
        <Btn label={saving?"저장 중...":"저장"} onClick={save} disabled={saving} full/>
      </div>
    </div>}

    {!editing&&!user.region&&!user.birth_year&&<div style={{marginTop:10,padding:"10px 12px",background:`${C.gold}12`,borderLeft:`3px solid ${C.gold}`}}>
      <p style={{fontSize:11,color:C.dim,lineHeight:1.6}}>프로필을 채우면 더 정확한 매칭이 돼요 ✦</p>
    </div>}
  </div>;
}

// ════════════════════════════════════════════════════════
// SCREEN: ME
// ════════════════════════════════════════════════════════
function MeScreen({user,vec,onUpdate,onMatchRefresh}){
  const[editing,setEditing]=useState(false);
  const[bio,setBio]=useState(user.bio||"");
  const[saving,setSaving]=useState(false);
  const[notif,setNotif]=useState(Notification?.permission==="granted");
  const[confirm,confirmModal]=useConfirm(); // 1. 커스텀 confirm
  const[meToast,setMeToast]=useState({msg:"",type:"info"});
  const pct=user.profile_pct||0;
  const mode=getSoulMode(pct);

  const UNLOCKS=[
    {pct:20,icon:"🔍",label:"탐색 해금",desc:"다른 페르소나 볼 수 있어요"},
    {pct:30,icon:"✦",label:"페르소나 매칭",desc:"AI 분신이 먼저 만나봐요"},
    {pct:30,icon:"🔄",label:"자동 백그라운드 매칭",desc:"매일 자동으로 새 사람을 찾아봐요"},
    {pct:50,icon:"💬",label:"심층 대화 모드",desc:"소울이 더 깊이 파고들어요"},
    {pct:80,icon:"👑",label:"완성된 페르소나",desc:"가장 정확한 매칭"},
  ];

  const save=async()=>{
    if(bio.length>200){setMeToast({msg:"소개는 200자 이내로 써봐요",type:"error"});return;}
    setSaving(true);
    try{
      await DB.updateUser(user.id,{bio});
      onUpdate({...user,bio});
      setEditing(false);
      setMeToast({msg:"저장됐어요 ✦",type:"success"});
    }catch(e){ setMeToast({msg:"저장에 실패했어요. 다시 시도해봐요",type:"error"}); }
    finally{ setSaving(false); }
  };
  const reqNotif=async()=>{const p=await Notification?.requestPermission();setNotif(p==="granted");};

  const meDecay = getDecayInfo(user.last_active); // FIX: 나탭에도 퇴화 표시
  return<div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
    {confirmModal}
    <Toast msg={meToast.msg} type={meToast.type} onClose={()=>setMeToast({msg:"",type:"info"})}/>
    <TNav center="나의 소울" left={<span/>}/>
    <div style={{flex:1,overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"22px 18px"}}>
        {/* ④ 프리미엄 배너 */}
        <div style={{padding:"14px 16px",background:C.ink,color:C.bg,marginBottom:18,display:"flex",alignItems:"center",gap:12}} onClick={()=>{}} // 결제 연동 전 role="button" style={{cursor:"pointer",padding:"14px 16px",background:C.ink,color:C.bg,marginBottom:18,display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:20}}>✦</span>
          <div style={{flex:1}}>
            <p style={{fontSize:12,fontWeight:500,marginBottom:2}}>Soulscope 프리미엄</p>
            <p style={{fontSize:11,color:"rgba(249,245,239,.6)"}}>무제한 매칭 · 100년 전체 · 심층 분석</p>
          </div>
          <span style={{fontSize:11,color:C.gold}}>{PREMIUM_PRICE} →</span>
        </div>
        <div className="a1" style={{padding:"18px",background:vec?.core_emotion?C.ink:C.paper,color:vec?.core_emotion?C.bg:C.ink,marginBottom:18}}>
          <p style={{fontSize:11,letterSpacing:".12em",textTransform:"uppercase",color:vec?.core_emotion?"rgba(249,245,239,.5)":C.dim,marginBottom:10}}>나의 AI 페르소나</p>
          <div style={{display:"flex",alignItems:"center",gap:13,marginBottom:13}}>
            <div style={{width:50,height:50,borderRadius:"50%",background:`${vec?.color||C.gold}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>{vec?.emoji||"✨"}</div>
            <div>
              <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:22,marginBottom:3}}>{user.nickname}</p>
              <p style={{fontSize:11,color:vec?.core_emotion?"rgba(249,245,239,.6)":C.dim}}>{mode.label} · {pct}% 완성</p>
            </div>
          </div>
          <div style={{height:2,background:"rgba(255,255,255,.15)"}}><div style={{height:"100%",width:`${pct}%`,background:vec?.core_emotion?C.gold:mode.color,transition:"width 1s"}}/></div>
          {vec?.core_emotion&&<>
            <p style={{fontSize:11,color:"rgba(249,245,239,.65)",marginTop:7}}>{vec.core_emotion} · {ATT_MAP[vec.attachment]||""} · {LOVE_MAP[vec.love_lang]||""}</p>
            {/* ⑩ 분석 신뢰도 */}
            {vec.confidence>0&&<div style={{display:"flex",alignItems:"center",gap:8,marginTop:6}}>
              <div style={{flex:1,height:2,background:"rgba(255,255,255,.15)"}}>
                <div style={{height:"100%",width:`${vec.confidence}%`,background:"rgba(184,145,90,.7)",transition:"width 1s"}}/>
              </div>
              <span style={{fontSize:11,color:"rgba(249,245,239,.45)"}}>분석 신뢰도 {vec.confidence}%</span>
            </div>}
          </>}
        </div>

        {vec?.core_emotion&&<div className="a2" style={{marginBottom:16}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:9}}>
            {[["핵심 감정",vec.core_emotion],["애착",ATT_MAP[vec.attachment]||vec.attachment],["갈등",vec.conflict==="confronting"?"직면형":vec.conflict==="avoiding"?"회피형":"타협형"],["사랑 언어",LOVE_MAP[vec.love_lang]||vec.love_lang]].filter(([,v])=>v).map(([k,v])=>(
              <Glass key={k} style={{padding:"10px 12px"}}>
                <p style={{fontSize:10,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:3}}>{k}</p>
                <p style={{fontSize:12,lineHeight:1.7,color:C.ink}}>{v}</p>
              </Glass>
            ))}
          </div>
          {vec.fear&&<Glass style={{padding:"11px 13px",marginBottom:8,borderLeft:`3px solid ${C.gold}`}}>
            <p style={{fontSize:10,color:C.gold,letterSpacing:".1em",textTransform:"uppercase",marginBottom:3}}>두려워하는 것</p>
            <p style={{fontSize:12,lineHeight:1.7,color:C.ink}}>"{vec.fear}"</p>
          </Glass>}
          {vec.pattern&&<Glass style={{padding:"11px 13px"}}>
            <p style={{fontSize:10,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:3}}>연애 패턴</p>
            <p style={{fontSize:12,lineHeight:1.7,color:C.ink}}>"{vec.pattern}"</p>
          </Glass>}
          {/* 4. 서술형 페르소나 요약 */}
          {vec._narrative&&<div style={{marginTop:10,padding:"14px 16px",background:C.ink,color:C.bg}}>
            <p style={{fontSize:10,color:`${C.gold}`,letterSpacing:".1em",textTransform:"uppercase",marginBottom:8}}>소울의 분석</p>
            <p style={{fontSize:13,lineHeight:1.85,fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic"}}>{vec._narrative}</p>
          </div>}
          {(vec?.tags||[]).length>0&&<Glass style={{padding:"11px 13px",marginTop:8}}>
            <p style={{fontSize:10,color:C.dim,letterSpacing:".1em",textTransform:"uppercase",marginBottom:6}}>키워드</p>
            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{vec.tags.slice(0,4).map(t=><span key={t} style={{fontSize:10,color:C.dim,border:`1px solid ${C.rule}`,padding:"3px 8px"}}>{t}</span>)}</div>
          </Glass>}
        </div>}

        {rule}
        <div style={{padding:"14px 0"}}>
          <p style={{fontSize:11,color:C.dim,letterSpacing:".15em",textTransform:"uppercase",marginBottom:11}}>해금된 기능</p>
          {UNLOCKS.map((u,i)=>{
            const done=pct>=u.pct;
            return<div key={u.label} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:`1px solid ${C.rule}`,opacity:done?1:.4}}>
              <span style={{fontSize:16}}>{u.icon}</span>
              <div><p style={{fontSize:12,color:C.ink,fontWeight:400}}>{u.label}</p><p style={{fontSize:10,color:C.dim}}>{u.desc}</p></div>
              <div style={{marginLeft:"auto",fontSize:10,color:done?C.gold:C.dim}}>{done?"✓":`${u.pct}% 필요`}</div>
            </div>;
          })}
        </div>

        {rule}
        <div style={{padding:"14px 0"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9}}>
            <p style={{fontSize:11,color:C.dim,letterSpacing:".15em",textTransform:"uppercase"}}>한 줄 소개</p>
            {!editing&&<button onClick={()=>setEditing(true)} style={{fontSize:10,color:C.dim,background:"none",border:"none",cursor:"pointer"}}>편집</button>}
          </div>
          {editing?(<>
            <textarea value={bio} onChange={e=>setBio(e.target.value)} rows={3} style={{width:"100%",background:C.bg,border:`1px solid ${C.ink}`,padding:"11px 13px",fontSize:13,color:C.ink,lineHeight:1.7,marginBottom:9}}/>
            <div style={{display:"flex",gap:8}}>
              <Btn label={saving?"저장 중...":"저장"} onClick={save} disabled={saving} full/>
              <Btn label="취소" onClick={()=>setEditing(false)} ghost full/>
            </div>
          </>):<p style={{fontSize:13,color:bio?C.ink:C.dim,lineHeight:1.7}}>{bio||"아직 소개가 없어요"}</p>}
        </div>

        {rule}
        <div style={{padding:"14px 0"}}>
          <p style={{fontSize:11,color:C.dim,letterSpacing:".15em",textTransform:"uppercase",marginBottom:9}}>알림</p>
          {notif?<p style={{fontSize:12,color:"#5A9A5A"}}>알림 활성화됨 ✓</p>:
            <><p style={{fontSize:12,color:C.dim,marginBottom:10,lineHeight:1.6}}>페르소나가 누군가를 만나면 바로 알려드릴게요</p><Btn label="알림 켜기 🔔" onClick={reqNotif} ghost sm/></>}
        </div>

        {rule}
        {/* ② 매칭 프로필 — 지역/나이/성별 */}
        <ProfileEditor user={user} onUpdate={onUpdate} onMatchRefresh={onMatchRefresh}/>
        {rule}
        <div style={{padding:"14px 0"}}>
          <p style={{fontSize:11,color:C.dim,letterSpacing:".15em",textTransform:"uppercase",marginBottom:8}}>데이터 및 개인정보</p>
          <div style={{background:C.paper,padding:"12px 14px",marginBottom:12}}>
            <p style={{fontSize:11,color:C.dim,lineHeight:1.75,marginBottom:6}}>🔒 대화 내용은 나만 볼 수 있어요</p>
            <p style={{fontSize:11,color:C.dim,lineHeight:1.75,marginBottom:6}}>🤖 AI 페르소나 분석에만 사용돼요</p>
            <p style={{fontSize:11,color:C.dim,lineHeight:1.75}}>🚫 제3자에게 제공되지 않아요</p>
          </div>
          <div style={{display:"flex",gap:16,marginBottom:10}}>
            <span style={{fontSize:11,color:C.dim,textDecoration:"underline",cursor:"pointer"}} onClick={()=>window.open&&window.open(APP_CONFIG.privacyUrl)}>개인정보 처리방침</span>
            <span style={{fontSize:11,color:C.dim,textDecoration:"underline",cursor:"pointer"}} onClick={()=>window.open&&window.open(APP_CONFIG.termsUrl)}>이용약관</span>
          </div>
          <p style={{fontSize:10,color:C.dim,lineHeight:1.65,marginBottom:16}}>
            서비스 운영: Soulscope Inc.<br/>
            문의: hello@soulscope.ai<br/>
            © 2025 Soulscope. All rights reserved.
          </p>
        </div>
        {rule}
        <div style={{padding:"14px 0"}}>
          <p style={{fontSize:11,color:C.dim,letterSpacing:".15em",textTransform:"uppercase",marginBottom:8}}>계정</p>
          <p style={{fontSize:12,color:C.dim,marginBottom:6}}>닉네임 — <span style={{color:C.ink}}>{user.nickname}</span></p>
          <p style={{fontSize:11,color:C.dim,marginBottom:12,lineHeight:1.6}}>
            {user.pin_hash?"PIN 설정됨 ✓":"PIN 미설정 — 다른 기기에서 복구 시 필요해요"}
          </p>
          <Btn label="로그아웃" onClick={()=>{
            localStorage.removeItem(SK);
            localStorage.removeItem("ss_seeded_v1");
            localStorage.removeItem("ss_bg_last");
            localStorage.removeItem("ss_bg_running");
            Object.keys(localStorage).filter(k=>k.startsWith("usage_")||k.startsWith("pin_attempts_")||k.startsWith("matches_")||k.startsWith("soul_hour_")||k==="ss_last_visit").forEach(k=>localStorage.removeItem(k));
            window.location.reload();
          }} ghost sm/>
          {/* D. 회원 탈퇴 — useConfirm */}
          <Btn label="계정 삭제" onClick={async()=>{
            const ok=await confirm("계정을 삭제할까요?",{
              subMsg:"대화 내용과 페르소나가 모두 사라져요. 삭제 후 복구가 불가능해요.",
              confirmLabel:"삭제하기",danger:true
            });
            if(!ok)return;
            try{
              await sb("messages","DELETE",null,`?room_id=in.(select id from chat_rooms where match_id in (select id from persona_matches where user_a=eq.${user.id} or user_b=eq.${user.id}))`).catch(()=>{});
              await sb("chat_rooms","DELETE",null,`?match_id=in.(select id from persona_matches where user_a=eq.${user.id} or user_b=eq.${user.id})`).catch(()=>{});
              await sb("persona_matches","DELETE",null,`?or=(user_a.eq.${user.id},user_b.eq.${user.id})`).catch(()=>{});
              await sb("soul_chats","DELETE",null,`?user_id=eq.${user.id}`).catch(()=>{});
              await sb("soul_vectors","DELETE",null,`?user_id=eq.${user.id}`).catch(()=>{});
              await sb("users","DELETE",null,`?id=eq.${user.id}`).catch(()=>{});
              localStorage.clear();
              window.location.reload();
            }catch(e){setMeToast({msg:"삭제 중 오류가 났어요. 다시 시도해봐요",type:"error"});}
          }} ghost sm style={{color:ERROR_COLOR,borderColor:"#B8323244",marginTop:8}}/>
        </div>
      </div>
    </div>
  </div>;
}

// ════════════════════════════════════════════════════════
// ROOT APP
// ════════════════════════════════════════════════════════

// ⑩ 오프라인 배너
function OfflineBanner(){
  const[offline,setOffline]=useState(!navigator.onLine);
  useEffect(()=>{
    const on=()=>setOffline(false);
    const off=()=>setOffline(true);
    window.addEventListener("online",on);
    window.addEventListener("offline",off);
    return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};
  },[]);
  if(!offline)return null;
  return<div style={{position:"fixed",top:0,left:0,right:0,background:ERROR_COLOR,color:"#fff",
    padding:"9px 18px",fontSize:12,textAlign:"center",zIndex:600,letterSpacing:".04em",
    animation:"fadein .3s ease"}}>
    인터넷 연결이 끊겼어요 · 연결되면 자동으로 복구돼요
  </div>;
}


// Error Boundary — 예상치 못한 에러 방어
class ErrorBoundary extends React.Component {
  constructor(props){super(props);this.state={error:null};}
  static getDerivedStateFromError(e){return{error:e};}
  componentDidCatch(e,info){log("App error:",e.message,info.componentStack?.slice(0,200));}
  render(){
    if(this.state.error)return(
      <div style={{background:"#F9F5EF",height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",padding:"0 28px",textAlign:"center"}}>
        <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:28,marginBottom:12}}>Soulscope</p>
        <p style={{fontSize:14,color:"rgba(26,17,8,.5)",marginBottom:24,lineHeight:1.7}}>잠시 문제가 생겼어요
앱을 새로고침해봐요</p>
        <button onClick={()=>window.location.reload()} style={{background:"#1A1108",color:"#F9F5EF",border:"none",padding:"12px 24px",fontSize:12,letterSpacing:".12em",textTransform:"uppercase",cursor:"pointer"}}>새로고침</button>
      </div>
    );
    return this.props.children;
  }
}

export default function App(){
  const[screen,setScreen]=useState("loading");
  const[user,setUser]=useState(null);
  const[vec,setVec]=useState({});
  const[tab,setTab]=useState("soul");
  const[chatState,setChatState]=useState(null);
  const[notifCount,setNotifCount]=useState(0);
  const[showOnboarding,setShowOnboarding]=useState(false);
  const[userCache,setUserCache]=useState({}); // ⑤ 탭간 유지되는 유저 캐시
  const[chatRooms,setChatRooms]=useState([]); // ⑧ 채팅방 목록

  // 6. 소울이 먼저 말 걸기 — 재방문 시 알림
  useEffect(()=>{
    if(typeof Notification === "undefined") return;
    const scheduleNotif = () => {
      if(Notification.permission !== "granted") return;
      const lastVisit = parseInt(localStorage.getItem("ss_last_visit") || "0");
      const hoursSince = (Date.now() - lastVisit) / 3600000;
      if(hoursSince > 8 && lastVisit > 0){
        const msgs = [
          "오늘 어떤 하루였어요? 소울이 기다리고 있어요 ✦",
          "저번 얘기가 마음에 남아서요 — 오늘 어때요?",
          "소울이에요. 오늘 하루 어떤 감정이 컸어요?",
          "잠깐 들어와봐요. 할 말이 있어요 ✦",
        ];
        const msg = msgs[Math.floor(Math.random() * msgs.length)];
        try{ new Notification("Soulscope ✦", {body:msg, icon:"/public/icon-192.png"}); }catch{}
      }
      localStorage.setItem("ss_last_visit", String(Date.now()));
    };
    scheduleNotif();
  }, []);

  useEffect(()=>{
    init();
    const gotoSoul=()=>setTabSafe("soul");
    const gotoMatching=()=>setTabSafe("matching");
    document.addEventListener("goto-soul",gotoSoul);
    document.addEventListener("goto-matching",gotoMatching);

    // FIX5: 안드로이드 하드웨어 뒤로가기
    const handlePop=()=>{
      // 시트/모달 열려있으면 닫기, 아니면 소울 탭으로
      const sheet=document.getElementById("result-sheet");
      if(sheet&&sheet.style.display!=="none"){
        sheet.style.display="none"; return;
      }
      if(tab!=="soul") setTabSafe("soul");
    };
    window.addEventListener("popstate", handlePop);
    // history 스택에 항목 추가 (뒤로가기 감지용)
    window.history.pushState({ss:true}, "");

    return()=>{
      document.removeEventListener("goto-soul",gotoSoul);
      document.removeEventListener("goto-matching",gotoMatching);
      window.removeEventListener("popstate", handlePop);
    };
  },[]);

  const init=async()=>{
    // ① 타임아웃 — 8초 내 응답 없으면 join으로
    const timeout = new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),INIT_TIMEOUT_MS));
    try{
      await Promise.race([_init(), timeout]);
    }catch{
      setScreen("join"); // ① 에러/타임아웃 모두 join으로
    }
  };

  const _init=async()=>{
    const sess=loadSess();
    if(!sess?.userId){ setScreen("join"); return; }
    const u=await DB.getUser(sess.userId);
    if(!u){ setScreen("join"); return; }
    setUser(u);
    const[v,matches]=await Promise.all([
      DB.getVector(u.id).catch(()=>null),
      DB.getPersonaMatches(u.id).catch(()=>[]),
    ]);
    setVec(v||{});
    // ③ user_a + user_b 양쪽 미읽음 모두 카운트
    const unread=matches.filter(x=>
      x.status==="pending"&&!x.read_at&&
      (x.user_b===u.id||x.initiated_by!==u.id&&x.initiated_by!=="cron")
    ).length;
    setNotifCount(unread);
    // last_active 갱신 (백그라운드)
    sb("users","PATCH",{last_active:new Date().toISOString()},`?id=eq.${u.id}`).catch(()=>{});
    setScreen("main");
  };

  const onJoin=async(u, isNew)=>{
    try{
      setUser(u);setVec({});
      await DB.upsertVector(u.id,{emoji:"✨",color:C.gold,tags:[]}).catch(()=>{});
      seedDummyPersonas().catch(()=>{});
      if(isNew){
        setShowOnboarding(true);
        setScreen("main");
      } else {
        setScreen("main");
      }
    }catch(e){
      log("onJoin error:",e.message);
      setScreen("main"); // 에러나도 메인으로
    }
  };

  const openChat=(match,room)=>{ setChatState({match,room}); setTab("chat"); };

  const setTabSafe=t=>{
    if(t==="chat"&&!chatState){
      // 채팅방 있으면 채팅탭 OK, 없으면 결과탭으로
      if(chatRooms&&chatRooms.length>0){setTab("chat");return;}
      setTab("results");
      return;
    }
    // P9: bio 편집 중 탭 이동 확인
    if(tab==="me"&&t!=="me"){
      const bioArea=document.querySelector("textarea");
      if(bioArea&&bioArea===document.activeElement){
      // bio 편집 중에도 탭 이동 허용 (toast로 알림)
      }
    }
    setTab(t);
  };

  // ② vec + user 동시 업데이트 — 탭간 상태 동기화 보장
  const updatePct=p=>{
    setUser(u=>({...u,profile_pct:p}));
    // pct는 BNav props로 전달됨
  };
  // __ssPct 제거 — BNav pct prop으로 충분
  const updateVecAndPct=(v,p)=>{
    setVec({...v});      // ② 새 객체 생성으로 참조 변경 강제 → 리렌더 유발
    setUser(u=>({...u,profile_pct:p}));
  };

  if(screen==="loading")return<div style={{background:C.bg,height:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
    <style>{CSS}</style>
    <div style={{textAlign:"center"}}>
      <div style={{position:"relative",width:60,height:60,margin:"0 auto 20px"}}>
        <div style={{position:"absolute",inset:0,borderRadius:"50%",background:C.gold,opacity:.08,animation:"wave 2s ease-in-out infinite"}}/>
        <div style={{position:"absolute",inset:8,borderRadius:"50%",background:C.gold,opacity:.12,animation:"wave 2s ease-in-out infinite .3s"}}/>
        <div style={{position:"absolute",inset:16,borderRadius:"50%",background:C.gold,opacity:.2,animation:"wave 2s ease-in-out infinite .6s"}}/>
        <div style={{position:"absolute",inset:22,borderRadius:"50%",background:C.gold,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <span style={{fontSize:14}}>✨</span>
        </div>
      </div>
      <p style={{fontFamily:"'Cormorant',Georgia,serif",fontStyle:"italic",fontSize:26,marginBottom:8,color:C.ink}}>Soulscope</p>
      <p style={{fontSize:11,color:C.dim,letterSpacing:".1em"}}>소울 연결 중...</p>
    </div>
  </div>;

  if(screen==="join")return<div style={{background:C.bg,height:"100vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
    <style>{CSS}</style><JoinScreen onDone={onJoin}/>
  </div>;

  return<ErrorBoundary>
  <div style={{background:C.bg,height:"100vh",overflow:"hidden",display:"flex",flexDirection:"column",paddingTop:"env(safe-area-inset-top,0px)"}}>
    <style>{CSS}</style>
    <OfflineBanner/>
    {/* ⑩ 온보딩 오버레이 */}
    {showOnboarding&&user&&<div style={{position:"fixed",inset:0,zIndex:500,background:C.bg}}>
      <OnboardingScreen nick={user.nickname} onDone={()=>setShowOnboarding(false)}/>
    </div>}
    <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
      {tab==="soul"&&<SoulScreen user={user} vec={vec}
        onVecUpdate={(v,p)=>updateVecAndPct(v,p)}
        onBgMatch={n=>{
          if(n>0) setNotifCount(c=>c+n);
          // FIX4: 0이면 조용히 (백그라운드에서 매칭 안 됨 — 정상)
        }}/>}
      {tab==="matching"&&<MatchingScreen user={user} vec={vec}
        onResult={()=>{setNotifCount(n=>n+1);setTab("results");}}/>}
      {tab==="results"&&<ResultsScreen user={user} vec={vec} onOpenChat={openChat}
        userCacheExt={userCache} onCacheUpdate={setUserCache}
        chatRooms={chatRooms} onRoomsUpdate={setChatRooms}
        onNotifDecrement={()=>setNotifCount(n=>Math.max(0,n-1))}/>}
      {tab==="chat"&&<ChatListScreen
        user={user} chatState={chatState}
        chatRooms={chatRooms} userCache={userCache}
        onOpen={(match,room)=>{ setChatState({match,room}); }}
        onBack={()=>setTab("results")}
        onUnreadChange={setChatUnread}/>}
      {tab==="me"&&<MeScreen user={user} vec={vec}
        onUpdate={u=>{setUser(u);saveSess({...loadSess(),userId:u.id});}}
        onMatchRefresh={()=>{ /* 매칭탭이 활성화될 때 자동 로드됨 — prevPctRef 초기화로 강제 갱신 */ }}
      />}
    </div>
    <BNav tab={tab} set={setTabSafe} notifCount={notifCount} chatUnread={chatUnread} pct={user?.profile_pct||0}/>
  </div>
  </ErrorBoundary>;
}
