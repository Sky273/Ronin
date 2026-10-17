// Bots duellistes du dojo (木人) : ils complètent les places du tournoi au bout de l'attente.
// Sans état et sans w.rng : les boutons d'un bot à un tick se déduisent de ce tick, de son duel et d'un
// hachage (sel secret de la salle, pid, duel, manche). Le sel ne quitte jamais le serveur : un client ne
// peut pas calculer d'avance le relâchement d'un bot. Ils ne voient que ce que voit un humain (le signal 斬,
// au tick où il est publié) et réagissent avec un délai humain, jamais sous DOJO.BOT_REACT_MIN.
import { DOJO, DUEL } from './constants';
import { duelOf } from './duel';
import { BTN } from './input';
import { stageSeed as hash } from './math';
import { dojoSalt, type DojoSalt } from './tournament';
import type { World } from './types';

/** Noms des bots (sabreurs de légende ; 12 caractères au plus, comme un pseudo). */
export const BOT_NAMES: readonly string[] = [
  'Musashi', 'Kojirō', 'Tomoe', 'Bokuden', 'Inshun', 'Ittōsai', 'Jūbei', 'Kenshin',
  'Masamune', 'Hanzō', 'Ginchiyo', 'Sekishūsai', 'Yagyū', 'Chūjō', 'Tsukahara', 'Kamiizumi',
];

/** Tempérament d'un bot : réaction moyenne et dispersion (ticks), part de faux départs. */
export interface BotProfile {
  react: number;
  spread: number;
  foul: number;
}

const unit = (h: number): number => (h >>> 0) / 4294967296;

/** Hachage salé (64 bits de sel : hors de portée d'une recherche exhaustive à partir des réactions observées). */
const salted = (salt: DojoSalt, x: number): number => hash(hash(salt[0], x), salt[1]);

/** Profil d'un bot (sel de la salle, pid) : réaction moyenne de 15 à 25 ticks (250 à 417 ms). */
export function botProfile(salt: DojoSalt, pid: number): BotProfile {
  const h = salted(salt, pid * 3 + 1);
  return {
    react: 15 + 10 * unit(h),
    spread: 2 + 2 * unit(hash(h, 2)),
    foul: 0.02 + 0.06 * unit(hash(h, 3)),
  };
}

/** Écart réduit à peu près normal (moyenne de 4 octets d'un hachage), dans [-3.5, 3.5]. */
function gauss(h: number): number {
  const m = ((h & 255) + ((h >>> 8) & 255) + ((h >>> 16) & 255) + ((h >>> 24) & 255)) / 1020;
  return (m - 0.5) / 0.144;
}

/** Tick où le bot relâche l'iai dans la manche en cours (faux départ : avant le signal). */
export function botRelease(salt: DojoSalt, pid: number, duelId: number, played: number, sigTick: number): number {
  const prof = botProfile(salt, pid);
  const h = hash(salted(salt, pid), duelId * 64 + played);
  if (unit(h) < prof.foul) return sigTick - 1 - (hash(h, 7) % 20);
  const r = Math.round(prof.react + prof.spread * gauss(hash(h, 11)));
  return sigTick + Math.min(DOJO.BOT_REACT_MAX, Math.max(DOJO.BOT_REACT_MIN, r));
}

/**
 * Boutons d'un bot au tick w.tick. En duel : iai tenu pendant la garde, relâché à botRelease. Hors duel :
 * quelques pas au hasard (hachage du tick par tranches d'une seconde).
 */
export function botButtons(w: World, pid: number): number {
  const d = duelOf(w, pid);
  if (d) {
    if ((d.phase !== 'kamae' && d.phase !== 'open') || d.sigTick < 0) return 0;
    return w.tick < botRelease(dojoSalt(w), pid, d.id, d.played, d.sigTick) ? BTN.IAI : 0;
  }
  const h = hash(salted(dojoSalt(w), pid), Math.floor(w.tick / 60));
  const k = h % 8;
  return k === 0 ? BTN.LEFT : k === 1 ? BTN.RIGHT : 0;
}

/** Une réaction de bot n'est jamais suspecte (garde-fou : BOT_REACT_MIN au-dessus des deux seuils). */
export const BOT_NEVER_SUSPECT: boolean = DOJO.BOT_REACT_MIN >= DOJO.SUSPECT_REACT && DOJO.BOT_REACT_MIN > DUEL.SUSPECT_REACT;
