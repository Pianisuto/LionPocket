const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const repoRoot = path.resolve(__dirname, '../..');

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [repoRoot],
  resolver: {
    nodeModulesPaths: [
      path.join(__dirname, 'node_modules'),
      path.join(repoRoot, 'node_modules'),
    ],
  },
});
