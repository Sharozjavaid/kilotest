// The app config is app.json; this file only adds what depends on the build's environment.
//
// Android release builds refuse plain-HTTP requests unless the manifest allows cleartext
// traffic. A build pointed at a local server over HTTP (EXPO_PUBLIC_API_URL=http://<LAN IP>:8787,
// see README "Android build") needs it; a build pointed at an https:// API, as store builds
// are, keeps cleartext off.
module.exports = ({ config }) => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? '';
  const cleartext = /^http:\/\//i.test(apiUrl);
  const buildProperties = {
    android: { usesCleartextTraffic: cleartext },
  };
  return {
    ...config,
    plugins: (config.plugins ?? []).map((p) => (p === 'expo-build-properties' ? ['expo-build-properties', buildProperties] : p)),
  };
};
