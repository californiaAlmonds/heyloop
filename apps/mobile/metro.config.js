const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Shared packages use NodeNext-style `./x.js` imports that point at `.ts` sources.
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js') && /\.tsx?$/.test(context.originModulePath)) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform);
    } catch {
      // Fall through to the literal .js path.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
