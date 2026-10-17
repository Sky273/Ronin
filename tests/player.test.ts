// Tests du corps du joueur et des orbes d'Honneur (simulation, sans réseau) : dash sous un plafond,
// haut du niveau, hauteur de glissade, orbes attirées ou lâchées dans le décor, repère d'Honneur perdu.
// Lancer : npx esbuild tests/player.test.ts --bundle --platform=node --format=esm --log-level=warning --outfile=node_modules/.cache/player.test.mjs && node node_modules/.cache/player.test.mjs
import { DT, HONOR, PLAYER, TILE } from '../shared/constants';
import { BTN } from '../shared/input';
import { damagePlayer, gainHonor, spawnOrbs } from '../shared/interactions';
import { arenaInside } from '../shared/level';
import { Rng } from '../shared/math';
import { fitsAt, moveBody } from '../shared/physics';
import type { Body, Orb, Player, World } from '../shared/types';
import { magnetRadius } from '../shared/upgrades';
import { addPlayer, createWorld, stepWorld } from '../shared/world';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Monde de test au calme : ni ennemis, ni renforts, ni Marée. */
function quiet(seed = 1, mode: 'solo' | 'coop' = 'solo'): World {
  const w = createWorld(seed, { mode });
  w.enemies = [];
  w.spawnTimer = 1e9;
  w.wave.t = -1e9;
  return w;
}

/** Un tick : boutons `b` pour p, aucun pour les autres. calm : le monde reste sans ennemis. */
function tick(w: World, p: Player | null, b: number, calm = true): void {
  const m = new Map<number, number>();
  for (const q of w.players) m.set(q.id, q === p ? b : 0);
  stepWorld(w, m);
  w.events.length = 0;
  if (calm) {
    w.enemies = [];
    w.spawnTimer = 1e9;
  }
}

/** Corps du joueur libre de toute tuile pleine ? */
const free = (w: World, p: Player): boolean => fitsAt(w.level, p.x, p.y, p.w, p.h);
/** Orbe libre (même boîte que stepOrbs) et dans les bornes du niveau ? */
const orbFree = (w: World, o: Orb): boolean => fitsAt(w.level, o.x, o.y + 3, 6, 6);
const orbInside = (w: World, o: Orb): boolean => o.x >= 0 && o.x <= w.level.w * TILE && o.y >= 0 && o.y <= w.level.h * TILE;

const orb = (w: World, x: number, y: number, vx: number, vy: number, lost: boolean, value = 1, age = 30): Orb => ({
  id: w.nextId++, x, y, vx, vy, value, life: (lost ? HONOR.LOST_LIFE : HONOR.ORB_LIFE) - age, lost, onGround: false,
});

// ─── 1. Dash qui annule une attaque faite accroupi sous un plafond ──────────
// Tunnel obligatoire du niveau 0 (colonnes 76 à 84, une seule rangée libre au-dessus du sol en 576).
// Le dash redressait le joueur dans le plafond ; au saut suivant il s'enfonçait d'une tuile dans le
// sol et restait coincé pour le reste de la partie.
{
  const enter = (): { w: World; p: Player } => {
    const w = quiet(1);
    const p = addPlayer(w, 'a');
    p.x = 70 * TILE;
    p.y = 18 * TILE;
    for (let i = 0; i < 20; i++) tick(w, p, BTN.RIGHT);
    for (let i = 0; i < 400 && p.x < 80 * TILE; i++) tick(w, p, BTN.RIGHT | BTN.DOWN);
    return { w, p };
  };
  {
    const { w, p } = enter();
    const inTunnel = p.h === PLAYER.CROUCH_H && free(w, p) && !fitsAt(w.level, p.x, p.y, p.w, PLAYER.H);
    const before = `h=${p.h} x=${(p.x / TILE).toFixed(2)}`;
    tick(w, p, BTN.DOWN | BTN.ATTACK);
    for (let i = 0; i < 6; i++) tick(w, p, BTN.DOWN);
    tick(w, p, BTN.DOWN | BTN.DASH);
    const st = p.state as string;
    const h = p.h;
    let clean = free(w, p);
    for (let i = 0; i < 12; i++) {
      tick(w, p, 0);
      clean &&= free(w, p);
    }
    for (let i = 0; i < 41; i++) {
      tick(w, p, BTN.JUMP);
      clean &&= free(w, p);
    }
    const x0 = p.x;
    for (let i = 0; i < 60; i++) {
      tick(w, p, BTN.RIGHT);
      clean &&= free(w, p);
    }
    check('tunnel : accroupi sous le plafond avant l\'attaque (debout ne passe pas)', inTunnel, before);
    check('attaque accroupie sous un plafond : le dash d\'annulation est refusé, le joueur reste accroupi', st !== 'dash' && h === PLAYER.CROUCH_H, `état=${st} h=${h}`);
    check('… corps jamais dans le décor, pieds restés sur le sol du tunnel', clean && p.y === 18 * TILE, `y=${p.y.toFixed(1)}`);
    check('… le joueur avance encore dans le tunnel', p.x > x0 + 2 * TILE, `${(x0 / TILE).toFixed(2)} → ${(p.x / TILE).toFixed(2)} tuiles`);
  }
  // Toutes les annulations : dash pressé de 0 à 25 ticks après l'attaque (au sol, haute, basse), puis
  // saut et sortie du tunnel en rampant.
  const stuck: string[] = [];
  let runs = 0;
  for (const [name, atk] of [['slash', BTN.ATTACK], ['haute', BTN.UP | BTN.ATTACK], ['basse', BTN.DOWN | BTN.ATTACK]] as const) {
    for (let k = 0; k <= 25; k++) {
      const { w, p } = enter();
      tick(w, p, atk);
      for (let i = 0; i < k; i++) tick(w, p, BTN.DOWN);
      tick(w, p, BTN.DOWN | BTN.DASH);
      let clean = free(w, p);
      for (let i = 0; i < 60; i++) {
        tick(w, p, BTN.JUMP);
        clean &&= free(w, p);
      }
      for (let i = 0; i < 240 && p.x < 86 * TILE; i++) {
        tick(w, p, BTN.RIGHT | BTN.DOWN);
        clean &&= free(w, p);
      }
      runs++;
      if (!clean || p.x < 86 * TILE) stuck.push(`${name}+${k}`);
    }
  }
  check('dash pressé à chaque instant d\'une attaque dans le tunnel : jamais coincé, on en ressort', stuck.length === 0, `${stuck.length}/${runs} coincés ${stuck.slice(0, 6).join(' ')}`);
  // Témoin : à l'air libre, le dash annule toujours l'attaque.
  {
    const w = quiet(1);
    const p = addPlayer(w, 'a');
    p.x = 10 * TILE;
    p.y = 18 * TILE;
    for (let i = 0; i < 10; i++) tick(w, p, 0);
    tick(w, p, BTN.ATTACK);
    for (let i = 0; i < 6; i++) tick(w, p, 0);
    tick(w, p, BTN.DASH);
    check('témoin : à l\'air libre, le dash annule toujours l\'attaque', (p.state as string) === 'dash' && p.h === PLAYER.H, `état=${p.state}`);
  }
}

// ─── 2. Le haut du niveau est un plafond pour les corps ─────────────────────
// tileAt est vide au-dessus de la rangée 0 et la barrière de l'arène s'arrête là : en escaladant la
// barrière de saut en saut, on passait par-dessus, hors de l'écran.
{
  const L = createWorld(1).level;
  const b: Body = { x: 10 * TILE, y: 50, vx: 0, vy: -1200, w: PLAYER.W, h: PLAYER.H, onGround: false };
  const res = moveBody(b, L, DT, false);
  check('moveBody : un corps qui monte s\'arrête au haut du niveau (y - h = 0, vy = 0)', b.y - b.h === 0 && b.vy === 0 && res.ceil, `y=${b.y} vy=${b.vy}`);
  const c: Body = { x: 10 * TILE, y: 300, vx: 0, vy: -600, w: PLAYER.W, h: PLAYER.H, onGround: false };
  const res2 = moveBody(c, L, DT, false);
  check('moveBody : loin du haut, la montée est inchangée', c.y === 300 + -600 * DT && c.vy === -600 && !res2.ceil, `y=${c.y}`);

  const J = BTN.JUMP;
  const Lf = BTN.LEFT;
  const Rt = BTN.RIGHT;
  // Séquence trouvée par le testeur (saut mural, double saut vers le mur, contact), et un rythme simple.
  const cycle = [J | Rt, J | Rt, J | Rt, J | Rt, J | Lf, J | Lf, J | Lf, J | Lf, Lf, J | Lf, J | Lf, J | Lf, J | Lf, J | Lf, J | Lf, J | Lf];
  const policies: [string, (t: number) => number][] = [
    ['cycle mural', (t) => cycle[t % 16]],
    ['gauche + saut à 4 Hz', (t) => Lf | (t % 15 < 8 ? J : 0)],
  ];
  for (const mode of ['solo', 'coop'] as const) {
    for (const air of [0, 2]) {
      for (const [name, policy] of policies) {
        const w = createWorld(1, { mode });
        const p = addPlayer(w, 'a');
        const mate = mode === 'coop' ? addPlayer(w, 'b', { color: 1 }) : null;
        p.x = 184.5 * TILE;
        p.y = 12 * TILE;
        p.iframes = 0;
        if (mate) {
          mate.x = 192 * TILE;
          mate.y = 12 * TILE;
        }
        p.up.air = air;
        // Le gardien reste actif ; les joueurs ne meurent pas.
        const hold = (bt: number) => {
          tick(w, p, bt, false);
          for (const q of w.players) q.hp = q.maxHp;
        };
        // Coop : le coéquipier ferme le kekkai ; on entre ensuite le rejoindre.
        for (let i = 0; i < 600 && !(w.stage.state === 'arena' && arenaInside(w.level, p.x - p.w)); i++) hold(Rt);
        const locked = w.stage.state === 'arena' && arenaInside(w.level, p.x);
        let top = Infinity;
        let out = false;
        for (let i = 0; i < 40; i++) hold(Lf);
        for (let t = 0; t < 1500; t++) {
          hold(policy(t));
          top = Math.min(top, p.y - p.h);
          out ||= !arenaInside(w.level, p.x);
        }
        for (let i = 0; i < 120; i++) {
          hold(Lf);
          top = Math.min(top, p.y - p.h);
          out ||= !arenaInside(w.level, p.x);
        }
        check(
          `${mode}, air ${air}, ${name} : on ne sort pas de l'arène fermée par le haut`,
          locked && top >= 0 && !out && w.stage.state === 'arena',
          `fermée=${locked} haut du corps min=${top.toFixed(1)} sorti=${out} x=${(p.x / TILE).toFixed(2)}`,
        );
      }
    }
  }

  // Saut ordinaire suivi d'un double saut, loin du haut : trajectoire identique au bit près à celle
  // mesurée avant la correction (apogée 177,83 px, empreinte de la trace 73a8677f).
  {
    const w = quiet(1);
    const p = addPlayer(w, 'a');
    p.x = 10 * TILE;
    p.y = 18 * TILE;
    for (let i = 0; i < 10; i++) tick(w, p, 0);
    let minY = p.y;
    const trace: string[] = [];
    for (let i = 0; i < 20; i++) {
      tick(w, p, BTN.JUMP);
      minY = Math.min(minY, p.y);
    }
    tick(w, p, 0);
    tick(w, p, BTN.JUMP);
    for (let i = 0; i < 60; i++) {
      tick(w, p, BTN.JUMP);
      minY = Math.min(minY, p.y);
      trace.push(p.y.toFixed(3));
    }
    let h = 0;
    for (const ch of trace.join(',')) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
    const apex = 18 * TILE - minY;
    check('saut et double saut ordinaires : trajectoire inchangée', Math.abs(apex - 177.8333) < 1e-3 && h.toString(16) === '73a8677f', `apogée ${apex.toFixed(4)} px, trace ${h.toString(16)}`);
  }
}

// ─── 3. Orbes attirées : ramassées en un temps borné ────────────────────────
// L'attraction était une force centrale pure : l'orbe gardait son moment cinétique et tournait autour
// du joueur immobile jusqu'à expiration, sans jamais passer à portée de ramassage.
{
  {
    const w = quiet(1);
    const p = addPlayer(w, 'a');
    p.x = 10 * TILE;
    p.y = 18 * TILE;
    tick(w, p, 0);
    tick(w, p, 0);
    const h0 = p.honor;
    w.orbs.push(orb(w, p.x + 50, p.y - 22, 0, 250, false)); // lancée en travers, à 50 px
    let t = 0;
    while (w.orbs.length && t < 600) {
      tick(w, p, 0);
      t++;
    }
    check('orbe lancée en travers dans l\'aimant d\'un joueur immobile : ramassée (plus d\'orbite)', p.honor === h0 + 1 && t <= 30, `${t} ticks`);
  }
  // Orbes posées au hasard dans le rayon de l'aimant (vitesses de jaillissement), Honneur perdu ou non,
  // aimant amélioré ou non ; joueur immobile, accroupi ou en allers-retours.
  {
    const rng = new Rng(12345);
    const xs = [3, 10, 30, 50, 70, 100, 120, 140, 160];
    let n = 0;
    let worst = 0;
    const missed: string[] = [];
    for (let k = 0; k < 540; k++) {
      const w = quiet(1);
      const p = addPlayer(w, 'a');
      p.x = xs[k % xs.length] * TILE + rng.range(-40, 40);
      p.y = 2 * TILE;
      p.up.magnet = k % 3;
      for (let i = 0; i < 90; i++) tick(w, p, 0);
      const lost = k % 2 === 0;
      const rad = magnetRadius(p) * (lost ? 1.6 : 1) * 0.9;
      const a = rng.next() * Math.PI * 2;
      const d = rng.range(HONOR.PICKUP + 1, rad);
      const va = rng.next() * Math.PI * 2;
      const vs = rng.range(0, 340);
      w.orbs.push(orb(w, p.x + Math.cos(a) * d, p.y - 22 + Math.sin(a) * d, Math.cos(va) * vs, Math.sin(va) * vs, lost));
      const mode = k % 3; // 0 immobile, 1 allers-retours, 2 accroupi
      const h0 = p.honor;
      let t = 0;
      while (w.orbs.length && t < 600) {
        tick(w, p, mode === 0 ? 0 : mode === 1 ? (((t / 40) | 0) % 2 ? BTN.LEFT : BTN.RIGHT) : BTN.DOWN);
        t++;
      }
      n++;
      if (p.honor > h0) worst = Math.max(worst, t);
      else missed.push(`#${k}`);
    }
    check('orbe dans l\'aimant (joueur immobile, accroupi ou en allers-retours) : toujours ramassée en moins de 1,5 s', missed.length === 0 && worst <= 90, `${n - missed.length}/${n}, pire ${worst} ticks ${missed.slice(0, 5).join(' ')}`);
  }
  // Bonus de fin de Marée lâché au-dessus d'un joueur immobile : aucune orbe ne reste dans l'aimant.
  {
    let longest = 0;
    let lostInMagnet = 0;
    for (let k = 0; k < 40; k++) {
      const w = quiet(1 + k);
      const p = addPlayer(w, 'a');
      p.x = (10 + 3 * (k % 5)) * TILE;
      p.y = 18 * TILE;
      for (let i = 0; i < 30; i++) tick(w, p, 0);
      spawnOrbs(w, p.x, p.y - 60, 25 * (1 + (k % 4)), false);
      const inMagnet = new Map<number, number>();
      for (let t = 0; t < HONOR.ORB_LIFE + 5; t++) {
        const before = new Set(w.orbs.map((o) => o.id));
        tick(w, p, 0);
        for (const o of w.orbs) {
          const age = HONOR.ORB_LIFE - o.life;
          const near = age > 18 && Math.hypot(o.x - p.x, o.y - p.y + 22) < magnetRadius(p);
          const run = near ? (inMagnet.get(o.id) ?? 0) + 1 : 0;
          inMagnet.set(o.id, run);
          longest = Math.max(longest, run);
          before.delete(o.id);
        }
        for (const id of before) if ((inMagnet.get(id) ?? 0) > 0 && t >= HONOR.ORB_LIFE - 40) lostInMagnet++;
      }
    }
    check('bonus de Marée au-dessus d\'un joueur immobile : aucune orbe ne s\'attarde dans l\'aimant', longest <= 60 && lostInMagnet === 0, `séjour max ${longest} ticks, expirées dans l'aimant ${lostInMagnet}`);
  }
}

// ─── 4. Orbes lâchées par l'aimant : jamais enfouies ni hors du niveau ──────
// L'attraction traverse le décor ; l'orbe lâchée dans le sol restait enfouie (moveBody ne remonte
// pas un corps parti de l'intérieur d'une tuile), parfois trop profond pour être ramassée.
{
  {
    // Scénario du constat : Honneur perdu qui tombe à 600 px/s près du joueur, qui s'en va aussitôt.
    const w = quiet(1);
    const p = addPlayer(w, 'a');
    p.x = 24 * TILE;
    p.y = 18 * TILE;
    tick(w, p, 0);
    tick(w, p, 0);
    const h0 = p.honor;
    const o = orb(w, p.x + 120, p.y - 60, 0, 600, true, 50);
    w.orbs.push(o);
    for (let i = 0; i < 25; i++) tick(w, p, 0);
    for (let i = 0; i < 275; i++) tick(w, p, BTN.LEFT);
    let ok = p.honor === h0 + 50;
    let info = 'ramassée en chemin';
    if (!ok && w.orbs.includes(o)) {
      info = `(${o.x.toFixed(0)}, ${o.y.toFixed(0)}) libre=${orbFree(w, o)} au sol=${o.onGround}`;
      const x = o.x;
      for (let i = 0; i < 120; i++) {
        p.x = x;
        p.y = 18 * TILE;
        p.vx = 0;
        tick(w, p, 0);
      }
      ok = p.honor === h0 + 50;
      info += ok ? ', ramassée ensuite' : ', jamais ramassée';
    }
    check('Honneur perdu tombé près d\'un joueur qui s\'en va : jamais perdu dans le sol', ok, info);
  }
  {
    // Orbes posées directement dans le décor ou hors du niveau, sans joueur : remontées à la surface.
    const w = quiet(1);
    const W = w.level.w * TILE;
    const H = w.level.h * TILE;
    const cases: [string, Orb][] = [
      ['dans le sol', orb(w, 10 * TILE + 5, 700, 300, 600, true)],
      ['juste sous la surface', orb(w, 12 * TILE + 16, 18 * TILE + 4, 0, 0, false)],
      ['dans le mur gauche', orb(w, 20, 300, -400, 0, false)],
      ['à gauche du niveau', orb(w, -3, 400, -200, 0, true)],
      ['à droite du niveau', orb(w, W + 3, 400, 200, 0, true)],
      ['sous le niveau', orb(w, 30 * TILE, H + 20, 0, 600, true)],
    ];
    for (const [, o] of cases) w.orbs.push(o);
    tick(w, null, 0);
    const first = cases.map(([name, o]) => (orbFree(w, o) && orbInside(w, o) ? '' : name)).filter(Boolean);
    for (let i = 0; i < 90; i++) tick(w, null, 0);
    const rest = cases.map(([name, o]) => (orbFree(w, o) && orbInside(w, o) && o.onGround ? '' : name)).filter(Boolean);
    const surf = cases[0][1];
    check('orbe dans le décor ou hors du niveau : libre et dans le niveau dès le tick suivant', first.length === 0, first.join(', '));
    check('… puis posée sur le sol (orbe du sol remontée à la surface y=576)', rest.length === 0 && Math.abs(surf.y + 3 - 18 * TILE) < 0.5, `${rest.join(', ')} y=${surf.y.toFixed(2)}`);
  }
  {
    // Lâchées en plein vol (le joueur s'éloigne d'un coup à un instant quelconque de l'attraction).
    const rng = new Rng(777);
    const xs = [3, 10, 30, 50, 70, 80, 100, 120, 140, 160];
    let buried = 0;
    let outside = 0;
    let n = 0;
    for (let k = 0; k < 500; k++) {
      const w = quiet(1);
      const p = addPlayer(w, 'a');
      p.x = xs[k % xs.length] * TILE + rng.range(-40, 40);
      p.y = 2 * TILE;
      p.up.magnet = 2;
      for (let i = 0; i < 90; i++) tick(w, p, 0);
      const rad = magnetRadius(p) * 1.6 * 0.95;
      const a = rng.next() * Math.PI * 2;
      const d = rng.range(60, rad);
      const vs = rng.range(0, 720);
      const va = rng.next() * Math.PI * 2;
      const o = orb(w, p.x + Math.cos(a) * d, p.y - 22 + Math.sin(a) * d, Math.cos(va) * vs, Math.sin(va) * vs, true);
      w.orbs.push(o);
      const leave = 1 + Math.floor(rng.next() * 12);
      for (let i = 0; i < leave; i++) tick(w, p, 0);
      if (!w.orbs.includes(o)) continue;
      p.x = p.x < 100 * TILE ? 150 * TILE : 20 * TILE;
      p.y = 2 * TILE;
      for (let i = 0; i < 120; i++) tick(w, p, 0);
      n++;
      if (!orbFree(w, o)) buried++;
      if (!orbInside(w, o)) outside++;
    }
    check('orbes lâchées par l\'aimant en plein vol : jamais enfouies ni hors du niveau', n > 50 && buried === 0 && outside === 0, `${n} lâchées : ${buried} enfouies, ${outside} hors du niveau`);
  }
}

// ─── 5. Honneur perdu expiré : le repère s'efface ───────────────────────────
// Le repère n'était effacé qu'au ramassage : après l'expiration des orbes, le HUD montrait une
// flèche vers un Honneur qui n'existait plus.
for (const mode of ['solo', 'coop'] as const) {
  const w = quiet(1, mode);
  const p = addPlayer(w, 'a');
  const mate = mode === 'coop' ? addPlayer(w, 'b', { color: 1 }) : null;
  p.x = 40 * TILE;
  p.y = 16 * TILE;
  tick(w, p, 0);
  tick(w, p, 0);
  if (mate) {
    mate.lostX = 50 * TILE; // repère d'une mort précédente (les orbes n'ont pas de propriétaire)
    mate.lostY = 500;
  }
  gainHonor(w, p, 60);
  p.hp = 1;
  p.iframes = 0;
  damagePlayer(w, p, 50, p.x + 10);
  const dropped = w.orbs.filter((o) => o.lost).length;
  const marked = Number.isFinite(p.lostX) && Number.isFinite(p.lostY);
  // Le joueur renaît au sanctuaire et ne revient pas chercher son Honneur.
  let half = true;
  for (let i = 0; i < HONOR.LOST_LIFE + 10; i++) {
    tick(w, p, 0);
    if (i === HONOR.LOST_LIFE / 2) half = Number.isFinite(p.lostX) && w.orbs.some((o) => o.lost);
  }
  const left = w.orbs.filter((o) => o.lost).length;
  const cleared = w.players.every((q) => Number.isNaN(q.lostX) && Number.isNaN(q.lostY));
  check(`${mode} : Honneur perdu laissé au sol, repère posé tant qu'il en reste`, dropped > 0 && marked && half, `${dropped} orbes`);
  check(`${mode} : dernière orbe perdue expirée sans être ramassée → repère effacé${mate ? ' pour tous' : ''} (lostX/lostY = NaN)`, left === 0 && cleared, `restantes ${left}, lostX ${w.players.map((q) => q.lostX).join('/')}`);
}
{
  // Expiration partielle : le repère reste tant qu'une orbe perdue existe encore.
  const w = quiet(1);
  const p = addPlayer(w, 'a');
  tick(w, p, 0);
  p.lostX = 100 * TILE;
  p.lostY = 500;
  const o1 = orb(w, 100 * TILE, 500, 0, 0, true);
  const o2 = orb(w, 100 * TILE + 40, 500, 0, 0, true);
  o1.life = 10;
  o2.life = 40;
  w.orbs.push(o1, o2);
  for (let i = 0; i < 20; i++) tick(w, p, 0);
  const kept = Number.isFinite(p.lostX) && w.orbs.length === 1;
  for (let i = 0; i < 30; i++) tick(w, p, 0);
  check('expiration partielle : repère gardé tant qu\'une orbe perdue reste, effacé après la dernière', kept && w.orbs.length === 0 && Number.isNaN(p.lostX) && Number.isNaN(p.lostY), `après la 1re : ${kept}`);
}

// ─── 6. Coup reçu en glissade sous un plafond : plus de corps de 22 px ──────
// damagePlayer ne rendait la hauteur que debout ; sous le plafond, le joueur gardait la hauteur de
// glissade tant que Bas restait tenu (l'estoc des lanciers passait au-dessus de lui).
{
  const w = quiet(1);
  const p = addPlayer(w, 'a');
  p.x = 70 * TILE;
  p.y = 18 * TILE;
  for (let i = 0; i < 40; i++) tick(w, p, BTN.RIGHT);
  for (let i = 0; i < 400 && !(p.state === 'slide' && p.x > 77 * TILE); i++) tick(w, p, BTN.RIGHT | BTN.DOWN);
  const sliding = p.state === 'slide' && p.h === PLAYER.SLIDE_H;
  const slide = `${p.state} h=${p.h} x=${(p.x / TILE).toFixed(2)}`;
  // Shuriken de ninja en vol bas, qui entre dans le tunnel.
  w.projectiles.push({ id: w.nextId++, kind: 'shuriken', x: p.x + 60, y: p.y - 14, vx: -470, vy: 0, owner: 'enemy', ownerId: 0, damage: 8, life: 240, hits: [], dead: false });
  for (let i = 0; i < 100 && p.state !== 'hurt'; i++) tick(w, p, BTN.RIGHT);
  const hurt = `${p.state} h=${p.h}`;
  const hurtOk = p.state === 'hurt' && p.h === PLAYER.CROUCH_H && free(w, p);
  for (let i = 0; i < 30; i++) tick(w, p, BTN.RIGHT | BTN.DOWN);
  const after = `${p.state} h=${p.h}`;
  const afterOk = p.state === 'normal' && p.h === PLAYER.CROUCH_H;
  for (let i = 0; i < 1000 && p.x < 85.5 * TILE; i++) tick(w, p, BTN.RIGHT | BTN.DOWN);
  for (let i = 0; i < 3; i++) tick(w, p, BTN.RIGHT | BTN.DOWN);
  check('glissade dans le tunnel', sliding, slide);
  check('touché en glissade sous le plafond : hauteur accroupie (28), pas de glissade (22)', hurtOk, hurt);
  check('… accroupi ensuite, Bas tenu : toujours 28 px', afterOk, after);
  check('… sorti du tunnel, Bas tenu : toujours 28 px', p.h === PLAYER.CROUCH_H && p.crouch, `${p.state} h=${p.h} x=${(p.x / TILE).toFixed(2)}`);
}
{
  // Filet de sécurité de l'état normal : accroupi avec la hauteur de glissade (cas où même l'accroupi
  // ne passait pas au moment du coup) → 28 px dès que le corps y tient.
  const w = quiet(1);
  const p = addPlayer(w, 'a');
  p.x = 10 * TILE;
  p.y = 18 * TILE;
  for (let i = 0; i < 10; i++) tick(w, p, 0);
  p.crouch = true;
  p.h = PLAYER.SLIDE_H;
  tick(w, p, BTN.DOWN);
  check('accroupi resté à la hauteur de glissade : ramené à 28 px dès que possible', p.state === 'normal' && p.crouch && p.h === PLAYER.CROUCH_H, `h=${p.h}`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests du corps du joueur et des orbes passent.');
