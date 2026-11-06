import {
  Group,
  Vector3,
  type BufferGeometry,
  type Camera,
  type LoadingManager,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { createCarpetTexture } from './proceduralTextures';
import { CandleLights } from './room/candleLights';
import { collectResources, disposeTree } from './room/disposeTree';
import { extendLampToCeiling } from './room/lampDrop';
import type { GrandfatherClock } from './room/grandfatherClock';
import { loadRoomAssets, type RoomAssets } from './room/roomAssets';
import { RoomChairs } from './room/roomChairs';
import { isCeilingVisibleFrom } from './room/roomLayout';
import { buildRoomProps } from './room/roomProps';
import { buildRoomShell } from './room/roomShell';

/** The clock's hands only need a new position once a second. */
const CLOCK_REFRESH_SECONDS = 1;

/**
 * The private card room around the table: panelled walls, coffered ceiling, chandeliers, candle sconces, period
 * furniture and one chair per seat. Add `root` to the scene, hand `environment` to Stage.setEnvironment and call
 * update() every frame.
 */
export class CardRoom {
  readonly root = new Group();
  /** The warm bar HDR, prefiltered for image-based lighting. */
  readonly environment: Texture;

  private readonly assets: RoomAssets;
  private readonly environmentTarget: WebGLRenderTarget;
  private readonly carpetTexture: Texture;
  private readonly ceiling: Group;
  private readonly chairs: RoomChairs;
  private readonly candles = new CandleLights();
  private readonly clock: GrandfatherClock | null;
  private readonly cameraPosition = new Vector3();
  private secondsUntilClockRefresh = 0;
  private lampRods: Mesh<BufferGeometry, MeshStandardMaterial> | null = null;

  private constructor(assets: RoomAssets, maxAnisotropy: number) {
    this.assets = assets;
    this.environmentTarget = assets.environment;
    this.environment = assets.environment.texture;
    this.carpetTexture = createCarpetTexture(maxAnisotropy);
    this.root.name = 'cardRoom';

    const shell = buildRoomShell(assets.surfaces, this.environment, this.carpetTexture);
    this.ceiling = shell.ceiling;

    const props = buildRoomProps(assets.models, this.environment, this.candles);
    this.ceiling.add(...props.chandeliers);
    this.clock = props.clock;
    this.clock?.show(new Date());

    this.chairs = new RoomChairs(assets.models.chair, this.environment);

    this.root.add(shell.walls, this.ceiling, props.furniture, this.chairs.group, this.candles.sconceGlow);
    // Nothing in the room moves except the clock hands, which refresh their own matrices.
    this.root.updateMatrixWorld(true);
    this.root.traverse((object) => {
      object.matrixAutoUpdate = false;
    });
  }

  static async load(manager: LoadingManager, renderer: WebGLRenderer): Promise<CardRoom> {
    const assets = await loadRoomAssets(manager, renderer);
    const room = new CardRoom(assets, renderer.capabilities.getMaxAnisotropy());
    // Uploaded while the loading screen is up, so the first lobby frames do not stall on ~30 texture uploads.
    collectResources(room.root).textures.forEach((texture) => renderer.initTexture(texture));
    return room;
  }

  /**
   * Continues the table lamp's cables up to the ceiling. Call before Stage.registerLamp, so the rods fade with the
   * lamp when the game camera rises above it.
   */
  hangLampFromCeiling(lamp: Object3D): void {
    if (!this.lampRods) {
      this.lampRods = extendLampToCeiling(lamp);
    }
  }

  /** Call every frame (Stage.onFrame) with the stage camera. */
  update(deltaSeconds: number, elapsedSeconds: number, camera: Camera): void {
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.ceiling.visible = isCeilingVisibleFrom(this.cameraPosition.y);
    this.chairs.update(this.cameraPosition);
    this.candles.update(elapsedSeconds);

    this.secondsUntilClockRefresh -= deltaSeconds;
    if (this.secondsUntilClockRefresh <= 0) {
      this.secondsUntilClockRefresh = CLOCK_REFRESH_SECONDS;
      this.clock?.show(new Date());
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.candles.setReducedMotion(reduced);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.lampRods?.removeFromParent();
    this.lampRods?.geometry.dispose();
    this.lampRods?.material.dispose();
    this.chairs.dispose();
    this.candles.dispose();
    disposeTree(this.root);
    Object.values(this.assets.models).forEach((model: Object3D) => disposeTree(model));
    Object.values(this.assets.surfaces).forEach((texture) => texture.dispose());
    this.carpetTexture.dispose();
    this.environmentTarget.dispose();
  }
}
