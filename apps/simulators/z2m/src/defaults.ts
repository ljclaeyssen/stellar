import type { SimZ2mDeviceSpec } from './sim.js';

/**
 * Parc simulé par défaut — le miroir exact de `config/z2m-mapping.json`
 * (3 SNZB-02D, 2 mmWave, 1 ZLinky), plus un intrus **non mappé** pour que le
 * chemin d'extensibilité de la spec §13 se voie à l'œil nu dans les logs du
 * driver lancé à la main.
 *
 * Les fixtures sont celles du driver (`apps/drivers/z2m-normalizer/__fixtures__`) :
 * une seule source de vérité à recaler le jour du branchement matériel.
 */
export const DEFAULT_FIXTURES_DIR = 'apps/drivers/z2m-normalizer/__fixtures__';

export const DEFAULT_DEVICES: readonly SimZ2mDeviceSpec[] = [
  { friendlyName: 'temp_salon', payloadFile: 'snzb-02d.json' },
  { friendlyName: 'temp_entree', payloadFile: 'snzb-02d.json' },
  { friendlyName: 'temp_chambre', payloadFile: 'snzb-02d.json' },
  { friendlyName: 'presence_salon', payloadFile: 'zy-m100.json' },
  { friendlyName: 'presence_entree', payloadFile: 'zy-m100.json' },
  { friendlyName: 'zlinky', payloadFile: 'zlinky-tic.json' },
  { friendlyName: 'capteur_pas_encore_mappe', payloadFile: 'snzb-02d.json' },
];
