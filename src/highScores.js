'use strict';

// A high score is whatever number the game's page reports, so only whole,
// exactly representable numbers within a believable range are kept. Without
// a ceiling, one posted 1e300 tops the board for good.
const DEFAULT_MAX_SCORE = 1_000_000_000;
const MAX_SCORE_BY_GAME = {
  flappy: 100_000,
  'arcade-pool': 4_000,
  'arcade-minigolf': 1_000,
};

// The games that report scores: the Activities games (src/activity.js,
// HAVEN_GAMES). Any other id would only add rows nobody can see.
const KNOWN_GAMES = new Set([
  'flappy', 'flight', 'learn-to-fly-3', 'bubble-tanks-3', 'tanks', 'super-smash-flash-2', 'io-games',
  'arcade-pool', 'arcade-minigolf',
]);
function isKnownGame(game) {
  return typeof game === 'string' && KNOWN_GAMES.has(game);
}

// The score to store, or null when it is not one.
function validHighScore(game, score) {
  if (!Number.isSafeInteger(score) || score < 0) return null;
  const max = Object.prototype.hasOwnProperty.call(MAX_SCORE_BY_GAME, game) ? MAX_SCORE_BY_GAME[game] : DEFAULT_MAX_SCORE;
  return score <= max ? score : null;
}

module.exports = { validHighScore, isKnownGame, KNOWN_GAMES, DEFAULT_MAX_SCORE, MAX_SCORE_BY_GAME };
