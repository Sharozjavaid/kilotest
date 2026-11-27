// Metro config. `@kilo/edl` is a symlinked package outside the app root
// (`file:../packages/edl`) with its own node_modules (zod), so Metro must watch it
// and be allowed to resolve modules from there.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { wrapWithReanimatedMetroConfig } = require('react-native-reanimated/metro-config');

const projectRoot = __dirname;
const edlRoot = path.resolve(projectRoot, '../packages/edl');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), edlRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(edlRoot, 'node_modules'),
];

// Reanimated's wrapper only folds its own frames out of error stacks (worklets need no Metro
// setup: babel-preset-expo adds the react-native-worklets plugin when the package is installed).
module.exports = wrapWithReanimatedMetroConfig(config);
