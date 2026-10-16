// Prédiction du joueur local en ligne : il réagit tout de suite à ses entrées, puis se recale
// sur l'état exact envoyé par le serveur (réconciliation à partir de l'accusé `ack`).
// Version de départ (fondations M2) : aucune prédiction, le joueur affiché est celui du serveur.
import type { Enemy, GameEvent, Player, StageState, WaveState, World } from '../../shared/types';

/** Ce que la prédiction sait du monde, d'après le dernier instantané appliqué. */
export interface PredictionContext {
  level: World['level'];
  stage: StageState;
  wave: WaveState;
  shrine: number;
  /** Tick serveur du dernier instantané. */
  serverTick: number;
}

/** Entrée envoyée, en attente d'accusé de réception. */
export interface PendingInput {
  seq: number;
  b: number;
  /** Tick de vue au moment de l'envoi. */
  v: number;
}

export class Predictor {
  private server: Player | null = null;
  private serverTick = 0;
  /** Entrées envoyées et pas encore acquittées (à rejouer après chaque instantané). */
  readonly pending: PendingInput[] = [];

  constructor(readonly meId: number) {}

  /**
   * Un pas prédit pour l'entrée qui vient d'être envoyée. `enemies` : ennemis tels que le client
   * les affiche au tick de vue `v`. Renvoie les événements prédits du joueur local (effets immédiats).
   */
  step(seq: number, b: number, v: number, _enemies: Enemy[], _ctx: PredictionContext): GameEvent[] {
    this.pending.push({ seq, b, v });
    if (this.pending.length > 120) this.pending.shift();
    return [];
  }

  /**
   * Nouvel instantané : `self` est l'état exact du joueur au tick serveur, après l'entrée `ack`.
   * `enemiesAt(v)` donne les ennemis affichés au tick de vue `v` (pour rejouer les entrées).
   */
  reconcile(self: Player | null, ack: number, ctx: PredictionContext, _enemiesAt: (v: number) => Enemy[]): void {
    this.server = self;
    this.serverTick = ctx.serverTick;
    while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
  }

  /**
   * Joueur local à afficher. `frac` : fraction du pas d'entrée en cours (0..1) ;
   * `dtMs` : durée de l'image (lissage des corrections).
   */
  display(_frac: number, _dtMs: number): Player | null {
    return this.server;
  }

  /** Tick prédit (tick du monde affiché). */
  get tick(): number {
    return this.serverTick;
  }

  reset(): void {
    this.server = null;
    this.serverTick = 0;
    this.pending.length = 0;
  }
}
