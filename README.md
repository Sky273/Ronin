# Ronin.io — prototype

Jeu .io à défilement horizontal : un samouraï au katana face à des hordes, dans un Japon peint à l'encre (sumi-e).

```bash
npm install
npm run dev        # http://localhost:5180
npm run test:sim   # tests headless de la simulation
npm run build      # typecheck + build de production
```

## Contrôles
| Action | Clavier | Souris / manette |
|---|---|---|
| Se déplacer | ← → / Q D (A D) | stick, croix |
| Sauter (double saut, saut mural) | Espace | A |
| Se baisser / glissade (↓ en courant) / traverser (↓ + Espace) | ↓ / S | — |
| Katana (combo ×3), ↑ coupe montante, ↓ en l'air plongeon | J | clic gauche / X |
| Dash | Maj | B / RT |
| Parade | K | clic droit / LB-RB |
| Iai (maintenir puis relâcher) | L | clic molette / Y |
| Choisir une amélioration | 1 · 2 · 3 | — |
| Aide · son · musique · hitbox | H · M · N · F1 | — |
| Debug (dev) : Marée suivante · aller à l'arène · +100 Honneur | F2 · F3 · F4 | — |

## Boucle de jeu
- **Honneur (誉)** : chaque ennemi lâche des orbes (bonus de combo). L'Honneur fait monter de niveau ; à chaque niveau, 1 amélioration parmi 3 (touches 1/2/3, sans pause). Rangs : Ronin → Samouraï → Hatamoto → Daimyo → Shogun.
- **Mort** : améliorations et Honneur repartent de zéro, mais la moitié de l'Honneur reste au sol (marqueur 誉 à l'écran). Les lanternes-**sanctuaires** fixent le point de renaissance et soignent.
- **La Marée (潮)** : accalmies et vagues de horde alternent, de plus en plus dures.
- **Fin d'étape** : en entrant dans l'arène finale, un kekkai (結界) se referme et le gardien **Akaoni (赤鬼)** attaque. Le vaincre brise les sceaux du torii ; franchir la porte ouvre le **bilan** (結果 : temps, ennemis, combo, parades, morts, Honneur, note 優/良/可 et bonus). Mourir dans l'arène la réinitialise (renaissance au sanctuaire juste avant).
- **Boucles du voyage (周)** : après le bilan, retour à l'étape 1 en conservant améliorations et Honneur ; ennemis plus résistants, plus agressifs, horde plus dense, élites plus tôt, gardien plus coriace et enragé plus tôt.
- **Ennemis** : ashigaru (lance), archer (vise la poitrine : baissez-vous), oni (bouclier frontal : frappez de dos, coup lourd ou parade), ninja (shurikens bas : sautez ; se téléporte dans le dos), Akaoni (balayage : baissez-vous · bond : sautez l'onde de choc · charge : dash au travers).

## Architecture
- `shared/` — simulation **déterministe** à 60 Hz (physique AABB, machine à états du joueur, IA, combat). Aucune dépendance au rendu : elle tournera telle quelle sur le serveur autoritaire en phase 2.
- `client/` — rendu Phaser entièrement procédural : moteur de pinceau (`render/brush.ts`), squelettes à cinématique inverse et poses-clés (`render/characters.ts`), décors pré-peints (`render/backdrop.ts`, `render/terrain.ts`), effets (`fx/fx.ts`), sons synthétisés (`audio/sfx.ts`), musique procédurale adaptative en gamme In : koto et shamisen Karplus-Strong, shakuhachi, taiko (`audio/music.ts`).
- `tests/` — tests de fumée headless de la simulation.
