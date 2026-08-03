import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Manifest } from '@stellar/contracts';
import { buildManifest, indexMappingTable, loadMappingTable } from './mapping-table.js';

const SHIPPED_TABLE = fileURLToPath(
  new URL('../../../../config/z2m-mapping.json', import.meta.url),
);

const device = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  friendlyName: 'temp_salon',
  model: 'SNZB-02D',
  room: 'salon',
  entities: [{ entityId: 'temp_salon', kind: 'temperature', field: 'temperature', unit: '°C' }],
  ...over,
});

describe('table de mapping', () => {
  it('charge la table versionnée du dépôt', async () => {
    const index = await loadMappingTable(SHIPPED_TABLE);

    expect(index.byFriendlyName.size).toBe(6);
    expect(index.entityIds).toEqual([
      'temp_salon',
      'humidity_salon',
      'temp_entree',
      'humidity_entree',
      'temp_chambre',
      'humidity_chambre',
      'presence_salon',
      'presence_entree',
      'power_maison',
    ]);
    // `room: null` (ZLinky) est accepté et vaut « pas de pièce ».
    expect(index.byFriendlyName.get('zlinky')?.room).toBeNull();
  });

  it('produit un manifeste conforme au contrat, sans commande (des capteurs)', async () => {
    const index = await loadMappingTable(SHIPPED_TABLE);
    const manifest = Manifest.parse(buildManifest(index, 'z2m', '0.1.0'));

    expect(manifest.commands).toEqual([]);
    expect(manifest.entities).toHaveLength(index.entityIds.length);
    expect(manifest.entities[0]).toEqual({
      id: 'temp_salon',
      kind: 'temperature',
      room: 'salon',
      unit: '°C',
    });
    // ZLinky : pas de pièce → pas de champ `room` dans la déclaration.
    expect(manifest.entities.at(-1)).toEqual({ id: 'power_maison', kind: 'power', unit: 'VA' });
  });

  it('accepte un champ composé et un facteur d’échelle', () => {
    const index = indexMappingTable({
      devices: [
        device({
          friendlyName: 'zlinky',
          room: null,
          entities: [
            {
              entityId: 'power_maison',
              kind: 'power',
              fields: {
                va: 'apparent_power',
                indexBase: { field: 'current_summ_delivered', scale: 0.001 },
              },
            },
          ],
        }),
      ],
    });

    expect(index.entityIds).toEqual(['power_maison']);
  });

  it('refuse deux devices de même friendlyName', () => {
    expect(() =>
      indexMappingTable({
        devices: [
          device(),
          device({
            entities: [{ entityId: 'humidity_salon', kind: 'humidity', field: 'humidity' }],
          }),
        ],
      }),
    ).toThrow(/friendlyName en double/);
  });

  it('refuse deux entités de même entityId', () => {
    expect(() =>
      indexMappingTable({ devices: [device(), device({ friendlyName: 'temp_salon_bis' })] }),
    ).toThrow(/entityId en double/);
  });

  it('refuse une faute de frappe dans une entité plutôt que de l’ignorer', () => {
    expect(() =>
      indexMappingTable({
        devices: [
          device({
            entities: [{ entityId: 'temp_salon', kind: 'temperature', feild: 'temperature' }],
          }),
        ],
      }),
    ).toThrow();
  });

  it('refuse un kind hors contrat', () => {
    expect(() =>
      indexMappingTable({
        devices: [
          device({ entities: [{ entityId: 'x', kind: 'luminosite', field: 'illuminance' }] }),
        ],
      }),
    ).toThrow();
  });

  it('explique clairement un fichier de table manquant', async () => {
    await expect(loadMappingTable('config/pas-de-table.json')).rejects.toThrow(
      /table de mapping introuvable/,
    );
  });
});
