/**
 * Sous-chemin public `@stellar/midea-protocol/testing`.
 *
 * Le fake vit dans un import séparé pour que le driver en production ne l'embarque
 * jamais par accident — mais il est bien **publié**, pas caché dans un dossier de
 * test : le driver `midea` s'en sert dans ses suites, et il permet de lancer le
 * driver à la main sans matériel avant l'atelier P4.0.
 */
export * from './fake.js';
export { loadStatusFixture, FIXTURE_NAMES, type FixtureName } from './fixtures.js';
