// Vercel Serverless Function entry point
const app = require('../server');

module.exports = (req, res) => {
    return app(req, res);
};
