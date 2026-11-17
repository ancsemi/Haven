'use strict';

// Audit log entries for actions taken over HTTP (uploads, backups, imports,
// maintenance). The log itself lives with the socket handlers, which start
// after the routes are registered, so server.js hands it over here once it
// exists. An entry made before then is dropped with a warning: routes only
// run once the server is listening, after the handover.

let sink = null;

function setAuditSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

// user: the signed-in user from the request's token ({ id, username, ... }).
function auditHttp(user, action, entry = {}) {
  if (!sink) {
    console.warn(`[audit] ${action} not recorded: the audit log is not ready`);
    return;
  }
  const actor = user && Number.isInteger(user.id)
    ? { id: user.id, username: user.username, displayName: user.displayName || user.display_name || user.username }
    : null;
  return sink({ actor, action, ...entry });
}

module.exports = { setAuditSink, auditHttp };
