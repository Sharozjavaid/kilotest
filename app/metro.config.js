// Metro config. `@kilo/edl` is a symlinked package outside the app root
// (`file:../packages/edl`) with its own node_modules (zod), so Metro must watch it
// and be allowed to resolve modules from there.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const edlRoot = path.resolve(projectRoot, '../packages/edl');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), edlRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(edlRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;
// The mock proxy video ships as an asset.
config.resolver.assetExts = Array.from(new Set([...config.resolver.assetExts, 'mp4']));

module.exports = config;
