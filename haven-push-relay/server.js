#!/usr/bin/env node
const express = require('express'), admin = require('firebase-admin');
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const PORT = process.env.PORT || 4100;
const PUSH_KEY = process.env.HAVEN_PUSH_KEY || '';
function findServiceAccount() {
  const dir = __dirname;
  const candidates = fs.readdirSync(dir).filter(f =>
    f.endsWith('.json') && (f.includes('service-account') || f.includes('adminsdk'))
  );
  if (candidates.length) return path.join(dir, candidates[0]);
  const funcDir = path.join(dir, 'functions');
  if (fs.existsSync(funcDir)) {
    const fc = fs.readdirSync(funcDir).filter(f =>
      f.endsWith('.json') && (f.includes('service-account') || f.includes('adminsdk'))
    );
    if (fc.length) return path.join(funcDir, fc[0]);
  }
  return '';
}
const saPath = process.env.FIREBASE_SERVICE_ACCOUNT || findServiceAccount();
if (!saPath || !fs.existsSync(saPath)) {
  console.error('ERROR: Firebase service account JSON not found.');
  process.exit(1);
}
const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf-8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const messaging = admin.messaging();
console.log(`Firebase project: ${serviceAccount.project_id}`);
if (!PUSH_KEY) {
  const generated = crypto.randomBytes(32).toString('hex');
  console.log(`\nNo HAVEN_PUSH_KEY set. Generated: ${generated}`);
  console.log(`Set: HAVEN_PUSH_KEY=${generated}`);
  console.log(`Haven .env: FCM_RELAY_URL=http://YOUR_HOST:${PORT}/sendPush`);
  console.log(`Haven .env: FCM_PUSH_KEY=${generated}\n`);
  process.env.HAVEN_PUSH_KEY = generated;
}
const app = express();
app.use(express.json({ limit: '100kb' }));
const rateLimits = new Map();
setInterval(() => rateLimits.clear(), 60_000);
app.post('/sendPush', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  const count = (rateLimits.get(ip) || 0) + 1;
  rateLimits.set(ip, count);
  if (count > 60) return res.status(429).json({ error: 'Rate limit exceeded' });
  const key = process.env.HAVEN_PUSH_KEY;
  const provided = req.headers['x-push-key'] || req.body?.pushKey;
  if (!provided || provided !== key) return res.status(403).json({ error: 'Invalid push key' });
  const { tokens, title, body, data } = req.body;
  if (!tokens || !Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array required' });
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title string required' });
  if (!body || typeof body !== 'string') return res.status(400).json({ error: 'body string required' });
  if (tokens.length > 500) return res.status(400).json({ error: 'Max 500 tokens per request' });
  try {
    const message = {
      tokens, notification: { title, body },
      data: data && typeof data === 'object'
        ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
        : {},
      android: { priority: 'high', notification: { channelId: 'haven_messages' } },
    };
    const response = await messaging.sendEachForMulticast(message);
    const failedTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error) {
        const code = resp.error.code;
        if (code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered') failedTokens.push(tokens[idx]);
      }
    });
    console.log(`Push: ${response.successCount} sent, ${response.failureCount} failed`);
    res.json({ success: response.successCount, failure: response.failureCount, failedTokens });
  } catch (err) {
    console.error('FCM send error:', err.message);
    res.status(500).json({ error: 'FCM send failed' });
  }
});
app.get('/', (req, res) => res.json({ status: 'ok', service: 'haven-push-relay' }));
app.listen(PORT, () => {
  console.log(`Haven Push Relay running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/sendPush`);
});
