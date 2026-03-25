// api/cron-match.js — Vercel Cron Job
// ③ 진짜 백그라운드 매칭 — 앱 꺼져 있어도 실행
// vercel.json의 crons 설정으로 매일 새벽 3시 실행

export const config = { runtime: "edge" };

const SB_URL = process.env.VITE_SUPABASE_URL || "https://tyxvuscqdnyhehmkcxfw.supabase.co";
const SB_KEY = process.env.VITE_SUPABASE_KEY || "sb_publishable_Dl4Bf62VEFxs0R94oZAwqw_Q-Z7jMIm";
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

async function db(table, method="GET", body=null, query="") {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, {
    method,
    headers: {
      "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", "Prefer": "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function ai(system, userMsg, maxTokens=400) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":CLAUDE_KEY,"anthropic-version":"2023-06-01"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514",
      max_tokens:maxTokens,
      system,
      messages:[{role:"user",content:userMsg}],
    }),
  });
  const d = await r.json();
  return d.content?.[0]?.text || "";
}

// 두 벡터 간 궁합 점수 계산
function calcScore(vA, vB) {
  const attBonus = {
    "anxious+secure":12,"secure+secure":6,"avoidant+secure":2,
    "anxious+anxious":-14,"avoidant+avoidant":-12,"anxious+avoidant":-18,
  };
  const attKey = vA.attachment && vB.attachment
    ? [vA.attachment,vB.attachment].sort().join("+") : "";
  const bonus = attBonus[attKey]||0;
  const confBonus = vA.conflict&&vB.conflict&&vA.conflict!==vB.conflict ? 10 : -3;
  const loveBonus = vA.love_lang&&vA.love_lang===vB.love_lang ? 7 : 0;
  return Math.max(30, Math.min(99, 65 + bonus + confBonus + loveBonus));
}

export default async function handler(req) {
  // Vercel Cron 인증 확인
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    // 활성 유저 가져오기 (최근 7일 이내)
    const since = new Date(Date.now() - 7*24*60*60*1000).toISOString();
    const users = await db("users","GET",null,
      `?profile_pct=gte.30&last_active=gte.${since}&select=*,soul_vectors(*)&limit=100`) || [];

    let matched = 0;

    for (const user of users) {
      const vec = user.soul_vectors?.[0];
      if (!vec?.core_emotion) continue;

      // 이미 매칭된 사람들
      const existing = await db("persona_matches","GET",null,
        `?or=(user_a.eq.${user.id},user_b.eq.${user.id})&select=user_a,user_b,status`) || [];
      const skip = new Set(existing.map(m => m.user_a===user.id ? m.user_b : m.user_a));

      // 후보 찾기
      const candidates = users.filter(u =>
        u.id !== user.id &&
        !skip.has(u.id) &&
        u.soul_vectors?.[0]?.core_emotion
      );

      if (candidates.length === 0) continue;

      // 상위 1명과 매칭
      const scored = candidates.map(u => ({
        ...u,
        _score: calcScore(vec, u.soul_vectors?.[0]||{})
      })).sort((a,b) => b._score - a._score);

      const target = scored[0];
      const tVec = target.soul_vectors?.[0]||{};

      // 간단한 리포트 생성
      const reportRaw = await ai("관계심리전문가. 순수JSON만.",
        `A: ${JSON.stringify({...vec,name:user.nickname}).slice(0,200)}\nB: ${JSON.stringify({...tVec,name:target.nickname}).slice(0,200)}\n점수:${target._score}\nJSON:{"title":"20자","chemistry":"25자","best_moment":"35자","why_works":"35자","verdict":"35자"}`,
        300
      );

      let report = {};
      try { report = JSON.parse(reportRaw.replace(/```json|```/g,"").trim()); } catch {}

      const tier = target._score>=90?"FATE":target._score>=80?"SOUL":target._score>=68?"MATCH":target._score>=55?"BOND":"GROW";
      const [a,b] = [user.id, target.id].sort();

      await db("persona_matches","POST",{
        user_a:a, user_b:b,
        score:target._score, tier,
        conversation:"[]",
        report:JSON.stringify({...report,stages:[]}),
        status:"pending",
        initiated_by:"cron",
      },"?on_conflict=user_a,user_b");

      matched++;
      if (matched >= 10) break; // 1회 실행당 최대 10건
    }

    return new Response(JSON.stringify({ok:true, matched}), {
      status:200, headers:{"Content-Type":"application/json"}
    });

  } catch(e) {
    return new Response(JSON.stringify({error:e.message}), {
      status:500, headers:{"Content-Type":"application/json"}
    });
  }
}

// ⑥ 타임아웃 안전 처리 — 저장 전 충분한 데이터 확인
// (이미 conv.length < 4 체크가 있음 — 추가로 report 검증)
