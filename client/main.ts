import Phaser from 'phaser';
import { GameScene } from './scenes/GameScene';

async function boot(): Promise<void> {
  // On attend les polices calligraphiques (au plus 2 s) pour que les textes Phaser les utilisent.
  try {
    await Promise.race([
      Promise.all([document.fonts.load('64px "Yuji Syuku"', '浪人討連撃斬弾侍死'), document.fonts.load('16px "Shippori Mincho"')]),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch {
    /* hors ligne : polices de repli */
  }

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: 1280,
    height: 720,
    backgroundColor: '#f0e7d3',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    render: { antialias: true },
    disableContextMenu: true,
    banner: false,
    scene: [GameScene],
  });
}

void boot();
