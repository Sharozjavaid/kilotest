// Reanimated and Worklets load through `react-native-reanimated/jest/resolver` (package.json),
// which picks their JS implementations; jest-expo mocks the Expo native modules (glass effect,
// haptics, symbols, blur, @expo/ui). AsyncStorage needs its own mock once a test reaches
// the upload queue, as `@/ui` does through the uploads accessory.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
