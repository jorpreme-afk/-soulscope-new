// api/claude.js — Vercel Edge Function v2
// 환경변수: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY

export const config = { runtime: "edge" };

// ① PIN 서버사이드 해시 — 클라이언트 노출 없음
async function hashPin(pin, nick) {
  const data = new TextEncoder().encode(`${pin}::soul::${nick}::2024`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  const isAllowed = origin.includes("vercel.app") || origin.includes("soulscope") || origin.includes("localhost") || origin === "";
  const corsHeaders = {
    "Access-Control-Allow-Origin": isAllowed ? (origin||"*") : "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") return new Response(null, { status:204, headers:corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status:405, headers:corsHeaders });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return new Response(JSON.stringify({error:"ANTHROPIC_API_KEY not configured"}), {
    status:500, headers:{...corsHeaders,"Content-Type":"application/json"}
  });

  try {
    const body = await req.json();

    // ① PIN 해시 요청 처리 (보안 — 서버에서만)
    if (body._action === "hash_pin") {
      const hashed = await hashPin(body.pin, body.nick);
      return new Response(JSON.stringify({hash:hashed}), {
        status:200, headers:{...corsHeaders,"Content-Type":"application/json"}
      });
    }

    // ① PIN 검증 요청 처리
    if (body._action === "verify_pin") {
      const hashed = await hashPin(body.pin, body.nick);
      return new Response(JSON.stringify({ok: hashed === body.stored_hash}), {
        status:200, headers:{...corsHeaders,"Content-Type":"application/json"}
      });
    }

    if (JSON.stringify(body).length > 24000) return new Response("Request too large", { status:413, headers:corsHeaders });

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: body.model || "claude-sonnet-4-20250514",
        max_tokens: Math.min(body.max_tokens || 600, 1500),
        system: body.system || "",
        messages: body.messages || [],
        stream: body.stream || false,
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("Claude API error:", upstream.status, errText);
      return new Response(JSON.stringify({error:"upstream_error",status:upstream.status,detail:errText}), {
        status: upstream.status, headers:{...corsHeaders,"Content-Type":"application/json"}
      });
    }

    if (body.stream) {
      return new Response(upstream.body, {
        status:200,
        headers:{...corsHeaders,"Content-Type":"text/event-stream","Cache-Control":"no-cache","X-Accel-Buffering":"no"},
      });
    }

    const data = await upstream.json();
    return new Response(JSON.stringify(data), {
      status:200, headers:{...corsHeaders,"Content-Type":"application/json"}
    });

  } catch(e) {
    console.error("Proxy error:", e.message);
    return new Response(JSON.stringify({error:"server_error",message:e.message}), {
      status:500, headers:{...corsHeaders,"Content-Type":"application/json"}
    });
  }
}
