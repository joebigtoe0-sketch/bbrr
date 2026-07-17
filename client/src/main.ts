import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { WorldScene } from './scenes/WorldScene.js';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  backgroundColor: '#0a0a08',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: '100%',
    height: '100%',
  },
  render: { pixelArt: false, antialias: true },
  scene: [BootScene, WorldScene],
});

// debug handle for dev tooling (harmless in production)
(window as unknown as { __game: Phaser.Game }).__game = game;
