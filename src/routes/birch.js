'use strict';
module.exports = function register({ app, verifyToken, birch }) {
  app.get('/api/birch/status', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = req.postgresUser || (token && verifyToken(token));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { available, reason } = await birch.status();
    res.set('Cache-Control', 'no-store');
    res.json(user.isAdmin ? { enabled: available, reason } : { enabled: available });
  });
};
