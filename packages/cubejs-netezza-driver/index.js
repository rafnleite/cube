const fromExports = require('./dist/src');
const { NetezzaDriver } = require('./dist/src/NetezzaDriver');

const toExport = NetezzaDriver;

// eslint-disable-next-line no-restricted-syntax
for (const [key, module] of Object.entries(fromExports)) {
  toExport[key] = module;
}

module.exports = toExport;
