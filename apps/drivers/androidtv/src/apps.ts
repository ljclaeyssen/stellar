/**
 * Table de traduction nom d'app → deep link Android TV.
 * Un paramètre contenant déjà un scheme (https://, vnd.youtube://, intent…)
 * est transmis tel quel. Liens identiques à ceux utilisés par l'intégration
 * androidtv_remote de Home Assistant.
 */
const APP_LINKS: Record<string, string> = {
  netflix: 'https://www.netflix.com/title',
  youtube: 'https://www.youtube.com',
  prime_video: 'https://app.primevideo.com',
  disney_plus: 'https://www.disneyplus.com',
};

export function resolveAppLink(app: string): string | undefined {
  if (app.includes('://')) return app;
  return APP_LINKS[
    app
      .trim()
      .toLowerCase()
      .replace(/[\s+-]+/g, '_')
  ];
}

export function knownApps(): string[] {
  return Object.keys(APP_LINKS);
}
