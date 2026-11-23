const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();
const messaging = admin.messaging();
const havenPushKey = defineSecret("HAVEN_PUSH_KEY");
exports.sendPush = onRequest(
  { cors: true, maxInstances: 10, secrets: [havenPushKey] },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const relayKey = havenPushKey.value();
    if (!relayKey) { console.error("HAVEN_PUSH_KEY not configured"); return res.status(500).json({ error: "Relay not configured" }); }
    const providedKey = req.headers["x-push-key"] || req.body?.pushKey;
    if (!providedKey || providedKey !== relayKey) return res.status(403).json({ error: "Invalid push key" });
    const { tokens, title, body, data, sealed } = req.body;
    if (!tokens || !Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: "tokens array required" });
    if (!title || typeof title !== "string") return res.status(400).json({ error: "title string required" });
    if (!body || typeof body !== "string") return res.status(400).json({ error: "body string required" });
    if (tokens.length > 500) return res.status(400).json({ error: "Max 500 tokens per request" });
    try {
      const message = {
        tokens, notification: { title, body },
        data: data && typeof data === "object"
          ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
          : {},
        android: { priority: "high", notification: { channelId: "haven_messages" } },
      };
      const isSealed = (t) => sealed && typeof sealed === "object" && Object.hasOwn(sealed, t) && typeof sealed[t] === "string";
      const { tokens: _all, ...shared } = message;
      const response = tokens.some(isSealed)
        ? await messaging.sendEach(tokens.map((token) => isSealed(token)
          ? { token, data: { enc: sealed[token] }, android: { priority: "high" }, apns: { headers: { "apns-priority": "10", "apns-push-type": "alert" }, payload: { aps: { alert: { title, body }, sound: "default", mutableContent: true } } } }
          : { ...shared, token }))
        : await messaging.sendEachForMulticast(message);
      const failedTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          const code = resp.error.code;
          if (code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered") failedTokens.push(tokens[idx]);
        }
      });
      res.json({ success: response.successCount, failure: response.failureCount, failedTokens });
    } catch (err) {
      console.error("FCM send error:", err);
      res.status(500).json({ error: "FCM send failed" });
    }
  }
);
