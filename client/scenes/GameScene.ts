import Phaser from 'phaser';
import { ATTACKS, activeAttackBox, bodyRect, boxFromFacing } from '../../shared/combat';
import { BOSS, ENEMY, NINJA_SLASH_HB, ONI_SMASH_HB, PLAYER as P, SPEAR_HB, TILE } from '../../shared/constants';
import { gainHonor } from '../../shared/interactions';
import type { Rect } from '../../shared/math';
import type { Enemy, GameEvent, Player, World } from '../../shared/types';
import { DIFFICULTIES, type DifficultyId } from '../../shared/difficulty';
import { BIOMES, biomeForStage } from '../../shared/biomes';
import { targetPlayer } from '../../shared/enemy';
import { arenaInside } from '../../shared/level';
import { createPlayer } from '../../shared/player';
import { addPlayer, createWorld, nextStage, resetWorld, skipWavePhase, warpToArena } from '../../shared/world';
import { type Mood, Music } from '../audio/music';
import { Sfx } from '../audio/sfx';
import { isMine, shakeFor } from '../fx/eventPolicy';
import { Fx } from '../fx/fx';
import { Controls } from '../input/controls';
import { HoldTrigger } from '../input/hold';
import { Backdrop, makeGrainOverlay, makeVignette } from '../render/backdrop';
import { gBlob, gFill, gStroke, hash2, type Pt, ringPoints, seeded } from '../render/brush';
import {
  buildSkeleton, drawSamurai, headBackWorld, headWorld, makeXf, type Pose, SAMURAI, samuraiPose, slashTrail, star,
} from '../render/characters';
import { bossTrail, drawEnemy, enemyPose, enemySkeleton, isGuarding, SCALE, windupLength } from '../render/enemies';
import { C, FONT_BRUSH, FONT_TEXT, hexCss, playerColor } from '../render/palette';
import { Terrain } from '../render/terrain';
import { insertScore, loadPrefs, loadScores, type Prefs, qualifies, sanitizeName, saveScores, savePrefs } from '../scores/highscores';
import type { ScoreTable } from '../scores/types';
import { DifficultySelect } from '../ui/difficultySelect';
import { DIFFICULTY_TEXT, fmtScore, foesLabel, livesLabel } from '../ui/difficultyText';
import { AllyMarkers } from '../ui/allies';
import { DuelOverlay } from '../ui/duel';
import { COOP_DUEL_RULES, startDuel } from '../../shared/duel';
import { duelView } from '../ui/duelView';
import { Hud } from '../ui/hud';
import { NameEntry } from '../ui/nameEntry';
import { Results } from '../ui/results';
import { buildRoster, readyInfo } from '../ui/roster';
import { Scoreboard } from '../ui/scoreboard';
import { stageTitle, UPGRADE_TEXT } from '../ui/texts';
import { OnlineMenu } from '../ui/onlineMenu';
import { TitleScreen } from '../ui/title';
import { RemoteSource } from '../net/remoteSource';
import { LocalSource } from '../world/localSource';
import type { WorldSource } from '../world/source';

type Layer = 'bg' | 'world' | 'ui';
/** Écran courant : menus, partie, fin de partie, saisie du nom, tableau des scores, menu en ligne. */
type Screen = 'title' | 'select' | 'play' | 'over' | 'name' | 'scores' | 'online';
type GameOverInfo = { score: number; loop: number; kills: number };

const MENU_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'Enter', 'NumpadEnter', 'Space', 'Escape'];
/** Délai avant de quitter l'écran de fin de partie (s) : automatique, ou à la première touche après GAME_OVER_SKIP. */
const GAME_OVER_HOLD = 3.2;
const GAME_OVER_SKIP = 1.2;
type G = Phaser.GameObjects.Graphics;

const ZOOM = 1.4;
/** Marge (px monde) au-delà de laquelle un autre joueur hors de la vue n'est pas dessiné. */
const OFFSCREEN_MARGIN = 160;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class GameScene extends Phaser.Scene {
  /** Monde simulé localement (solo) ; toujours présent, même quand une autre source est branchée. */
  private local!: LocalSource;
  /** Source du monde affiché : locale (solo) ou en ligne. */
  private src!: WorldSource;
  /** Dernier objet joueur local connu (en ligne, les objets joueur sont remplacés à chaque instantané). */
  private meCache: Player | null = null;
  private controls!: Controls;
  private sfx = new Sfx();
  private music: Music | null = null;
  private bgCam!: Phaser.Cameras.Scene2D.Camera;
  private worldCam!: Phaser.Cameras.Scene2D.Camera;
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private backdrop!: Backdrop;
  private terrain!: Terrain;
  private fx!: Fx;
  private hud!: Hud;
  /** Repères des coéquipiers hors de la vue (coop). */
  private allies!: AllyMarkers;
  /** Duels iaidō (coop) : invitation, signal 斬, issues, toasts. */
  private duel!: DuelOverlay;
  private results!: Results;
  private gBack!: G;
  private gChars!: G;
  private gFront!: G;
  private gDebug!: G;
  private gOverlay!: G;
  private titleScreen!: TitleScreen;
  private diffSelect!: DifficultySelect;
  private nameEntry!: NameEntry;
  private scoreboard!: Scoreboard;
  private onlineMenu!: OnlineMenu;
  /** Salle rejointe dont on attend le premier instantané (le menu en ligne reste affiché). */
  private pending: RemoteSource | null = null;
  /** Jeton de tentative de connexion : une réponse arrivée après un retour en arrière est abandonnée. */
  private joinToken = 0;
  /** Select maintenu 1 s à la manette : quitter la salle en ligne. */
  private padQuit = new HoldTrigger(1000);
  private deathText!: Phaser.GameObjects.Text;
  private deathSub!: Phaser.GameObjects.Text;

  private timeScale = 1;
  private screen: Screen = 'title';
  private difficulty: DifficultyId = 'normal';
  private prefs: Prefs = { difficulty: 'normal', name: '' };
  private scores: ScoreTable = loadScores();
  private overInfo: GameOverInfo | null = null;
  private overT = 0;
  private debug = false;
  private flash = 0;
  private shake = 0;
  private zoomPunch = 0;
  private camX = 0;
  private camY = 0;
  private prev = new Map<number, Pt>();
  private phase = new Map<number, number>();
  private lastPose = new Map<number, Pose>();
  // État propre à chaque personnage joueur, par id.
  private lastPlayerPose = new Map<number, Pose>();
  private scarf = new Map<number, Pt[]>();
  private parryTick = new Map<number, number>();
  private hurtFlash = new Map<number, number>();
  private ghostTimer = new Map<number, number>();
  /** Noms affichés au-dessus des autres joueurs. */
  private labels = new Map<number, Phaser.GameObjects.Text>();
  private petalTimer = 0;
  private best = 0;
  private orbStreak = 0;
  private orbStreakT = 0;
  private lastLost = 0;
  private wipe = 0;
  /** Bilan coop affiché avec les statistiques par joueur (sinon réaffiché dès qu'elles arrivent). */
  private rosterShown = false;

  constructor() {
    super('game');
  }

  private get world(): World {
    return this.src.world;
  }

  /** Joueur contrôlé par ce client, retrouvé par son id dans le monde courant. */
  private get me(): Player {
    const id = this.src.meId;
    const c = this.meCache;
    if (c && c.id === id && this.world.players.includes(c)) return c;
    const p = this.world.players.find((q) => q.id === id);
    if (p) return (this.meCache = p);
    // En ligne, avant le premier instantané (ou juste après une déconnexion) : dernier état connu.
    if (c && c.id === id) return c;
    const l = this.world.level;
    return (this.meCache = createPlayer(id, '', l.spawn.x, l.spawn.y));
  }

  private player(id: number): Player | undefined {
    return this.world.players.find((q) => q.id === id);
  }

  /** Ralenti : n'existe qu'en local (en ligne, le temps du serveur ne se ralentit pas). */
  private setSlowmo(v: number): void {
    if (this.src === this.local) this.local.slowmo = v;
  }

  /** Chaque objet est rendu par une seule des trois caméras (fond, monde zoomé, interface). */
  private put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: Layer): T => {
    if (layer !== 'bg') this.bgCam.ignore(obj);
    if (layer !== 'world') this.worldCam.ignore(obj);
    if (layer !== 'ui') this.uiCam.ignore(obj);
    return obj;
  };

  create(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    this.prefs = loadPrefs();
    this.difficulty = this.prefs.difficulty;
    const world = createWorld((Date.now() & 0xffff) + 1, { difficulty: this.difficulty });
    this.local = new LocalSource(world, addPlayer(world, 'Ronin').id);
    this.src = this.local;
    const L = this.world.level;

    this.bgCam = this.cameras.main;
    this.worldCam = this.cameras.add(0, 0, W, H);
    this.uiCam = this.cameras.add(0, 0, W, H);
    this.worldCam.setZoom(ZOOM).setBounds(0, 0, L.pxW, L.pxH);
    this.camX = this.me.x + 60;
    this.camY = this.me.y - 60;
    this.worldCam.centerOn(this.camX, this.camY);

    this.backdrop = new Backdrop(this, this.put);
    this.backdrop.setBiome(L.biome);
    this.terrain = new Terrain(this, L, this.put);
    this.fx = new Fx(L, this.terrain);
    this.gBack = this.put(this.add.graphics().setDepth(5), 'world');
    this.gChars = this.put(this.add.graphics().setDepth(10), 'world');
    this.gFront = this.put(this.add.graphics().setDepth(20), 'world');
    this.gDebug = this.put(this.add.graphics().setDepth(30), 'world');

    this.put(this.add.tileSprite(0, 0, W, H, makeGrainOverlay(this, 'grain')).setOrigin(0).setBlendMode(Phaser.BlendModes.MULTIPLY).setDepth(90), 'ui');
    this.put(this.add.image(0, 0, makeVignette(this, 'vignette', W, H)).setOrigin(0).setDepth(91), 'ui');
    this.gOverlay = this.put(this.add.graphics().setDepth(95), 'ui');
    this.hud = new Hud(this, this.put);
    this.allies = new AllyMarkers(this, this.put);
    this.duel = new DuelOverlay(this, this.put, { sfx: this.sfx, shake: (v) => this.addShake(v) });
    this.results = new Results(this, this.put, () => {
      this.sfx.drum(0, true);
      this.addShake(6);
    });
    this.deathText = this.put(this.add.text(W / 2, H * 0.42, '討死', { fontFamily: FONT_BRUSH, fontSize: '150px', color: '#b8321f' }).setOrigin(0.5).setDepth(150).setAlpha(0), 'ui');
    this.deathSub = this.put(this.add.text(W / 2, H * 0.6, '', { fontFamily: FONT_TEXT, fontSize: '22px', color: '#15120e', align: 'center' }).setOrigin(0.5).setDepth(150).setAlpha(0), 'ui');
    this.buildScreens();

    this.controls = new Controls(this.game.canvas);
    this.controls.onKey('F1', () => (this.debug = !this.debug));
    this.controls.onKey('KeyM', () => this.sfx.toggleMute());
    this.controls.onKey('KeyN', () => this.music?.toggle());
    this.controls.onKey('KeyH', () => this.hud.toggleHelp());
    for (const code of MENU_KEYS) this.controls.onKey(code, () => this.menuKey(code));
    if (import.meta.env.DEV) {
      // Raccourcis de test : F2 phase de Marée suivante, F3 arène du gardien, F4 +100 Honneur.
      this.controls.onKey('F2', () => this.screen === 'play' && this.src === this.local && skipWavePhase(this.world));
      this.controls.onKey('F3', () => this.screen === 'play' && this.src === this.local && warpToArena(this.world, this.me.id));
      this.controls.onKey('F4', () => this.screen === 'play' && this.src === this.local && gainHonor(this.world, this.me, 100));
      // F8 : ajoute un « Kage », écho retardé du joueur local, pour tester le rendu de N joueurs.
      this.controls.onKey('F8', () => {
        if (this.screen !== 'play' || this.world.over || this.src !== this.local) return;
        this.local.addEcho();
      });
      // F9 : vrai duel local contre un écho (ajouté au besoin), avec les règles du jeu, sans réseau.
      // Le monde local passe en coop jusqu'à la prochaine partie (resetWorld le remet en solo).
      this.controls.onKey('F9', () => {
        if (this.screen !== 'play' || this.world.over || this.src !== this.local) return;
        const w = this.world;
        const me = this.me;
        const other = w.players.find((p) => p.id !== me.id) ?? this.local.addEcho();
        if (!other) return;
        w.mode = 'coop';
        w.duels ??= [];
        w.duelInvites ??= [];
        if (!startDuel(w, me, other, COOP_DUEL_RULES)) this.hud.banner('決', 'No flat ground here', 'move and try again', '#15120e', 1200);
        for (const ev of w.events) this.onEvent(ev);
        w.events.length = 0;
      });
      // F7 : étape suivante (niveau généré suivant), pour parcourir les biomes.
      this.controls.onKey('F7', () => {
        if (this.screen !== 'play' || this.world.over || this.src !== this.local) return;
        nextStage(this.world);
        for (const ev of this.world.events) this.onEvent(ev);
        this.world.events.length = 0;
      });
      (window as unknown as { __ronin: unknown }).__ronin = this;
    }
  }

  // ─── Écrans et enchaînement des parties ──────────────────────────────────

  private buildScreens(): void {
    this.titleScreen = new TitleScreen(this, this.put, {
      onPlay: () => this.goSelect(),
      onScores: () => this.goScores(this.difficulty, -1),
      onOnline: () => this.goOnline(),
    });
    this.onlineMenu = new OnlineMenu(this, this.put, {
      onJoin: (name) => void this.joinOnline(name),
      onBack: () => this.leaveOnline(null),
    });
    this.diffSelect = new DifficultySelect(this, this.put, {
      onPick: (d) => this.newRun(d),
      onBack: () => this.goTitle(),
    });
    this.nameEntry = new NameEntry(this, this.put, { onSubmit: (raw) => this.submitName(raw) });
    this.scoreboard = new Scoreboard(this, this.put, {
      onPlayAgain: () => this.goSelect(),
      onTitle: () => this.goTitle(),
    });
    this.titleScreen.show();
  }

  /** Le niveau courant a changé (nouvelle étape, nouvelle partie) : terrain, caméra et fond suivent. */
  private applyLevel(): void {
    const L = this.world.level;
    this.terrain.repaint(L);
    this.worldCam.setBounds(0, 0, L.pxW, L.pxH);
    this.backdrop.setBiome(L.biome);
  }

  /** Premier geste de l'utilisateur : le navigateur autorise alors l'audio. */
  private ensureAudio(): void {
    this.sfx.init();
    const out = this.sfx.output;
    if (out && !this.music) {
      this.music = new Music(out.ctx, out.dest);
      this.events.once('destroy', () => this.music?.dispose());
    }
  }

  /** Aiguillage des touches de menu vers l'écran actif (sans effet en jeu). */
  private menuKey(code: string): void {
    if (this.screen === 'play') {
      // En ligne, Échap quitte la salle (pas de pause : le monde continue sans nous).
      if (code === 'Escape' && this.src !== this.local) this.leaveOnline(null);
      return;
    }
    this.ensureAudio();
    if (this.screen === 'title') this.titleScreen.key(code);
    else if (this.screen === 'select') this.diffSelect.key(code);
    else if (this.screen === 'scores') this.scoreboard.key(code);
    else if (this.screen === 'online') this.onlineMenu.key(code);
    else if (this.screen === 'over' && this.overT > GAME_OVER_SKIP) this.leaveGameOver();
  }

  private hideScreens(): void {
    for (const s of [this.titleScreen, this.diffSelect, this.nameEntry, this.scoreboard, this.onlineMenu]) if (s.visible) s.hide();
  }

  private goTitle(): void {
    this.hideScreens();
    this.screen = 'title';
    this.titleScreen.show();
  }

  private goSelect(): void {
    this.ensureAudio();
    this.hideScreens();
    this.screen = 'select';
    this.diffSelect.show(this.difficulty);
  }

  private goScores(focus: DifficultyId, highlight: number): void {
    this.hideScreens();
    this.screen = 'scores';
    this.scoreboard.show(this.scores, focus, highlight);
  }

  // ─── Mode en ligne (la route partagée) ───────────────────────────────────

  private goOnline(): void {
    this.ensureAudio();
    this.hideScreens();
    this.screen = 'online';
    this.onlineMenu.show(this.prefs.name);
    this.controls.setTextMode((key, code) => this.onlineMenu.keyText(key, code));
  }

  /** Connexion à une salle : le SDK réseau n'est chargé qu'ici (le solo n'en a pas besoin). */
  private async joinOnline(name: string): Promise<void> {
    const token = ++this.joinToken;
    this.prefs = { ...this.prefs, name };
    savePrefs(this.prefs);
    try {
      const net = await import('../net/connection');
      const conn = await net.connect(net.defaultServerUrl(), name);
      if (token !== this.joinToken || this.screen !== 'online') {
        conn.leave();
        return;
      }
      const src = new RemoteSource(conn);
      this.pending = src;
      src.onReady(() => this.pending === src && this.startOnline(src));
      src.onClose((reason) => this.leaveOnline(reason));
    } catch (e) {
      if (token === this.joinToken && this.screen === 'online') this.onlineMenu.setStatus((e as Error).message, true);
    }
  }

  /** Premier instantané appliqué : la salle devient le monde affiché. */
  private startOnline(src: RemoteSource): void {
    this.pending = null;
    this.controls.setTextMode(null);
    this.hideScreens();
    this.useSource(src);
    src.consumeStageChanged(); // le niveau vient d'être appliqué par useSource
    this.flash = this.shake = this.zoomPunch = this.wipe = 0;
    this.orbStreak = this.orbStreakT = this.lastLost = 0;
    this.best = 0;
    this.overInfo = null;
    this.results.hide();
    this.hud.reset();
    this.controls.reset();
    this.deathText.setAlpha(0);
    this.deathSub.setAlpha(0);
    this.screen = 'play';
    this.sfx.taiko(false);
    const n = this.world.players.length;
    this.hud.banner('縁', 'The shared road', `${n} ronin on the road · Esc to leave`, '#15120e', 2400);
  }

  /** Quitte la salle (Échap, retour du menu, connexion perdue) ; `reason` : message d'erreur à afficher. */
  private leaveOnline(reason: string | null): void {
    ++this.joinToken;
    const p = this.pending;
    this.pending = null;
    p?.dispose();
    this.controls.setTextMode(null);
    if (this.src !== this.local) this.useSource(this.local); // libère la source en ligne
    this.results.hide();
    this.deathText.setAlpha(0);
    this.deathSub.setAlpha(0);
    if (reason) {
      this.goOnline();
      this.onlineMenu.setStatus(reason, true);
    } else this.goTitle();
  }

  /** Nouvelle partie : le monde est réinitialisé sur place, tout l'état client aussi. */
  private newRun(d: DifficultyId): void {
    this.ensureAudio();
    this.hideScreens();
    this.difficulty = d;
    this.prefs = { ...this.prefs, difficulty: d };
    savePrefs(this.prefs);

    // Une partie solo se joue toujours sur la source locale.
    if (this.src !== this.local) this.useSource(this.local);
    const w = this.local.world;
    resetWorld(w, (Date.now() & 0xffff) + 1, { difficulty: d });
    this.local.reset(addPlayer(w, sanitizeName(this.prefs.name)).id);
    this.meCache = null;
    this.applyLevel();
    this.prev.clear();
    this.phase.clear();
    this.lastPose.clear();
    this.clearCharacters();
    this.flash = this.shake = this.zoomPunch = this.wipe = 0;
    this.orbStreak = this.orbStreakT = this.lastLost = 0;
    this.best = 0; // « best » = meilleur nombre de kills d'une vie, pour cette partie
    this.overInfo = null;
    this.overT = 0;
    this.camX = this.me.x + 60;
    this.camY = this.me.y - 60;
    this.worldCam.centerOn(this.camX, this.camY);
    this.results.hide();
    this.hud.reset();
    this.allies.clear();
    this.duel.clear();
    this.fx.clear();
    this.controls.reset();
    this.deathText.setAlpha(0);
    this.deathSub.setAlpha(0);

    this.screen = 'play';
    const t = DIFFICULTY_TEXT[d];
    this.sfx.taiko(false);
    this.hud.banner(t.kanji, `${t.name} — the journey begins`, `${livesLabel(DIFFICULTIES[d].lives)} · score ×${DIFFICULTIES[d].scoreMult}`, '#15120e', 2000);
  }

  /**
   * Branche une autre source de monde (ex. salle en ligne). La source précédente est libérée,
   * sauf la source locale, conservée pour les parties solo suivantes. À appeler une fois le
   * premier état du monde connu (le joueur `src.meId` présent dans `src.world.players`).
   */
  useSource(src: WorldSource): void {
    if (src === this.src) return;
    if (this.src !== this.local) this.src.dispose();
    this.src = src;
    this.meCache = null;
    this.timeScale = 1;
    this.allies.clear();
    this.duel.clear();
    // Les effets tachent le terrain du niveau : ils suivent l'objet niveau de la nouvelle source.
    this.fx.clear();
    this.fx = new Fx(src.world.level, this.terrain);
    this.resetView();
  }

  /**
   * Le niveau du monde courant a été remplacé (nouvelle source, changement d'étape en ligne) :
   * terrain, fond et caméra suivent, l'état de rendu des personnages repart de zéro.
   */
  resetView(): void {
    this.applyLevel();
    this.prev.clear();
    this.phase.clear();
    this.lastPose.clear();
    this.clearCharacters();
    const me = this.me;
    this.camX = me.x + 60;
    this.camY = me.y - 60;
    this.worldCam.centerOn(this.camX, this.camY);
  }

  /** Oublie l'état de rendu propre aux personnages joueurs (écharpes, flashs, noms…). */
  private clearCharacters(): void {
    this.scarf.clear();
    this.lastPlayerPose.clear();
    this.hurtFlash.clear();
    this.parryTick.clear();
    this.ghostTimer.clear();
    for (const t of this.labels.values()) t.destroy();
    this.labels.clear();
  }

  private onGameOver(info: GameOverInfo): void {
    this.overInfo = info;
    this.overT = 0;
    this.screen = 'over';
    this.controls.reset();
    this.sfx.gong();
  }

  /** Après l'écran 討死 : inscription du nom si le score entre au tableau, sinon tableau direct. */
  private leaveGameOver(): void {
    const info = this.overInfo;
    if (!info || this.screen !== 'over') return;
    // Relu à chaque fois : un autre onglet a pu inscrire un score entre-temps.
    this.scores = loadScores();
    const list = this.scores[this.difficulty];
    if (qualifies(list, info.score)) {
      const { rank } = insertScore(list, this.entryFor(info, sanitizeName(this.prefs.name)));
      this.screen = 'name';
      this.deathText.setAlpha(0);
      this.deathSub.setAlpha(0);
      this.nameEntry.show({ score: info.score, rank, difficulty: this.difficulty, defaultName: this.prefs.name });
      this.controls.setTextMode((key, code) => this.nameEntry.keyText(key, code));
    } else {
      this.deathText.setAlpha(0);
      this.deathSub.setAlpha(0);
      this.goScores(this.difficulty, -1);
    }
  }

  private entryFor(info: GameOverInfo, name: string) {
    return { name, score: info.score, loop: info.loop, kills: info.kills, date: Date.now() };
  }

  private submitName(raw: string): void {
    const info = this.overInfo;
    if (!info) return;
    this.controls.setTextMode(null);
    const name = sanitizeName(raw);
    this.scores = loadScores();
    const { list, rank } = insertScore(this.scores[this.difficulty], this.entryFor(info, name));
    this.scores = { ...this.scores, [this.difficulty]: list };
    // Stockage indisponible (navigation privée, quota) : le tableau reste valable pour la session.
    if (!saveScores(this.scores)) console.warn('Ronin.io: high scores could not be saved (storage unavailable).');
    this.prefs = { ...this.prefs, name };
    savePrefs(this.prefs);
    this.sfx.bell();
    this.goScores(this.difficulty, rank);
  }

  update(time: number, delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.timeScale = 1;
    this.scoreboard.update(dt);
    // Menus à la manette (fronts montants traduits en codes clavier).
    for (const code of this.controls.padMenu()) {
      // En jeu, les boutons de la manette sont des actions (B = dash), jamais des touches de menu.
      if (this.screen === 'play') continue;
      if (this.screen === 'name') {
        if (code === 'Enter') this.nameEntry.keyText('Enter', 'Enter');
      } else this.menuKey(code);
    }
    if (this.screen === 'over') {
      this.overT += dt;
      // N'importe quel bouton de jeu, clic ou bouton de manette passe l'écran 討死.
      if (this.controls.sample() !== 0 && this.overT > GAME_OVER_SKIP) this.leaveGameOver();
    }
    if (this.screen === 'over' && this.overT > GAME_OVER_HOLD) this.leaveGameOver();
    // En ligne, Select maintenu à la manette quitte la salle (B sert au dash, Échap au clavier).
    const online = this.screen === 'play' && this.src !== this.local;
    if (this.padQuit.update(online && this.controls.padQuitHeld(), time) && online) this.leaveOnline(null);
    // Salle rejointe : on applique ses instantanés jusqu'au premier (startOnline prend alors le relais).
    if (this.screen === 'online' && this.pending) this.pending.advance(dt, () => 0, () => undefined);
    if (this.screen === 'play' || this.screen === 'over') {
      const src = this.src;
      const events = src.advance(dt, () => this.controls.sample(), () => this.snapshot());
      if (src === this.local) this.timeScale = this.local.timeScale;
      for (let i = 0; i < events.length; i++) {
        // En local, chaque événement garde le tick du pas qui l'a produit (rattrapage de plusieurs pas).
        this.onEvent(events[i], src === this.local ? this.local.eventTicks[i] : this.world.tick);
      }
      // En ligne, une étape a pu changer sans que son événement nous parvienne (arrivée en cours de route).
      if (src instanceof RemoteSource && src.consumeStageChanged() && !events.some((e) => e.type === 'stageStart')) this.resetView();
    }
    this.renderFrame(dt, time);
  }

  private snapshot(): void {
    for (const p of this.world.players) this.prev.set(p.id, { x: p.x, y: p.y });
    for (const e of this.world.enemies) this.prev.set(e.id, { x: e.x, y: e.y });
  }

  private lerpPos(id: number, x: number, y: number, a: number): Pt {
    const pv = this.prev.get(id);
    if (!pv || Math.abs(pv.x - x) > 120) return { x, y };
    return { x: lerp(pv.x, x, a), y: lerp(pv.y, y, a) };
  }

  // ─── Rendu ────────────────────────────────────────────────────────────────

  private renderFrame(dt: number, time: number): void {
    const w = this.world;
    const alpha = Math.min(1, this.src.alpha());
    const boil = Math.floor(time / 85); // « ligne qui frémit » à ~12 i/s, comme une animation à la main
    const fxDt = dt * this.timeScale;
    this.gBack.clear();
    this.gChars.clear();
    this.gFront.clear();
    this.gDebug.clear();
    this.gOverlay.clear();

    this.drawCheckpoints(time);
    this.drawStageProps(time);
    for (const e of w.enemies) this.drawEnemyEntity(e, alpha, fxDt, time, boil);
    this.drawProjectiles(time);
    this.drawOrbs(time);
    const me = this.me;
    // Les autres joueurs d'abord, le joueur local en dernier, par-dessus.
    for (const p of w.players) if (p !== me) this.drawOther(p, alpha, dt, time, boil);
    const pos = this.drawPlayer(me, alpha, dt, time, boil);
    this.pruneCharacters();

    this.fx.update(fxDt);
    this.fx.draw(this.gBack, this.gFront, boil);

    this.petalTimer -= dt;
    if (this.petalTimer <= 0) {
      const biome = this.world.level.biome;
      // Cadence et nature de l'ambiance selon le biome : neige dense, cendres, pétales rares au château.
      const k = biome === 'snow' ? 0.35 : biome === 'castle' ? 2.5 : 1;
      this.petalTimer = (0.2 + Math.random() * 0.45) * k;
      const v = this.worldCam.worldView;
      this.fx.petal(v.x + v.width * (0.2 + Math.random()), v.y - 10, biome === 'snow' ? 'snow' : biome === 'village' ? 'ash' : 'petal');
    }

    if (this.debug) this.drawDebug();
    this.updateCamera(pos, dt);
    this.backdrop.update(this.worldCam);
    this.terrain.flush();

    const W = this.scale.width;
    const H = this.scale.height;
    if (w.wave.phase === 'tide') {
      // Pendant la Marée, l'encre gagne les bords de l'écran.
      const k = 0.1 + Math.sin(time * 0.003) * 0.03;
      this.gOverlay.fillStyle(C.redDeep, k);
      this.gOverlay.fillRect(0, 0, W, 10);
      this.gOverlay.fillRect(0, H - 10, W, 10);
    }
    if (this.wipe > 0) {
      // Lavis d'encre entre deux boucles
      const k = Math.min(1, this.wipe / 0.9);
      this.gOverlay.fillStyle(C.ink, k * k);
      this.gOverlay.fillRect(0, 0, W, H);
      this.wipe -= dt;
    }
    if (this.flash > 0) {
      this.gOverlay.fillStyle(C.paper, Math.min(0.65, this.flash * 4));
      this.gOverlay.fillRect(0, 0, W, H);
      this.flash -= dt;
    }
    this.orbStreakT -= dt;
    if (this.orbStreakT <= 0) this.orbStreak = 0;
    const src = this.src;
    this.hud.setNet(src instanceof RemoteSource ? { rtt: src.rtt, jitter: src.jitterMs, players: w.players.length } : null);
    this.hud.update(this.me, w, this.best, dt, time, this.worldCam);
    // Bilan coop : coches « prêt », compte à rebours ; en ligne, les statistiques par joueur peuvent
    // arriver une image après l'événement stageClear : le bilan est alors réaffiché avec elles.
    if (w.mode === 'coop' && w.stage.state === 'cleared' && this.results.visible) {
      if (!this.rosterShown && w.stage.byPlayer) {
        this.results.show(w.stage, this.me, { stage: w.level.stage, biome: w.level.biome }, buildRoster(w, this.src.meId));
        this.rosterShown = true;
      }
      this.results.update(buildRoster(w, this.src.meId), readyInfo(w));
    }
    if (this.screen === 'play') this.allies.update(w, this.src.meId, this.worldCam);
    else this.allies.hide();
    if (this.screen === 'play' && (w.duels || w.duelInvites || this.duel.busy)) this.duel.update(duelView(w, this.src.meId, this.duel.memo), w, this.worldCam, time);
    else this.duel.hide();
    this.updateMusic();

    const dead = this.me.state === 'dead' && (this.screen === 'play' || this.screen === 'over');
    const da = dead ? Math.min(1, this.me.stateT / 40) : Math.max(0, this.deathText.alpha - dt * 3);
    this.deathText.setAlpha(da);
    this.deathSub.setAlpha(da);
    if (dead) {
      if (this.world.mode === 'coop') {
        const lost = this.lastLost > 0 ? `\n${this.lastLost} honor left on the ground — return for it` : '';
        const where = this.world.stage.state === 'arena' ? 'at the arena gate' : 'at the shrine';
        this.deathSub.setText(`${foesLabel(this.me.kills)}${lost}\nyou will be reborn ${where}…`);
      } else if (this.me.out) {
        const skip = this.screen === 'over' && this.overT > GAME_OVER_SKIP ? '\n\npress any key' : '';
        this.deathSub.setText(`Your journey ends\nscore ${fmtScore(this.me.score)} · ${foesLabel(this.me.runKills)}${skip}`);
      } else {
        const lost = this.lastLost > 0 ? `\n${this.lastLost} honor left on the ground — return for it` : '';
        this.deathSub.setText(`${foesLabel(this.me.kills)}${lost}\n${livesLabel(this.me.lives)} left — you will be reborn at the shrine…`);
      }
    }
  }

  /** L'ambiance musicale suit l'état de l'étape et de la Marée. */
  private updateMusic(): void {
    if (!this.music) return;
    const st = this.world.stage.state;
    const wave = this.world.wave.phase;
    const inGame = this.screen === 'play';
    const mood: Mood = !inGame ? 'rest' : st === 'arena' ? 'boss' : st === 'cleared' || st === 'gateOpen' ? 'rest' : wave === 'calm' ? 'calm' : 'tide';
    this.music.setMood(mood);
    this.music.duck(inGame && this.me.state === 'dead');
  }

  /** Barrière de l'arène (kekkai) et porte de fin d'étape. */
  private drawStageProps(time: number): void {
    const st = this.world.stage;
    const l = this.world.level;
    const gB = this.gFront;
    const boil = Math.floor(time / 90);
    if (st.state === 'arena') {
      const x = (l.arena.col + 0.5) * TILE;
      const top = 0;
      const bot = l.arena.rows * TILE;
      for (let i = 0; i < 4; i++) {
        const r = seeded(hash2(i + 70, boil));
        const pts: Pt[] = [];
        for (let y = top; y <= bot; y += 24) pts.push({ x: x + (i - 1.5) * 6 + Math.sin(y * 0.03 + time * 0.004 + i) * 3, y });
        gStroke(gB, pts, i % 2 ? C.redDeep : C.ink, 0.55, { width: 3, taperStart: 0.02, taperEnd: 0.02, jitter: 0.3 }, r);
      }
      for (let k = 0; k < 5; k++) {
        const y = bot - 70 - k * 90;
        const r = seeded(hash2(k + 90, boil));
        const sway = Math.sin(time * 0.003 + k) * 2;
        gFill(gB, [{ x: x - 6 + sway, y }, { x: x + 6 + sway, y }, { x: x + 6 + sway * 1.5, y: y + 30 }, { x: x - 6 + sway * 1.5, y: y + 30 }], C.paper, 0.95);
        gStroke(gB, [{ x: x - 2 + sway, y: y + 6 }, { x: x + 2 + sway, y: y + 14 }, { x: x - 2 + sway, y: y + 23 }], C.red, 0.9, { width: 2.2, taperStart: 0.1, taperEnd: 0.4 }, r);
      }
      if (Math.random() < 0.25) this.fx.mist(x, bot - Math.random() * bot, 1, { color: C.redDeep, size: 5, alpha: 0.2, vy: -30, life: 0.8 });
      if (this.world.mode === 'coop') this.drawKekkaiArrows(x, bot, time, boil);
    }
    // Porte : scellée par des ofuda tant que le gardien vit, lumineuse une fois ouverte.
    const gx = l.gate.x;
    const gy = l.gate.y;
    const r = seeded(hash2(777, boil));
    const open = st.state === 'gateOpen' || st.state === 'cleared';
    if (!open) {
      const sag = (t: number) => Math.sin(Math.PI * t) * 9;
      const rope: Pt[] = [];
      for (let i = 0; i <= 10; i++) rope.push({ x: gx - 31 + i * 6.2, y: gy - 88 + sag(i / 10) });
      gStroke(this.gBack, rope, C.wood, 0.95, { width: 4.5, taperStart: 0.02, taperEnd: 0.02, jitter: 0.2 }, r);
      for (let k = 0; k < 3; k++) {
        const t = 0.25 + k * 0.25;
        const sx = gx - 31 + t * 62;
        const sy = gy - 86 + sag(t);
        const sway = Math.sin(time * 0.004 + k * 1.7) * 2;
        gFill(this.gBack, [{ x: sx - 5, y: sy }, { x: sx + 5, y: sy }, { x: sx + 5 + sway, y: sy + 28 }, { x: sx - 5 + sway, y: sy + 28 }], C.paper, 0.97);
        gStroke(this.gBack, [{ x: sx + sway * 0.3, y: sy + 5 }, { x: sx + 2 + sway * 0.6, y: sy + 13 }, { x: sx - 1 + sway, y: sy + 23 }], C.red, 0.9, { width: 2.4, taperStart: 0.1, taperEnd: 0.4 }, r);
      }
    } else {
      const pulse = 1 + Math.sin(time * 0.005) * 0.08;
      gBlob(this.gBack, gx, gy - 52, 40 * pulse, C.paper, 0.55, r, 0.2);
      gBlob(this.gBack, gx, gy - 52, 26 * pulse, 0xfffdf6, 0.7, r, 0.15);
      gStroke(this.gBack, ringPoints(gx, gy - 52, 46 * pulse, time * 0.002, time * 0.002 + Math.PI * 1.7, 20), C.red, 0.4, { width: 2.5, taperStart: 0.3, taperEnd: 0.5 }, r);
      if (Math.random() < 0.3) this.fx.mist(gx + (Math.random() - 0.5) * 50, gy - 10, 1, { color: C.paper, size: 4, alpha: 0.5, vy: -40, life: 1, front: true });
    }
  }

  /**
   * Coop : sens unique du kekkai. Chevrons d'encre qui glissent vers l'intérieur (la droite) entre les
   * ofuda, et une flèche au pied de la barrière : on entre, on ne ressort pas.
   */
  private drawKekkaiArrows(x: number, bot: number, time: number, boil: number): void {
    const gB = this.gFront;
    const drift = (time * 0.02) % 14;
    for (let k = 0; k < 5; k++) {
      const y = bot - 100 - k * 90; // entre deux ofuda
      const r = seeded(hash2(k + 130, boil));
      for (let j = 0; j < 3; j++) {
        const cx = x - 16 + j * 14 + drift;
        const a = 0.25 + 0.45 * (1 - Math.abs(cx - x) / 30);
        gStroke(gB, [{ x: cx - 5, y: y - 8 }, { x: cx + 3, y }, { x: cx - 5, y: y + 8 }], C.redDeep, Math.max(0.1, a), { width: 2.4, taperStart: 0.15, taperEnd: 0.35 }, r);
      }
    }
    // Flèche au sol : trait horizontal et pointe, du côté extérieur vers l'arène.
    const r = seeded(hash2(171, boil));
    const y = bot - 8;
    gStroke(gB, [{ x: x - 34, y }, { x: x + 26, y: y - 1 }], C.ink, 0.6, { width: 3, taperStart: 0.4, taperEnd: 0.05, jitter: 0.2 }, r);
    gStroke(gB, [{ x: x + 16, y: y - 8 }, { x: x + 28, y: y - 1 }, { x: x + 16, y: y + 6 }], C.ink, 0.7, { width: 3, taperStart: 0.1, taperEnd: 0.3 }, r);
  }

  private drawCheckpoints(time: number): void {
    const cps = this.world.level.checkpoints;
    cps.forEach((c, i) => {
      // Coop : la lueur marque le sanctuaire commun de la salle, pas celui du joueur local.
      const active = this.world.mode === 'coop' ? i === this.world.shrine : i === this.me.checkpoint;
      const fy = c.y - 30 * 1.35;
      const r = seeded(hash2(i, Math.floor(time / 90)));
      if (active) {
        const fl = 1 + Math.sin(time * 0.013 + i) * 0.15;
        gBlob(this.gBack, c.x, fy, 14 * fl, C.red, 0.12, r, 0.3);
        gBlob(this.gBack, c.x, fy, 4.5 * fl, C.red, 0.9, r, 0.25);
        gBlob(this.gBack, c.x, fy - 2, 2.2, C.paper, 0.8, r, 0.2);
      } else gBlob(this.gBack, c.x, fy, 3, C.wash, 0.5, r, 0.2);
    });
  }

  private drawEnemyEntity(e: Enemy, alpha: number, fxDt: number, time: number, boil: number): void {
    if (e.state === 'hidden') return;
    const pos = this.lerpPos(e.id, e.x, e.y, alpha);
    let ph = this.phase.get(e.id) ?? Math.random() * 6;
    if (e.onGround) ph += (Math.abs(e.vx) * fxDt * 0.1) / SCALE[e.type];
    this.phase.set(e.id, ph);
    const t = e.stateT + (e.freeze > 0 ? 0 : alpha);
    const pose = enemyPose(e, t, ph);
    this.lastPose.set(e.id, pose);
    const sk = enemySkeleton(e.type, pose);
    const X = makeXf(pos.x, pos.y, e.facing);
    const r = seeded(hash2(e.id, boil));

    const trail = bossTrail(e, t);
    if (trail) {
      const tips = trail.tips.map(X);
      gFill(this.gChars, tips.concat(trail.inner.map(X).reverse()), C.ink, 0.85 * trail.alpha);
      gStroke(this.gChars, tips, C.red, 0.9 * trail.alpha, { width: 3, taperStart: 0.6, taperEnd: 0.05 }, r);
    }
    if (e.type === 'boss' && e.phase2 && Math.random() < 0.35) {
      this.fx.mist(pos.x + (Math.random() - 0.5) * 60, pos.y - Math.random() * 90, 1, { color: C.redDeep, size: 7, alpha: 0.25, vy: -60, life: 0.7 });
    }
    drawEnemy(this.gChars, e.type, sk, X, {
      alpha: e.state === 'intro' && e.type === 'boss' ? Math.min(1, t / 30) : 1,
      tint: e.flash > 0 ? C.red : null,
      rand: r,
      glint: e.state === 'windup' ? Math.min(1, t / windupLength(e)) : 0,
      parts: 'all',
      doomK: e.state === 'doomed' ? t / ENEMY.DOOM_TICKS : undefined,
      guard: isGuarding(e),
      time,
      phase2: e.phase2,
    });
    if (e.state === 'stunned') {
      const h = headWorld(sk, X);
      const rad = 9 * SCALE[e.type];
      for (let i = 0; i < 3; i++) {
        const a0 = time * 0.008 + i * 2.1;
        gStroke(this.gFront, ringPoints(h.x, h.y - 10 - rad, rad, a0, a0 + 1.3, 6), C.ink, 0.7, { width: 1.8, taperStart: 0.3, taperEnd: 0.6 }, seeded(i + boil));
      }
    }
    // Télégraphe du balayage : la zone dangereuse est marquée au sol.
    if (e.type === 'boss' && e.state === 'windup' && (e.move === 'sweep' || e.move === 'leap')) {
      const k = Math.min(1, t / windupLength(e));
      if (e.move === 'sweep') {
        const x0 = pos.x + e.facing * BOSS.SWEEP_HB.x;
        gStroke(this.gBack, [{ x: x0, y: pos.y - 1 }, { x: x0 + e.facing * BOSS.SWEEP_HB.w * k, y: pos.y - 1 }], C.red, 0.35, { width: 4, taperStart: 0.1, taperEnd: 0.6 }, r);
      } else {
        // Coop : le bond vise la cible du gardien (joueur de son côté du kekkai), pas forcément le joueur local.
        const tgt = this.world.mode === 'coop' ? (targetPlayer(this.world, e)?.x ?? this.me.x) : this.me.x;
        gStroke(this.gBack, ringPoints(tgt, pos.y - 2, 30 * k + 10, Math.PI, Math.PI * 2, 12), C.red, 0.35, { width: 3, taperStart: 0.2, taperEnd: 0.2 }, r);
      }
    }
  }

  private drawProjectiles(time: number): void {
    for (const a of this.world.projectiles) {
      const r = seeded(a.id);
      const col = a.owner === 'player' ? C.red : C.ink;
      if (a.kind === 'arrow') {
        const ang = Math.atan2(a.vy, a.vx);
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        const tail = { x: a.x - dx * 24, y: a.y - dy * 24 };
        gStroke(this.gChars, [tail, { x: a.x, y: a.y }], col, 1, { width: 1.6, taperStart: 0, taperEnd: 0 }, r);
        for (const s of [-1, 1]) gStroke(this.gChars, [{ x: tail.x + dx * 6, y: tail.y + dy * 6 }, { x: tail.x - dy * s * 4, y: tail.y + dx * s * 4 }], col, 0.8, { width: 1.3 }, r);
        gFill(this.gChars, [{ x: a.x + dx * 5, y: a.y + dy * 5 }, { x: a.x - dy * 2.2, y: a.y + dx * 2.2 }, { x: a.x + dy * 2.2, y: a.y - dx * 2.2 }], col, 1);
      } else if (a.kind === 'shuriken') {
        const spin = time * 0.03 + a.id;
        for (let i = 0; i < 4; i++) {
          const ang = spin + (i * Math.PI) / 2;
          gStroke(this.gChars, [{ x: a.x, y: a.y }, { x: a.x + Math.cos(ang) * 6, y: a.y + Math.sin(ang) * 6 }], col, 1, { width: 2.6, taperStart: 0, taperEnd: 0.9 }, r);
        }
        gStroke(this.gBack, [{ x: a.x - Math.sign(a.vx) * 26, y: a.y }, { x: a.x, y: a.y }], C.wash, 0.35, { width: 1.5, taperStart: 0.9, taperEnd: 0 }, r);
      } else {
        // Vague de vent : croissant vertical d'encre
        const d = Math.sign(a.vx);
        const pts: Pt[] = [];
        for (let i = 0; i <= 8; i++) {
          const u = i / 8 - 0.5;
          pts.push({ x: a.x + d * (10 - u * u * 44), y: a.y + u * 54 });
        }
        gStroke(this.gChars, pts, C.ink, 0.8, { width: 8, taperStart: 0.4, taperEnd: 0.4, jitter: 0.25 }, r);
        gStroke(this.gChars, pts.map((q) => ({ x: q.x + d * 2, y: q.y })), C.red, 0.7, { width: 2, taperStart: 0.4, taperEnd: 0.4 }, r);
      }
    }
  }

  private drawOrbs(time: number): void {
    for (const o of this.world.orbs) {
      const r = seeded(o.id + Math.floor(time / 120));
      const bob = o.onGround ? Math.sin(time * 0.006 + o.id) * 2 - 3 : 0;
      const size = o.value >= 25 ? 5.5 : o.value >= 5 ? 4 : 2.6;
      const fade = o.life < 120 ? (Math.floor(time / 80) % 2 ? 0.3 : 1) : 1;
      const col = o.lost ? C.red : o.value >= 5 ? C.redDeep : C.ink;
      gBlob(this.gFront, o.x, o.y + bob, size * 2.2, o.lost ? C.red : C.wash, 0.14 * fade, r, 0.3);
      gBlob(this.gFront, o.x, o.y + bob, size, col, 0.9 * fade, r, 0.2);
      if (o.lost) star(this.gFront, o.x, o.y + bob, 6 + Math.sin(time * 0.01 + o.id) * 2, C.red, 0.5 * fade, r);
    }
  }

  /** Autre joueur (coop, ou écho de débogage) : dessiné s'il est près de la vue, avec son nom au-dessus. */
  private drawOther(p: Player, alpha: number, dt: number, time: number, boil: number): void {
    const v = this.worldCam.worldView;
    const label = this.labels.get(p.id);
    const visible = p.x > v.x - OFFSCREEN_MARGIN && p.x < v.right + OFFSCREEN_MARGIN && p.y > v.y - OFFSCREEN_MARGIN && p.y < v.bottom + OFFSCREEN_MARGIN * 2;
    if (!visible) {
      label?.setVisible(false);
      return;
    }
    const pos = this.drawPlayer(p, alpha, dt, time, boil);
    // Nom : masqué pendant la mort et une fois sorti de la partie.
    const show = p.state !== 'dead' && !p.out && p.name !== '';
    const t = label ?? this.makeLabel(p);
    // Coop en ligne : un joueur absent (aucun bouton depuis 30 s) est signalé et estompé.
    const away = !!this.world.away?.includes(p.id);
    const text = away ? `${p.name} · away` : p.name;
    if (t.text !== text) t.setText(text);
    // En duel, le nom est porté par la surcouche du duel (avec les marques de victoire).
    t.setPosition(pos.x, pos.y - 64).setVisible(show && !this.duel.ownsName(p.id)).setAlpha(away ? 0.5 : 1);
  }

  private makeLabel(p: Player): Phaser.GameObjects.Text {
    const t = this.put(
      this.add.text(0, 0, p.name, {
        fontFamily: FONT_TEXT, fontSize: '13px', color: hexCss(playerColor(p.color)),
        stroke: hexCss(C.paper), strokeThickness: 3,
      }).setOrigin(0.5, 1).setDepth(25),
      'world',
    );
    this.labels.set(p.id, t);
    return t;
  }

  /** Oublie l'état de rendu des joueurs qui ne sont plus dans le monde (départ, déconnexion). */
  private pruneCharacters(): void {
    const players = this.world.players;
    const gone = (id: number) => !players.some((p) => p.id === id);
    for (const [id, t] of this.labels) {
      if (!gone(id) && id !== this.src.meId) continue;
      t.destroy();
      this.labels.delete(id);
    }
    for (const m of [this.scarf, this.lastPlayerPose, this.hurtFlash, this.parryTick, this.ghostTimer] as Map<number, unknown>[]) {
      for (const id of m.keys()) if (gone(id)) m.delete(id);
    }
  }

  private drawPlayer(p: Player, alpha: number, dt: number, time: number, boil: number): Pt {
    const pos = this.lerpPos(p.id, p.x, p.y, alpha);
    let ph = this.phase.get(p.id) ?? 0;
    if (p.onGround) ph += Math.abs(p.vx) * dt * this.timeScale * 0.075;
    this.phase.set(p.id, ph);
    const t = p.stateT + (p.freeze > 0 ? 0 : alpha);
    const view = samuraiPose(p, t, ph, this.world.tick, this.world.tick - (this.parryTick.get(p.id) ?? -999), time);
    this.lastPlayerPose.set(p.id, view.pose);
    const accent = playerColor(p.color);
    const X = makeXf(pos.x, pos.y, p.facing, view.rot);
    const sk = buildSkeleton(view.pose, SAMURAI);
    const r = seeded(hash2(p.id + 999, boil));

    this.updateScarf(headBackWorld(sk, X), p, dt * this.timeScale, time);

    if (p.state === 'dash' || p.state === 'iaiStrike' || (p.state === 'slide' && p.stateT < 10)) {
      const gt = (this.ghostTimer.get(p.id) ?? 0) - dt;
      this.ghostTimer.set(p.id, gt <= 0 ? 0.03 : gt);
      if (gt <= 0) {
        this.fx.ghost(view.pose, pos.x, pos.y, p.facing, view.rot, 0.22, C.washLight, 0.5);
      }
    }

    // Croissant d'encre de la lame
    const tr = slashTrail(p, t);
    if (tr) {
      const tips = tr.tips.map(X);
      gFill(this.gChars, tips.concat(tr.wash.map(X).reverse()), C.wash, 0.22 * tr.alpha);
      gFill(this.gChars, tips.concat(tr.inner.map(X).reverse()), C.ink, 0.9 * tr.alpha);
      if (tr.heavy) gStroke(this.gChars, tips, accent, 0.85 * tr.alpha, { width: 2.4, taperStart: 0.6, taperEnd: 0.05 }, r);
    }
    if (p.state === 'attack' && p.attack === 'plunge' && !p.plungeLanded && p.stateT > ATTACKS.plunge.startup) {
      for (let i = -1; i <= 1; i++) {
        gStroke(this.gBack, [{ x: pos.x + i * 7, y: pos.y - 110 - r() * 40 }, { x: pos.x + i * 7, y: pos.y - 40 }], C.ink, 0.35, { width: 2.2, taperStart: 0.9, taperEnd: 0.1 }, r);
      }
    }
    if (p.state === 'iaiCharge') {
      const k = Math.min(1, p.iaiCharge / P.IAI_FULL_CHARGE);
      const a0 = time * 0.004;
      gStroke(this.gBack, ringPoints(pos.x, pos.y - 24, 70 - 44 * k, a0, a0 + Math.PI * 1.6, 24), k >= 1 ? C.red : C.ink, 0.15 + 0.25 * k, { width: 2 + 3 * k, taperStart: 0.3, taperEnd: 0.6 }, r);
      if (Math.random() < 0.3) {
        const ang = Math.random() * Math.PI * 2;
        this.fx.mist(pos.x + Math.cos(ang) * 60, pos.y - 24 + Math.sin(ang) * 40, 1, { color: C.ink, size: 2.5, alpha: 0.4, vx: -Math.cos(ang) * 120, vy: -Math.sin(ang) * 80, life: 0.4, spread: 0 });
      }
    }

    let a = 1;
    if (p.iframes > 0 && p.state !== 'dash' && p.state !== 'iaiStrike' && p.state !== 'dead' && Math.floor(time / 70) % 2 === 0) a = 0.4;
    if (p.state === 'dead') a = Math.min(1, p.respawnT / 40);
    const hurt = this.hurtFlash.get(p.id) ?? 0;
    drawSamurai(this.gChars, sk, X, {
      alpha: a,
      tint: hurt > 0 ? C.red : null,
      rand: r,
      glint: p.state === 'iaiCharge' ? Math.min(1, p.iaiCharge / P.IAI_FULL_CHARGE) : 0,
      scarf: this.scarf.get(p.id),
      accent,
    });
    this.hurtFlash.set(p.id, hurt - dt);
    return pos;
  }

  /** Hachimaki : chaîne de points qui suit la tête avec du retard (vent + gravité). */
  private updateScarf(anchor: Pt, p: Player, dt: number, time: number): void {
    const n = 8;
    const seg = 5;
    let sc = this.scarf.get(p.id);
    if (!sc || sc.length !== n || Math.abs(sc[0].x - anchor.x) > 100) {
      sc = Array.from({ length: n }, (_, i) => ({ x: anchor.x - p.facing * i * seg, y: anchor.y }));
      this.scarf.set(p.id, sc);
    }
    sc[0] = { x: anchor.x, y: anchor.y };
    for (let i = 1; i < n; i++) {
      const q = sc[i];
      q.x += (-p.facing * 26 + Math.sin(time * 0.006 + i * 0.9) * 18) * dt;
      q.y += (34 + Math.cos(time * 0.009 + i * 0.7) * 22) * dt;
      const pr = sc[i - 1];
      const dx = q.x - pr.x;
      const dy = q.y - pr.y;
      const d = Math.hypot(dx, dy) || 1;
      q.x = pr.x + (dx / d) * seg;
      q.y = pr.y + (dy / d) * seg;
    }
  }

  private updateCamera(pos: Pt, dt: number): void {
    const p = this.me;
    const look = p.facing * 60 + Phaser.Math.Clamp(p.vx * 0.2, -70, 70);
    this.camX += (pos.x + look - this.camX) * (1 - Math.exp(-dt * 4.5));
    this.camY += (pos.y - 60 - this.camY) * (1 - Math.exp(-dt * 3));
    let sx = 0;
    let sy = 0;
    if (this.shake > 0.2) {
      sx = (Math.random() - 0.5) * this.shake;
      sy = (Math.random() - 0.5) * this.shake;
    }
    this.shake *= Math.exp(-dt * 12);
    this.zoomPunch *= Math.exp(-dt * 7);
    this.worldCam.setZoom(ZOOM * (1 + this.zoomPunch));
    this.worldCam.centerOn(this.camX + sx, this.camY + sy);
  }

  private drawDebug(): void {
    const g = this.gDebug;
    const rect = (r: Rect, color: number) => {
      g.lineStyle(1, color, 0.9);
      g.strokeRect(r.x, r.y, r.w, r.h);
    };
    for (const p of this.world.players) {
      rect(bodyRect(p), 0x2266ff);
      const ab = activeAttackBox(p);
      if (ab) rect(ab, 0xff2222);
    }
    for (const e of this.world.enemies) {
      rect(bodyRect(e), 0x22aa44);
      if (e.state !== 'attack') continue;
      if (e.type === 'ashigaru') rect(boxFromFacing(e.x, e.y, e.facing, SPEAR_HB), 0xff8800);
      if (e.type === 'oni') rect(boxFromFacing(e.x, e.y, e.facing, ONI_SMASH_HB), 0xff8800);
      if (e.type === 'ninja') rect(boxFromFacing(e.x, e.y, e.facing, NINJA_SLASH_HB), 0xff8800);
      if (e.type === 'boss' && e.move === 'sweep') rect(boxFromFacing(e.x, e.y, e.facing, BOSS.SWEEP_HB), 0xff8800);
    }
  }

  // ─── Événements de simulation → mise en scène ────────────────────────────

  private addShake(v: number): void {
    this.shake = Math.max(this.shake, v);
  }

  /** Cloche douce (sanctuaire d'un coéquipier) : une seule note, plus brève et plus faible que Sfx.bell. */
  private softBell(): void {
    const out = this.sfx.output;
    if (!out) return;
    const { ctx, dest } = out;
    const t = ctx.currentTime;
    for (const [f, peak, dur] of [[784.6, 0.035, 1.1], [1176, 0.015, 0.7]] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  private near(x: number): boolean {
    return Math.abs(x - this.me.x) < 700;
  }

  private popKanji(text: string, x: number, y: number, color: string, size: number): void {
    const t = this.put(this.add.text(x, y, text, { fontFamily: FONT_BRUSH, fontSize: `${size}px`, color }).setOrigin(0.5).setDepth(40).setScale(1.7).setAlpha(0.95), 'world');
    this.tweens.add({ targets: t, scale: 1, duration: 160, ease: 'Back.easeOut' });
    this.tweens.add({ targets: t, y: y - 26, alpha: 0, delay: 380, duration: 600, ease: 'Sine.easeIn', onComplete: () => t.destroy() });
  }

  /**
   * Mise en scène d'un événement. `tick` : tick du monde au moment de l'événement.
   * Les événements d'un joueur (pid) visent ce joueur ; tremblement, flash, ralenti et sons
   * de dégât ne concernent que le joueur local (les autres sont seulement entendus de près).
   */
  private onEvent(ev: GameEvent, tick = this.world.tick): void {
    const fx = this.fx;
    const mine = 'pid' in ev && ev.pid === this.src.meId;
    // Son d'une action de joueur : toujours pour le joueur local, à portée d'oreille pour les autres.
    const hear = (x: number) => mine || this.near(x);
    // Coups : sans auteur (solo) ou du joueur local → toujours entendus ; ceux des autres, de près.
    const hearHit = (x: number) => isMine(ev, this.src.meId) || this.near(x);
    const shake = () => this.addShake(shakeFor(ev, this.src.meId, this.me, this.world.mode === 'coop'));
    switch (ev.type) {
      case 'swing':
        if (hear(ev.x)) this.sfx.swing(ATTACKS[ev.attack].heavy);
        if (ev.attack === 'slash3') fx.dust(ev.x, ev.y, -ev.dir, 5);
        break;
      case 'hit':
        if (hearHit(ev.x)) this.sfx.hit(ev.heavy);
        fx.inkBurst(ev.x, ev.y, ev.dir, ev.heavy ? 16 : 10, ev.heavy ? 420 : 300);
        fx.sparks(ev.x, ev.y, 5, C.ink, 300);
        shake();
        break;
      case 'kill': {
        const pose = this.lastPose.get(ev.id);
        const boss = ev.enemyType === 'boss';
        if (pose) fx.corpse(ev.enemyType, pose, ev.x, ev.y, ev.facing, ev.dir, ev.cutAngle, ev.byIai || boss);
        const h = 22 * SCALE[ev.enemyType];
        fx.inkBurst(ev.x, ev.y - h, ev.dir, ev.byIai ? 34 : boss ? 70 : 22, ev.byIai ? 520 : boss ? 620 : 380);
        if (ev.byIai || boss) fx.inkBurst(ev.x, ev.y - h, ev.dir, boss ? 30 : 8, 300, C.red);
        this.sfx.slice();
        if (mine || boss) this.addShake(boss ? 18 : 5);
        this.lastPose.delete(ev.id);
        this.prev.delete(ev.id);
        this.phase.delete(ev.id);
        if (mine) this.best = Math.max(this.best, this.me.kills);
        if (boss) {
          this.setSlowmo(1.1);
          this.flash = 0.2;
          this.sfx.gong();
          this.hud.banner('討', 'Akaoni has fallen!', `+${ev.honor} honor`, '#b8321f', 2400);
        }
        break;
      }
      case 'doom':
        fx.sparks(ev.x, ev.y, 4, C.red, 200);
        break;
      case 'parry':
        if (hear(ev.x)) this.sfx.parry();
        fx.sparks(ev.x, ev.y, 18, C.red, 520);
        fx.sparks(ev.x, ev.y, 10, C.ink, 400);
        fx.ring(ev.x, ev.y, 6, 46, 0.3, C.ink, 4);
        this.popKanji('弾', ev.x, ev.y - 34, '#b8321f', 46);
        this.parryTick.set(ev.pid, tick);
        if (mine) {
          this.addShake(6);
          this.flash = 0.06;
          this.setSlowmo(0.12);
        }
        break;
      case 'deflect':
        if (hearHit(ev.x)) this.sfx.deflect();
        fx.sparks(ev.x, ev.y, 8, C.red, 380);
        break;
      case 'block':
        if (hearHit(ev.x)) this.sfx.block();
        fx.sparks(ev.x, ev.y, 10, C.ink, 360);
        fx.ring(ev.x, ev.y, 4, 22, 0.18, C.ink, 2.5);
        shake();
        break;
      case 'guardBreak':
        if (hearHit(ev.x)) this.sfx.guardBreak();
        fx.sparks(ev.x, ev.y, 16, C.red, 480);
        fx.inkBurst(ev.x, ev.y, 1, 8, 260, C.wood);
        this.popKanji('破', ev.x, ev.y - 30, '#b8321f', 44);
        shake();
        break;
      case 'playerHit':
        if (mine) this.sfx.hurt();
        fx.inkBurst(ev.x, ev.y, ev.dir, 14, 320, C.red);
        this.hurtFlash.set(ev.pid, 0.12);
        if (mine) this.addShake(10);
        break;
      case 'playerDeath':
        if (mine) {
          this.sfx.death();
          this.lastLost = ev.lost;
        }
        fx.inkBurst(ev.x, ev.y - 24, 1, 20, 400, C.red);
        fx.inkBurst(ev.x, ev.y - 24, -1, 20, 400, C.ink);
        if (mine) {
          this.setSlowmo(0.6);
          this.addShake(14);
        }
        break;
      case 'respawn':
        fx.mist(ev.x, ev.y - 20, 14, { color: C.ink, size: 10, alpha: 0.25, spread: 30, vy: -30, life: 0.8, front: true });
        fx.ring(ev.x, ev.y - 24, 10, 60, 0.5, C.ink, 4);
        if (hear(ev.x)) this.sfx.spawn();
        break;
      case 'jump':
        if (hear(ev.x)) this.sfx.jump(ev.double);
        if (ev.double) fx.ring(ev.x, ev.y - 4, 4, 28, 0.3, C.wash, 2.5);
        else fx.dust(ev.x, ev.y, 0, 5);
        break;
      case 'wallJump':
        if (hear(ev.x)) this.sfx.jump(false);
        fx.dust(ev.x, ev.y, ev.dir, 6);
        break;
      case 'land':
        if (ev.impact > 450) {
          fx.dust(ev.x, ev.y, 1, 4);
          fx.dust(ev.x, ev.y, -1, 4);
          if (hear(ev.x)) this.sfx.land(ev.impact > 850);
          if (ev.impact > 850 && mine) this.addShake(4);
        }
        break;
      case 'dash':
        if (hear(ev.x)) this.sfx.dash();
        fx.mist(ev.x - ev.dir * 10, ev.y - 24, 6, { color: C.wash, size: 8, alpha: 0.25, vx: -ev.dir * 80 });
        break;
      case 'slide':
        if (hear(ev.x)) this.sfx.dash();
        fx.dust(ev.x, ev.y, -ev.dir, 8);
        break;
      case 'iaiStart':
        if (mine) this.sfx.iaiCharge();
        break;
      case 'iaiReady':
        if (hear(ev.x)) this.sfx.iaiReady();
        fx.ring(ev.x, ev.y, 34, 4, 0.25, C.red, 2.5);
        break;
      case 'iai': {
        if (hear(ev.x0) || this.near(ev.x1)) this.sfx.iai(ev.full);
        const y = ev.y - 26;
        const dir = Math.sign(ev.x1 - ev.x0) || (this.player(ev.pid) ?? this.me).facing;
        const xa = ev.x0 - dir * 20;
        const xb = ev.x1 + dir * 40;
        const pts: Pt[] = [];
        for (let i = 0; i <= 12; i++) pts.push({ x: lerp(xa, xb, i / 12), y: y + (Math.random() - 0.5) * 2 });
        fx.line(pts, ev.full ? 10 : 6.5, C.ink, 0.95, 0.55, true);
        fx.line(pts.map((q) => ({ x: q.x, y: q.y + 1 })), 2, C.red, 0.9, 0.65, true);
        const ghostPose = this.lastPlayerPose.get(ev.pid);
        if (ghostPose) {
          for (let i = 0; i < 5; i++) fx.ghost(ghostPose, lerp(ev.x0, ev.x1, i / 5), ev.y, dir, 0, 0.3 + i * 0.04, C.wash, 0.45);
        }
        fx.dust(ev.x0, ev.y, -dir, 10);
        if (mine) {
          this.addShake(ev.full ? 14 : 9);
          this.flash = ev.full ? 0.12 : 0.07;
          this.zoomPunch = ev.full ? 0.08 : 0.05;
        }
        if (ev.count > 0) {
          if (mine) this.setSlowmo(ev.full ? 0.45 : 0.3);
          this.popKanji('斬', ev.x1 + dir * 34, y - 44, '#15120e', ev.full ? 96 : 72);
        }
        break;
      }
      case 'plungeLand':
        if (hear(ev.x)) this.sfx.land(true);
        fx.ring(ev.x, ev.y - 2, 6, 62, 0.35, C.ink, 4);
        fx.dust(ev.x, ev.y, 1, 8);
        fx.dust(ev.x, ev.y, -1, 8);
        if (mine) this.addShake(8);
        break;
      case 'windSlash':
        this.sfx.swing(true);
        fx.mist(ev.x, ev.y, 4, { color: C.wash, size: 6, alpha: 0.3, vx: ev.dir * 200 });
        break;
      case 'orb': {
        const p = this.player(ev.pid) ?? this.me;
        if (mine) {
          this.orbStreak++;
          this.orbStreakT = 0.6;
          this.sfx.orb(this.orbStreak, ev.lost);
        }
        if (ev.value >= 5 || ev.lost) fx.sparks(p.x, p.y - 26, 2, ev.lost ? C.red : C.ink, 160);
        break;
      }
      case 'levelUp': {
        const p = this.player(ev.pid) ?? this.me;
        if (mine) this.sfx.levelUp();
        fx.ring(p.x, p.y - 24, 10, 70, 0.5, C.red, 3);
        this.popKanji('昇', p.x, p.y - 70, '#b8321f', 40);
        break;
      }
      case 'pick': {
        const p = this.player(ev.pid) ?? this.me;
        const t = UPGRADE_TEXT[ev.upgrade];
        if (mine) this.sfx.pick();
        this.popKanji(t.kanji, p.x, p.y - 72, '#15120e', 48);
        fx.ring(p.x, p.y - 24, 40, 6, 0.3, C.ink, 3);
        break;
      }
      case 'checkpoint':
        if (this.world.mode === 'coop' && !mine) {
          // Sanctuaire commun atteint par un coéquipier : annoncé à toute la salle, son et lueur de près seulement.
          const who = this.player(ev.pid)?.name || 'a ronin';
          this.hud.banner('社', `Shrine — reached by ${who}`, 'shared rebirth point', '#15120e', 900);
          if (this.near(ev.x)) {
            fx.ring(ev.x, ev.y - 40, 6, 50, 0.6, C.red, 3);
            this.softBell();
          }
          break;
        }
        fx.ring(ev.x, ev.y - 40, 6, 50, 0.6, C.red, 3);
        if (!mine) break;
        this.sfx.bell();
        this.hud.banner('社', 'Shrine', 'rebirth point · life restored', '#15120e', 1100);
        break;
      case 'despawn':
        fx.mist(ev.x, ev.y, 8, { color: C.ink, size: 8, alpha: 0.25, spread: 20, vy: -30, life: 0.8 });
        break;
      case 'spawn':
        fx.mist(ev.x, ev.y - 22, 10, { color: C.ink, size: 9, alpha: 0.22, spread: 24, vy: -20, life: 0.9 });
        break;
      case 'windup':
        if (this.near(ev.x)) this.sfx.tick();
        break;
      case 'arrowFire':
        if (this.near(ev.x)) this.sfx.bow();
        break;
      case 'throw':
        if (this.near(ev.x)) this.sfx.shuriken();
        break;
      case 'arrowBreak':
        fx.sparks(ev.x, ev.y, 4, C.wood, 200);
        break;
      case 'alert':
        this.popKanji('!', ev.x, ev.y - 16, '#b8321f', 26);
        break;
      case 'vanish':
      case 'appear':
        fx.mist(ev.x, ev.y, 9, { color: C.inkSoft, size: 9, alpha: 0.35, spread: 22, vy: -25, life: 0.6, front: true });
        if (this.near(ev.x)) this.sfx.smoke();
        break;
      case 'slam': {
        const big = ev.w > 100;
        this.sfx.slam(big);
        fx.dust(ev.x, ev.y, 1, big ? 14 : 6);
        fx.dust(ev.x, ev.y, -1, big ? 14 : 6);
        if (big) {
          fx.ring(ev.x, ev.y - 4, 10, ev.w, 0.35, C.ink, 5);
          for (const d of [-1, 1]) fx.line([{ x: ev.x, y: ev.y - 2 }, { x: ev.x + d * ev.w * 0.5, y: ev.y - 3 }, { x: ev.x + d * ev.w, y: ev.y - 2 }], 5, C.ink, 0.8, 0.4, true);
        }
        shake();
        break;
      }
      case 'charge':
        this.sfx.roar();
        fx.dust(ev.x, ev.y, -ev.dir, 12);
        break;
      case 'horn':
        this.sfx.horn();
        fx.ring(ev.x, ev.y, 10, 90, 0.8, C.redDeep, 4);
        break;
      case 'roar':
        this.sfx.roar();
        fx.ring(ev.x, ev.y + 20, 20, 140, 0.6, C.red, 5);
        this.addShake(10);
        break;
      case 'bossPhase':
        this.flash = 0.15;
        this.hud.banner('怒', 'Akaoni is enraged', 'faster · devastating charge', '#8e2416', 1400);
        break;
      case 'bossSpawn':
        if (this.world.mode === 'coop') {
          // Coop : la bannière du kekkai (arenaLock, même tick) reste lisible ; le gardien est présenté
          // ensuite, et seulement à ceux qui sont dans l'arène.
          this.time.delayedCall(1400, () => {
            if (this.screen !== 'play' || this.world.mode !== 'coop' || this.world.stage.state !== 'arena') return;
            if (arenaInside(this.world.level, this.me.x)) this.hud.banner('赤鬼', 'Akaoni, demon general', 'sweep: crouch · leap: jump · charge: dash', '#8e2416', 2600);
          });
        } else this.hud.banner('赤鬼', 'Akaoni, demon general', 'sweep: crouch · leap: jump · charge: dash', '#8e2416', 2600);
        fx.mist(ev.x, ev.y - 50, 26, { color: C.ink, size: 16, alpha: 0.3, spread: 70, vy: -30, life: 1.2, front: true });
        break;
      case 'tideWarn':
        this.sfx.taiko(false);
        this.hud.banner('潮', `The Tide rises — wave ${ev.n}`, 'hold fast', '#8e2416', 1800);
        break;
      case 'arenaLock':
        this.sfx.taiko(true);
        if (this.world.mode === 'coop') {
          // Coop : la salle entière est prévenue ; dedans ou dehors, le message diffère.
          if (arenaInside(this.world.level, this.me.x)) this.hud.banner('結界', 'The kekkai is sealed', 'none may leave — the guardian awaits', '#8e2416', 1300);
          else this.hud.banner('結界', 'The kekkai is sealed — enter, none may leave', 'follow 結界 ▶ to join the fight', '#8e2416', 2000);
          if (!this.near(ev.x)) break;
        }
        fx.mist(ev.x, this.me.y - 60, 20, { color: C.redDeep, size: 12, alpha: 0.3, spread: 40, vy: -20, life: 1, front: true });
        this.addShake(8);
        break;
      case 'arenaReset':
        break;
      case 'gateOpen': {
        this.sfx.bell();
        this.sfx.gong();
        for (let k = 0; k < 3; k++) {
          const sx = ev.x - 31 + (0.25 + k * 0.25) * 62;
          fx.sparks(sx, ev.y - 74, 10, C.red, 260);
          fx.mist(sx, ev.y - 74, 5, { color: C.redDeep, size: 6, alpha: 0.35, vy: -50, life: 0.9, front: true });
        }
        this.hud.banner('開', 'The gate is open', 'pass through the torii to end the stage', '#b8321f', 2000);
        break;
      }
      case 'stageClear':
        this.sfx.bell();
        this.flash = 0.25;
        fx.ring(this.world.level.gate.x, this.world.level.gate.y - 50, 10, 120, 0.8, C.red, 4);
        // Coop : récapitulatif de la salle (note et statistiques de chacun, vote pour repartir).
        this.results.show(this.world.stage, this.me, { stage: this.world.level.stage, biome: this.world.level.biome }, this.world.mode === 'coop' ? buildRoster(this.world, this.src.meId) : undefined);
        this.rosterShown = this.world.stage.byPlayer !== undefined;
        // Le fond du biome suivant est généré pendant le bilan, pas au moment du changement d'étape.
        this.backdrop.prewarm(biomeForStage(this.world.level.stage + 1));
        break;
      case 'gameOver':
        if (this.src !== this.local) break; // pas de fin de partie en coopération
        this.onGameOver({ score: ev.score, loop: ev.loop, kills: ev.kills });
        break;
      case 'stageStart':
        this.results.hide();
        this.wipe = 1.3;
        this.applyLevel();
        this.camX = this.me.x + 60;
        this.camY = this.me.y - 60;
        this.worldCam.centerOn(this.camX, this.camY);
        this.prev.clear();
        this.phase.clear();
        this.lastPose.clear();
        this.scarf.clear();
        this.lastLost = 0;
        this.sfx.taiko(false);
        {
          const L = this.world.level;
          const b = BIOMES[L.biome];
          this.hud.banner(b.kanji, stageTitle(L.stage, L.biome), `${b.subtitle} — the enemies grow fiercer`, '#15120e', 2400);
        }
        break;
      case 'tideStart':
        this.sfx.drum(0, true);
        break;
      case 'duelInvite':
      case 'duelCancel':
      case 'duelStart':
      case 'duelRound':
      case 'duelEnd':
        this.duel.onEvent(ev, this.src.meId);
        break;
      case 'tideEnd':
        this.sfx.gong();
        if (ev.bonus > 0) this.hud.banner('凪', 'The Tide recedes', `+${ev.bonus} honor`, '#15120e', 1600);
        break;
    }
  }
}
