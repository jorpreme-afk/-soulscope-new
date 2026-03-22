// api/claude.js — Vercel Edge Function
// 이 파일을 /api/claude.js 에 놓으면 Vercel이 자동으로 서버리스 함수로 배포해줘요
// 환경변수: Vercel Dashboard > Settings > Environment Variables > ANTHROPIC_API_KEY

export const config = { runtime: "edge" };

const ALLOWED_ORIGINS = [
  "https://soulscope.ai",
  "https://www.soulscope.ai",
  "http://localhost:3000",  // 개발용
  "http://localhost:5173",  // Vite 개발용
];

export default async function handler(req) {
  // CORS
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // 요청 크기 제한 (프롬프트 인젝션 방지)
    const bodyStr = JSON.stringify(body);
    if (bodyStr.length > 20000) {
      return new Response("Request too large", { status: 413, headers: corsHeaders });
    }

    // Claude API 호출 (키는 서버에서만)
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: body.model || "claude-sonnet-4-20250514",
        max_tokens: Math.min(body.max_tokens || 600, 1000), // 최대 1000 제한
        system: body.system,
        messages: body.messages,
        // 스트리밍 지원
        stream: body.stream || false,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Claude API error:", err);
      return new Response("AI 서비스 오류", { status: 502, headers: corsHeaders });
    }

    // 스트리밍 응답 그대로 전달
    if (body.stream) {
      return new Response(response.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("Proxy error:", e);
    return new Response("서버 오류", { status: 500, headers: corsHeaders });
  }
}
