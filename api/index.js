// Vercel Serverless Function entry point
// Directly exports the Express application for serverless invocation
const app = require('../server');

module.exports = app;
