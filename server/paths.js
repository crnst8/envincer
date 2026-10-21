const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.ENVINCER_DATA || path.join(ROOT, 'data'));

module.exports = { ROOT, DATA_DIR };
