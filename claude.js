export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { system, messages, max_tokens = 500 } = req.body;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens, system, messages }),
    });
    const d = await r.json();
    res.status(r.ok ? 200 : r.status).json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
