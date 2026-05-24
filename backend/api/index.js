// Vercel serverless entry point
// IMPORTANT: require('../app') must match exactly what app.js exports.
// app.js does: module.exports = app   (plain export)
// So we require it as a plain value — NOT const { app } = require(...)
const app = require('../app');
module.exports = (req, res) => app(req, res);
