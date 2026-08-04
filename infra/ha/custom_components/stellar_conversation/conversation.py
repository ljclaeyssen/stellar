"""Entité de conversation qui délègue chaque tour à `apps/agent`.

Contrat HTTP (apps/agent/src/main.ts) :

    POST /turn   {"prompt": "...", "context": "..."}   (corps strict)
    200          {"text": "...", "isError": false, "usage": {...}}

TODO P8 réelle : réponse **streamée**. La spec §12 veut que le TTS parle dès les
premiers mots ; ce gabarit attend la réponse complète, ce qui suffit au bring-up
mais ajoute une à deux secondes de silence. Le passage au streaming demande un
endpoint SSE côté agent et `async_process` rendant un flux — les deux arrivent
ensemble, pas l'un sans l'autre.
"""

from __future__ import annotations

import logging

import aiohttp
from homeassistant.components import conversation
from homeassistant.const import CONF_TIMEOUT, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.intent import IntentResponse, IntentResponseErrorCode
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType

_LOGGER = logging.getLogger(__name__)

DOMAIN = "stellar_conversation"

#: L'agent répond en français (spec §11, prompt système vocal).
SUPPORTED_LANGUAGES = ["fr"]

#: Message rendu quand l'agent est injoignable — la maison, elle, continue de
#: fonctionner : les intents locaux d'Assist ne passent pas par ici.
FALLBACK_SPEECH = "Je n'arrive pas à joindre Stellar pour le moment."


async def async_setup_platform(
    hass: HomeAssistant,
    config: ConfigType,
    async_add_entities: AddEntitiesCallback,
    discovery_info: DiscoveryInfoType | None = None,
) -> None:
    """Instancie l'unique entité de conversation à partir de la config YAML."""
    if discovery_info is None:
        return
    async_add_entities(
        [StellarConversationEntity(discovery_info[CONF_URL], discovery_info[CONF_TIMEOUT])]
    )


class StellarConversationEntity(conversation.ConversationEntity):
    """Relais sans mémoire ni décision : le texte entre, le texte sort."""

    _attr_has_entity_name = True
    _attr_name = "Stellar"

    def __init__(self, url: str, timeout: int) -> None:
        self._url = url
        self._timeout = timeout
        self._attr_unique_id = f"{DOMAIN}_agent"

    @property
    def supported_languages(self) -> list[str]:
        return SUPPORTED_LANGUAGES

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        response = IntentResponse(language=user_input.language)
        payload: dict = {"prompt": user_input.text}
        # Le corps accepté par l'agent est strict : on n'envoie `context` que s'il
        # a quelque chose à dire (ici : d'où vient la voix).
        if user_input.device_id:
            payload["context"] = f"Satellite vocal : {user_input.device_id}"

        try:
            session = async_get_clientsession(self.hass)
            async with session.post(
                self._url,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=self._timeout),
            ) as http_response:
                http_response.raise_for_status()
                body = await http_response.json()
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.error("agent Stellar injoignable (%s) : %s", self._url, err)
            response.async_set_error(IntentResponseErrorCode.UNKNOWN, FALLBACK_SPEECH)
            return conversation.ConversationResult(
                response=response, conversation_id=user_input.conversation_id
            )

        text = body.get("text") or FALLBACK_SPEECH
        if body.get("isError"):
            response.async_set_error(IntentResponseErrorCode.UNKNOWN, text)
        else:
            response.async_set_speech(text)
        return conversation.ConversationResult(
            response=response, conversation_id=user_input.conversation_id
        )
