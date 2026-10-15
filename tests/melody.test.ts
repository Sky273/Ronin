// Tests du générateur de mélodies du shinobue (fonctions pures, sans audio).
// Lancer : npm run test:melody
import { DEG_MAX, DEG_MIN, type MelodyMood, PHRASE_STEPS, phraseFor } from '../client/audio/melody';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const MOODS: MelodyMood[] = ['calm', 'tide', 'boss', 'rest'];
const CHORDS = [0, -1, -2]; // ré, si♭, la (progression de la musique)
const mod5 = (n: number) => ((n % 5) + 5) % 5;

let bounds = true;
let overlap = true;
let range = true;
let notEmpty = true;
let deterministic = true;
let motif = true;
let cadence = true;
let detail = '';

for (const mood of MOODS) {
  for (let section = 0; section < 60; section++) {
    for (const chord of CHORDS) {
      const slots = [0, 1, 2, 3].map((slot) => phraseFor(section, slot, mood, chord));
      slots.forEach((notes, slot) => {
        if (notes.length === 0) notEmpty = false;
        let end = 0;
        for (const n of notes) {
          if (n.start < 0 || n.len <= 0 || n.start + n.len > PHRASE_STEPS) {
            bounds = false;
            detail ||= `${mood} s${section} slot${slot} start=${n.start} len=${n.len}`;
          }
          if (n.start < end) overlap = false;
          end = n.start + n.len;
          if (n.deg < DEG_MIN || n.deg > DEG_MAX || !Number.isInteger(n.deg)) range = false;
        }
        if (JSON.stringify(notes) !== JSON.stringify(phraseFor(section, slot, mood, chord))) deterministic = false;
      });
      // A, A' et A" partagent le même rythme : c'est le motif qui revient.
      const rhythm = (k: number) => slots[k].map((n) => `${n.start}:${n.len}`).join(',');
      if (rhythm(0) !== rhythm(1) || rhythm(0) !== rhythm(3)) motif = false;
      // A" se pose sur la fondamentale de l'accord.
      const last = slots[3][slots[3].length - 1];
      if (!last || mod5(last.deg - chord) !== 0) cadence = false;
    }
  }
}

check('notes dans la phrase (2 mesures)', bounds, detail);
check('aucun chevauchement (instrument monodique)', overlap);
check(`registre du shinobue respecté (${DEG_MIN}..${DEG_MAX})`, range);
check('chaque phrase contient des notes', notEmpty);
check('déterministe (même section → même phrase)', deterministic);
check('motif repris en A, A′ et A″ (même rythme)', motif);
check('cadence de A″ sur la fondamentale', cadence);

// Variété : les sections ne doivent pas toutes donner la même mélodie.
const distinct = new Set(Array.from({ length: 20 }, (_, s) => JSON.stringify(phraseFor(s, 0, 'tide', 0)))).size;
check('variété entre sections', distinct >= 8, `${distinct} mélodies distinctes sur 20 sections`);

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de mélodie passent.');
