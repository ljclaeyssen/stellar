# ADR-008 — Signature sendCommand : le driver destinataire est une option de transport

2026-08-03 · Statut : accepté

## Contexte

La spec §8 définit `bus.sendCommand(cmd, {timeoutMs})`, mais le topic §6
`home/cmd/<driver>/<entityId>` exige de connaître le driver destinataire. La
règle n°7 interdit à core/agent de référencer un driver par son nom **dans leur
logique**.

## Décision

`bus.sendCommand(cmd, { driver, timeoutMs })` : le nom du driver est un
paramètre de **transport**, résolu par l'appelant. Dans le core, l'unique point
autorisé à le résoudre est le miroir (`entity.driver` de l'entité ciblée) — la
logique manipule des sélecteurs, jamais des noms. Le CLI le prend en argument
(outillage, autorisé).

## Conséquences

- Le core exposera un helper `sendToEntity(selector|id, action, params)` qui
  fait la résolution miroir → aucun nom de driver ne circule dans la
  régulation ni l'agent.
- Une règle ESLint `no-restricted-syntax` sur `apps/core`/`apps/agent`
  mécanisera l'interdit (noms de drivers en littéraux).

## Alternatives écartées

- Résolution implicite dans le bus (cache d'états interne) : magie cachée,
  couple le bus au miroir.
- Topic sans driver (`home/cmd/<entityId>`) : contredit la spec §6 et perd le
  routage par souscription driver.
