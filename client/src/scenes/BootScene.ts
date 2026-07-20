import Phaser from 'phaser';
import { generateTextures } from '../render/textures.js';

/**
 * Real (transparent) generated art loaded into engine texture keys. Anything
 * NOT loaded here falls back to the procedural placeholder in generateTextures.
 * Characters + monster stay procedural until proper directional sheets exist.
 */
const PROP_TEXTURES: [string, string][] = [
  ['crt', '/sprites/generated/crt.png'],
  ['printer', '/sprites/generated/printer.png'],
  ['crate', '/sprites/generated/cans.png'],
  ['sign', '/sprites/generated/sign_exit.png'],
  ['corpse', '/sprites/generated/corpse.png'],
  ['rubble', '/sprites/generated/rubble.png'],
  ['lightOn', '/sprites/generated/light_on.png'],
  ['lightOff', '/sprites/generated/light_off.png'],
];

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }
  preload() {
    for (const [key, url] of PROP_TEXTURES) this.load.image(key, url);
  }
  create() {
    generateTextures(this); // fills only the keys the load above didn't provide
    this.scene.start('world');
  }
}
