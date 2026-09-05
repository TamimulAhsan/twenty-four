/** Hungarian given and family names, for fixtures that read like a real book
 *  of customers rather than Customer 1 through Customer 200. */
export const FAMILY_NAMES = [
  'Nagy', 'Kovács', 'Tóth', 'Szabó', 'Horváth', 'Varga', 'Kiss', 'Molnár', 'Németh', 'Farkas',
  'Balogh', 'Papp', 'Takács', 'Juhász', 'Lakatos', 'Mészáros', 'Oláh', 'Simon', 'Rácz', 'Fekete',
  'Szilágyi', 'Török', 'Fehér', 'Gál', 'Pintér', 'Balázs', 'Halász', 'Somogyi', 'Bogdán', 'Király',
  'Vincze', 'Bíró', 'Katona', 'Máté', 'Orsós', 'Boros', 'Jónás', 'Székely', 'Fodor', 'Antal',
]

export const GIVEN_NAMES = [
  'Anna', 'Péter', 'Eszter', 'László', 'Katalin', 'Zoltán', 'Judit', 'Gábor', 'Márta', 'István',
  'Dóra', 'Tamás', 'Nóra', 'Balázs', 'Réka', 'Bence', 'Zsófia', 'Ádám', 'Lilla', 'Máté',
  'Kata', 'Dániel', 'Vera', 'Levente', 'Emma', 'Zsolt', 'Petra', 'Ákos', 'Hanna', 'Gergely',
  'Júlia', 'Attila', 'Boglárka', 'Norbert', 'Alíz', 'Krisztián', 'Fanni', 'Roland', 'Luca', 'Márk',
]

const DOMAINS = ['gmail.com', 'freemail.hu', 'citromail.hu', 'outlook.com', 'yahoo.com']

export function emailFor(given: string, family: string, index: number): string {
  const strip = (value: string) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
  return `${strip(given)}.${strip(family)}${index % 7 === 0 ? index : ''}@${DOMAINS[index % DOMAINS.length]}`
}

export function phoneFor(index: number): string {
  const prefix = ['20', '30', '70'][index % 3]
  return `+36 ${prefix} ${String(1000000 + index * 7919).slice(0, 3)} ${String(1000000 + index * 7919).slice(3, 7)}`
}
