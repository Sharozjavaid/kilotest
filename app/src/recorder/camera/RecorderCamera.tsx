/**
 * Type-checking entry only. Metro always resolves the platform files first:
 * RecorderCamera.native.tsx on iOS/Android, RecorderCamera.web.tsx on web.
 */
export { RecorderCamera, useRecorderPermissions } from './RecorderCamera.web';
