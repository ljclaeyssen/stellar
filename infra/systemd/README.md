# systemd — gabarits P5

Non utilisés en dev (Mac / tour Windows) : ils servent au N100 en P5, quand core et
drivers deviennent des services permanents.

Installation (sur le N100) : copier les `.service` dans `/etc/systemd/system/`, créer
l'`EnvironmentFile` correspondant dans `/etc/stellar/` (root:stellar, chmod 0640 —
il peut contenir des credentials MQTT), puis
`systemctl daemon-reload && systemctl enable --now stellar-core`.
