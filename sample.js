// Vercel serverless function for "Generate with AI".
// Set ANTHROPIC_API_KEY in Vercel: Project -> Settings -> Environment Variables.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(501).json({ error: 'AI is not set up on this site' });
  const prompt = req.body && req.body.prompt;
  if (typeof prompt !== 'string' || prompt.length > 4000) return res.status(400).json({ error: 'Bad request' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
        max_tokens: 900,
        messages: [{ role: 'user', content: prompt + '\n\nReply with the JSON only, no code fences or extra text.' }]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'AI error' });
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: 'AI request failed' });
  }
};
