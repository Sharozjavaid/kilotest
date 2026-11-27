// The app config is app.json; this file only adds what depends on the build's environment.
//
// Android release builds refuse plain-HTTP requests unless the manifest allows cleartext
// traffic. A build pointed at a local server over HTTP (EXPO_PUBLIC_API_URL=http://<LAN IP>:8787,
// see README "Android build") needs it; a build pointed at an https:// API, as store builds
// are, keeps cleartext off.
//
// A store build (EAS profile `production`) must point at the real API and sign in with
// Supabase. Without EXPO_PUBLIC_SUPABASE_URL the app falls back to development sign-in,
// which a production server refuses, so such a build is stopped here instead of shipping.
module.exports = ({ config }) => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? '';
  if (process.env.EAS_BUILD_PROFILE === 'production') {
    const missing = ['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'].filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Production build needs ${missing.join(', ')} (see app/README.md).`);
    if (!/^https:\/\//i.test(apiUrl)) throw new Error('Production build needs an https:// EXPO_PUBLIC_API_URL.');
    if (process.env.EXPO_PUBLIC_MOCK === '1') throw new Error('Production build cannot run against the mock (EXPO_PUBLIC_MOCK=1).');
  }
  const cleartext = /^http:\/\//i.test(apiUrl);
  const buildProperties = {
    android: { usesCleartextTraffic: cleartext },
  };
  return {
    ...config,
    plugins: (config.plugins ?? []).map((p) => (p === 'expo-build-properties' ? ['expo-build-properties', buildProperties] : p)),
  };
};
