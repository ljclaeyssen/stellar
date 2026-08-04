# systemd — gabarits P5

Non utilisés en dev (Mac / tour Windows) : ils servent au N100 en P5, quand core et
drivers deviennent des services permanents.

Installation (sur le N100) : copier les `.service` dans `/etc/systemd/system/`, créer
l'`EnvironmentFile` correspondant dans `/etc/stellar/` (root:stellar, chmod 0640 —
il peut contenir des credentials MQTT), puis
`systemctl daemon-reload && systemctl enable --now stellar-core`.

# systemd — gabarits P7 (à déplacer)

> **Hors périmètre de la phase** : ces trois unités ont vocation à vivre dans
> `infra/systemd/` avec celles du core et des drivers. Elles sont déposées ici parce
> que la session P7 avait `apps/agent/**` pour périmètre — l'orchestrateur les
> déplacera, sans modification.

- `stellar-agent.service` — le service permanent (prise HTTP loopback, `POST /turn`).
- `stellar-agent-planner.service` — un brief du matin, puis sortie (`Type=oneshot`).
- `stellar-agent-planner.timer` — déclenche le précédent à 7 h (spec §11).

Installation (sur le N100, cf. `infra/systemd/README.md`) :

```sh
cp stellar-agent*.service stellar-agent-planner.timer /etc/systemd/system/
# /etc/stellar/stellar-agent.env (root:stellar, 0640) : ANTHROPIC_API_KEY, AGENT_CORE_MCP_URL…
systemctl daemon-reload
systemctl enable --now stellar-agent stellar-agent-planner.timer
```

Le `.service` du planner n'est **pas** `enable`é : c'est le `.timer` qui l'active.
