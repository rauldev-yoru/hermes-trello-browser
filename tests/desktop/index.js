// Entry point for `node --test tests/desktop/`.
//
// Newer Node versions resolve a directory argument as a module (its index file) instead of
// scanning it, so this file loads the real test files. They can also be run directly:
//   node --test tests/desktop/*.test.mjs
import('./helpers.test.mjs')
  .then(() => import('./render.test.mjs'))
  .then(() => import('./heavy-board.test.mjs'))
  .then(() => import('./markdown.test.mjs'))
