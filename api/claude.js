javascriptexport default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { system, messages, max_tokens = 300 } = req.body;

  const enhancedSystem = system + `

절대 규칙:
- 반드시 1~2문장으로만 답할 것. 3문장 이상 금지.
- 질문은 1개만. 절대 2개 이상 금지.
- 조언하지 말 것. 판단하지 말 것.
- 친한 친구처럼 짧고 자연스럽게.
- "~것 같은데", "~해야 해", "~하는 게 좋을 것 같아" 같은 조언 말투 금지.`;

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
        max_tokens: Math.min(max_tokens, 200),
        system: enhancedSystem,
        messages,
      }),
    });
    const d = await r.json();
    res.status(r.ok ? 200 : r.status).json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
