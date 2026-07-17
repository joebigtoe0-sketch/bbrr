import Phaser from 'phaser';
import { generateTextures } from '../render/textures.js';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }
  create() {
    generateTextures(this);
    this.scene.start('world');
  }
}
