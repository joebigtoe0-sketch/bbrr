import * as THREE from 'three';

/** wall height in tile units (tall enough to occlude the low iso lights) */
export const WALL_H = 1.15;
export const DOOR_H = 1.15;

/**
 * The iso view direction. Yaw 45°, pitch ~34° gives the familiar 2:1-ish
 * dimetric look. The camera sits along +dir from the target and looks back.
 */
export const ISO_DIR = new THREE.Vector3(1, 1.35, 1).normalize();

/** world tile coords (gx east, gy south) -> three world position (y up) */
export function tileToWorld(gx: number, gy: number, y = 0): THREE.Vector3 {
  return new THREE.Vector3(gx, y, gy);
}
