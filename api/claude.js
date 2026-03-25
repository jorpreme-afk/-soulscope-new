export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { system, messages } = req.body;
  const enhanced = system + `

[필수 규칙 - 반드시 지킬 것]
1. 무조건 1문장 또는 2문장으로만 답할 것
2. 질문은 딱 1개만
3. 조언 절대 금지
4. 분석 절대 금지 ("~인 거야", "~자체인 거야" 금지)
5. 그냥 들어주고 질문만 할 것`;

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
        max_tokens: 300,
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
