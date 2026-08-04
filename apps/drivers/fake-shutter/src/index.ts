/**
 * Surface publique du package.
 *
 * Elle pointe sur les **sources** (`exports` du package.json), comme les
 * simulateurs : les tests qui montent une maison complète consomment ce driver
 * sans build préalable. Le process de production, lui, se lance par son `bin`
 * (`stellar-fake-shutter` → `dist/main.js`).
 */
export {
  buildManifest,
  startFakeShutterDriver,
  DEFAULT_SPEED_MS,
  DRIVER_NAME,
  DRIVER_VERSION,
  POSITION_CLOSED,
  POSITION_OPEN,
  SetParams,
  STEP_PERCENT,
  type FakeShutterHandle,
  type FakeShutterOptions,
} from './driver.js';
export { loadConfig, DriverConfig } from './config.js';
