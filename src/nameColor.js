'use strict';

// Which role colors your name. By default it is your highest role that
// shows; someone who holds several colored roles can pick another of them
// for their own name (Settings > Role Display). Only the name color moves:
// the role shown as theirs, its badge and its icon stay the highest role's.
//
// The choice is a role id in user_preferences under `name_color_role`, and it
// is checked against the roles the person holds every time it is read, so a
// role that was taken away or deleted simply stops counting.

const PREF = 'name_color_role';

// The roles a person can pick from, out of the roles they hold: the ones
// that show (not transparent) and have a color.
function colorChoices(roles) {
  return (roles || []).filter(r => r && !r.transparent && r.color);
}

function chosenRoleId(db, userId) {
  const row = db.prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?').get(userId, PREF);
  const id = row ? Number(row.value) : 0;
  return Number.isInteger(id) && id > 0 ? id : null;
}

// `highest` with the chosen role's colors on it. The highest role's own
// colors ride along as own_*, for the places that draw the role itself.
function withNameColor(db, userId, highest, roles) {
  if (!highest) return highest;
  const choices = colorChoices(roles);
  // Nothing to choose between: skip the lookup, this runs for every member.
  if (!choices.some(r => r.id !== highest.id)) return highest;
  let chosen = null;
  try {
    chosen = chosenRoleId(db, userId);
  } catch (err) {
    console.warn('[name color] could not read the choice:', err.message);
    return highest;
  }
  const pick = chosen && chosen !== highest.id ? choices.find(r => r.id === chosen) : null;
  if (!pick) return highest;
  return {
    ...highest,
    color: pick.color,
    color2: pick.color2 || null,
    color_shimmer: pick.color2 ? pick.color_shimmer : 0,
    own_color: highest.color || null,
    own_color2: highest.color2 || null,
    own_color_shimmer: highest.color2 ? highest.color_shimmer : 0,
  };
}

function setChoice(db, userId, roleId) {
  if (roleId == null) {
    db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND key = ?').run(userId, PREF);
    return;
  }
  db.prepare('INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)').run(userId, PREF, String(roleId));
}

module.exports = { PREF, colorChoices, chosenRoleId, withNameColor, setChoice };
