"""Stellar Conversation — plomberie entre Assist et apps/agent (P8, spec §12).

Ce composant n'a AUCUNE logique : il déclare une entité de conversation qui
relaie le texte de l'utilisateur à `apps/agent` et rend sa réponse. Toute
l'intelligence (outils MCP, recherche web, mémoire) vit dans l'agent ; tout le
déterminisme vit dans `apps/core`. Home Assistant n'est qu'un tuyau
(interdit §4 n°5).
"""

from __future__ import annotations

import voluptuous as vol
from homeassistant.const import CONF_TIMEOUT, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, discovery
from homeassistant.helpers.typing import ConfigType

DOMAIN = "stellar_conversation"

#: Un tour d'agent peut chercher sur le web ; au-delà, la voix a déjà décroché.
DEFAULT_TIMEOUT = 45

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Required(CONF_URL): cv.url,
                vol.Optional(CONF_TIMEOUT, default=DEFAULT_TIMEOUT): cv.positive_int,
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Charge la plateforme conversation si le composant est configuré en YAML."""
    options = config.get(DOMAIN)
    if options is None:
        return True

    hass.async_create_task(
        discovery.async_load_platform(hass, "conversation", DOMAIN, dict(options), config)
    )
    return True
