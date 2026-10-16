// Contrat minimal entre la source distante et le réseau : aucune dépendance au SDK ici,
// pour que RemoteSource se teste avec un faux transport et que le framework réseau reste remplaçable.
import type { SnapshotWire } from '../../shared/net/codec';
import type { InputMsg, WelcomeMsg } from '../../shared/net/protocol';

export interface Transport {
  /** Message d'accueil du serveur (un seul par connexion ; rejoué s'il est arrivé avant l'abonnement). */
  onWelcome(cb: (msg: WelcomeMsg) => void): void;
  /** Instantanés du monde (~20 Hz), sous forme filaire (décodés par la source). */
  onSnapshot(cb: (msg: SnapshotWire) => void): void;
  /** Connexion perdue ou refermée par le serveur (jamais appelé après un `leave()` volontaire). */
  onClose(cb: (reason: string) => void): void;
  sendInput(msg: InputMsg): void;
  /** Envoie un ping ; la réponse met à jour `rtt`. */
  ping(): void;
  /** Aller-retour lissé en millisecondes (0 tant qu'aucune mesure). */
  readonly rtt: number;
  /** Quitte la salle proprement. */
  leave(): void;
}
