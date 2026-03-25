export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { system, messages, max_tokens = 300 } = req.body;
  const enhanced = system + `
절대 규칙: 1~2문장만. 질문 1개만. 조언 금지. 판단 금지. 해결책 제시 금지.
유저가 해결책을 물으면: "해결책보다 지금 어떤 기분인지가 더 궁금해요." 라고 답할 것.
친한 친구처럼 짧고 자연스럽게. 공감하고 질문하는 게 전부.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: enhanced,
        messages,
      }),
    });
    const d = await r.json();
    res.status(r.ok ? 200 : r.status).json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
