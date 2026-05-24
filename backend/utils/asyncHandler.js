// utils/asyncHandler.js
// Wraps async route handlers so thrown errors reach the Express error middleware.
// Import this in controllers — never import from app.js (circular dep risk).

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;