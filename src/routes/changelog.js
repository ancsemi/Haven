'use strict';

// GET /api/changelog?since=X.Y.Z : the release notes since that version, for
// the "What's new" popup after an update (src/changelog.js).

const { sectionsSince, readChangelog } = require('../changelog');

module.exports = function register({ app, verifyToken }) {
  app.get('/api/changelog', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!req.postgresUser && (!token || !verifyToken(token))) return res.status(401).json({ error: 'Unauthorized' });
    const current = require('../../package.json').version;
    const since = typeof req.query.since === 'string' ? req.query.since.slice(0, 40) : '';
    res.json({ current, sections: sectionsSince(readChangelog(), since, current) });
  });
};
