export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { passord } = req.body || {};
  const riktigPassord = process.env.DASHBOARD_PASSWORD;

  if (!riktigPassord) {
    return res.status(500).json({ error: 'DASHBOARD_PASSWORD ikke satt' });
  }

  if (passord === riktigPassord) {
    res.setHeader('Set-Cookie', `rebil_auth=${riktigPassord}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`);
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ error: 'Feil passord' });
}
