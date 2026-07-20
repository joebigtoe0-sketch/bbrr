import Phaser from 'phaser';
import { generateTextures, generateWallTexturesFromWallpaper } from '../render/textures.js';

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
  ['note', '/sprites/generated/note.png'],
  // one fixture image for both states; the dark tint sells "off"
  ['lightOn', '/sprites/generated/light_on.png'],
  ['lightOff', '/sprites/generated/light_on.png'],
  // source material for the sheared wall/door planes
  ['wallpaperStrip', '/sprites/generated/wallpaper_strip.png'],
];

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }
  preload() {
    for (const [key, url] of PROP_TEXTURES) this.load.image(key, url);
  }
  create() {
    generateWallTexturesFromWallpaper(this);
    generateTextures(this); // fills only the keys not already provided above
    this.scene.start('world');
  }
}
