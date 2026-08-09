// Compatibility export for integrations that still import this module.
// Parse and its dashboard now live on an internal-only listener; the public
// application exposes the authenticated BFF under /api instead.
const { createParseServer } = require("./services/parse-runtime");

module.exports = { createParseServer };
