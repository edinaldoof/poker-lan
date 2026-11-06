import { gsap } from 'gsap';
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HalfFloatType,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  SRGBColorSpace,
  Scene,
  SpotLight,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildRenderLevels, FrameBudgetGovernor, type RenderLevel } from './adaptiveResolution';
import { createCarpetTexture } from './proceduralTextures';
import { DEALER_SPEECH_ANCHOR_RISE, DEALER_STAND_POSITION, FELT_Y, RAIL_Y, getSeatAnchor } from './SeatLayout';

export type Quality = 'high' | 'low';

export interface CameraPose {
  /** Radians around Y; 0 puts the camera on the +Z side, where the viewer sits. */
  azimuth: number;
  /** Radians above the horizon. */
  elevation: number;
  distance: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  /** Fraction of the screen height the image is pushed up, to leave room for the action bar. */
  lift: number;
}

const BACKGROUND_COLOR = '#07080a';
export const VERTICAL_FOV_DEGREES = 38;
const TAN_HALF_FOV = Math.tan(MathUtils.degToRad(VERTICAL_FOV_DEGREES / 2));

const LAMP_POSITION = new Vector3(0, 2.05, 0);
const TABLE_CENTER = new Vector3(0, FELT_Y, 0);

const GAME_ELEVATION = MathUtils.degToRad(66);
const GAME_TARGET = new Vector3(0, FELT_Y, 0.06);
const GAME_FRAME_WIDTH = 3.1;
const GAME_FRAME_DEPTH = 1.95;
const ACTION_BAR_RESERVE = 0.12;
/** Wide landscape docks the action bar bottom-right, so the table only leaves a thin strip for the viewer's plate. */
const DOCKED_ACTION_BAR_RESERVE = 0.045;

const GAME_POSE_BASE: CameraPose = {
  azimuth: 0,
  elevation: GAME_ELEVATION,
  distance: 0,
  targetX: GAME_TARGET.x,
  targetY: GAME_TARGET.y,
  targetZ: GAME_TARGET.z,
  lift: ACTION_BAR_RESERVE / 2,
};

/**
 * Seated eye height, well below the lamp: seen from just under its rim (a few degrees), the diffuser's edge aliased
 * into a jagged white line. From here the shade reads as a clean band of light and the felt still shows between
 * the chair backs.
 */
const LOBBY_ELEVATION = 0.115;
const LOBBY_TARGET_Y = 0.85;
/** The slow rise and fall of the orbit (radians), small enough to stay clear of the lamp's rim. */
const LOBBY_ELEVATION_SWAY = 0.01;
const LOBBY_FRAME_WIDTH = 4.2;
const LOBBY_MIN_DISTANCE = 4.6;
/**
 * The orbit stays inside the card room, clear of the furniture along the walls: narrow screens crop the table in
 * the lobby (the lobby panel covers most of them anyway) instead of backing the camera through a wall.
 */
export const LOBBY_MAX_DISTANCE = 4.75;
const LOBBY_ORBIT_SPEED = 0.06;

/**
 * Fog starts past the table wherever the camera is, so the table always stays crisp. Looking down from the game
 * camera (3.5 to 11 m away depending on the screen shape) the floor sinks softly into the dark just past the rail;
 * from the low lobby orbit the walls are the show, so the fog only starts near the far wall.
 */
const FOG_COLOR = '#0b0807';
const FOG_CLEAR_BEYOND_TABLE = { lookingDown: 1.6, eyeLevel: 6 };
const FOG_FADE_LENGTH = 11.4;
/** Camera elevations (radians, seen from the table centre) between which the fog moves from eye level to looking down. */
const FOG_ELEVATION_RANGE = { eyeLevel: 0.3, lookingDown: 0.9 };

export function fogRangeForCamera(distanceToTable: number, elevation: number): { near: number; far: number } {
  const lookingDown = MathUtils.smoothstep(elevation, FOG_ELEVATION_RANGE.eyeLevel, FOG_ELEVATION_RANGE.lookingDown);
  const clear = MathUtils.lerp(FOG_CLEAR_BEYOND_TABLE.eyeLevel, FOG_CLEAR_BEYOND_TABLE.lookingDown, lookingDown);
  return { near: distanceToTable + clear, far: distanceToTable + clear + FOG_FADE_LENGTH };
}

/** Neutral studio before (or without) the card room: the original look, with a cool moonlit fill and rim. */
const STUDIO_ENVIRONMENT_INTENSITY = 0.35;
const STUDIO_EXPOSURE = 1.05;
const STUDIO_FILL_LIGHT = { sky: '#6b7fb0', ground: '#1a130e', intensity: 0.8 };
const STUDIO_RIM_LIGHT = { color: '#9fb8ff', intensity: 0.85 };
/**
 * In the card room the fill and rim turn neutral: the cool ones tinted the plank floor and the trims blue, and amber
 * ones (the warm bar HDR already brings the amber) turned the felt olive and the cards yellow.
 */
const ROOM_FILL_LIGHT = { sky: '#8c8a86', ground: '#1c140e', intensity: 0.75 };
const ROOM_RIM_LIGHT = { color: '#ffe8d0', intensity: 0.5 };
/**
 * The warm bar HDR (its bare bulbs capped, see roomAssets.ts) is a dim, amber room that adds little green to the
 * felt: the table needs more of it and a brighter exposure to keep the felt vivid and the white of the cards close
 * to the studio look (measured on the game view: card stock p90 ~227 against ~236 before, the raised hand ~207).
 */
const ROOM_ENVIRONMENT_INTENSITY = 1.6;
const ROOM_EXPOSURE = 1.5;

const ZOOM_FOCUS_PULL = 0.45;

const USER_ZOOM_MIN = 0.68;
const USER_ZOOM_MAX = 1;
const USER_ZOOM_WHEEL_SENSITIVITY = 0.0012;
const USER_ZOOM_SECONDS = 0.35;
/** When fully zoomed in, the camera focus slides toward the viewer's seat so their own cards stay centred. */
const USER_ZOOM_FOCUS_SHIFT_Z = 0.2;
const USER_ZOOM_STORAGE_KEY = 'poker-lan.zoom';
/** Above this elevation the camera looks over the lamp, which would hide the table. */
const LAMP_HIDE_ELEVATION = 0.55;
const LAMP_FADE_SECONDS = 0.7;

/** Slightly above the contract's 0.82: lit white card faces reach about 1.0 in HDR and must not glow. */
const BLOOM_THRESHOLD = 1.1;
const CAMERA_FILL_INTENSITY = 0.16;

/** Corners of the area that must stay on screen: the table plus the name plates around it. */
export const GAME_FRAME_CORNERS = [-1, 1].flatMap((sideX) =>
  [-1, 1].map((sideZ) => new Vector3((sideX * GAME_FRAME_WIDTH) / 2, RAIL_Y, (sideZ * GAME_FRAME_DEPTH) / 2)),
);
const GAME_FRAME_SIDE_FILL = 0.98;
// The judge panel covers the top of the screen; top-seat name plates must stay below it.
const GAME_FRAME_TOP_FILL = 0.8;

/** Top of the dealer's head (the model is 1.86 m tall), leaning a little toward the table. */
export const DEALER_HEAD_FRAME_POINT = new Vector3(DEALER_STAND_POSITION.x, 1.9, DEALER_STAND_POSITION.z + 0.08);
/** Where DealerBubble is anchored; the bubble itself reaches further up (--dealer-bubble-rise in styles.css). */
export const DEALER_SPEECH_FRAME_POINT = new Vector3(
  DEALER_HEAD_FRAME_POINT.x,
  DEALER_HEAD_FRAME_POINT.y + DEALER_SPEECH_ANCHOR_RISE,
  DEALER_HEAD_FRAME_POINT.z,
);
/** The dealer's head may rise this far up the screen: the toolbar sits at the left, so there is room above him. */
export const DEALER_TOP_FILL = 0.93;
/** Seats whose plates sit on the far side of the table, closest to the top of the screen. */
export const FAR_PLATE_SLOTS = [3, 4, 5];
export const FAR_PLATE_ANCHORS = FAR_PLATE_SLOTS.map((slot) => getSeatAnchor(slot).plate);
/** Seats on the viewer's side of the table: their plates are the lowest on screen and must clear the action bar. */
export const NEAR_PLATE_SLOTS = [7, 0, 1];
export const NEAR_PLATE_ANCHORS = NEAR_PLATE_SLOTS.map((slot) => getSeatAnchor(slot).plate);
/** Where the action bar is docked at the side and the dealer is kept in frame (matches actionBar.css). */
const WIDE_LANDSCAPE_QUERY = '(min-width: 1000px) and (min-aspect-ratio: 5/4) and (min-height: 521px)';

/** The seats at the two ends of the table: their plates are the widest thing the frame has to hold. */
export const SIDE_PLATE_SLOTS = [2, 6];
export const SIDE_PLATE_ANCHORS = SIDE_PLATE_SLOTS.map((slot) => getSeatAnchor(slot).plate);

/** Near edge of the viewer's floating hand (see TableView.heroCardPose): the action bar must stay below it. */
export const VIEWER_HAND_NEAR_EDGE = new Vector3(0, RAIL_Y + 0.008, getSeatAnchor(0).cards.z + 0.135);

/**
 * Screen space taken by HTML that sits over the canvas, in CSS pixels. The frame is fitted around it, so it
 * has to come from the same stylesheet that lays the HTML out (see --side-plate-half-width in styles.css).
 */
export interface GameFrameInsets {
  viewportWidthPx: number;
  viewportHeightPx: number;
  /** Half the width of a side-seat plate, margin included: its anchor must stay this far from the screen edge. */
  sidePlateHalfWidthPx: number;
  /** Half the height of a name plate: plates are centred on their seat's anchor. */
  plateHalfHeightPx: number;
  /** Strip along the top edge covered by the HUD. */
  topReservePx: number;
  /** Height of the action bar when it grows tall enough to reach the near seats' plates; 0 when it stays below them. */
  bottomReservePx: number;
  /** How far the dealer's speech bubble reaches above its anchor; 0 where it may move beside the head instead. */
  dealerBubbleRisePx: number;
  /** Wide landscape: the action bar is docked at the side and the dealer's head must stay on screen. */
  wideLandscape: boolean;
}

const NO_FRAME_INSETS: GameFrameInsets = {
  viewportWidthPx: 1,
  viewportHeightPx: 1,
  sidePlateHalfWidthPx: 0,
  plateHalfHeightPx: 0,
  topReservePx: 0,
  bottomReservePx: 0,
  dealerBubbleRisePx: 0,
  wideLandscape: false,
};

const fitCamera = new PerspectiveCamera(VERTICAL_FOV_DEGREES, 1, 0.05, 80);
const fitPoint = new Vector3();

/** Range of lifts (the fraction of the screen height the picture is pushed up) that keeps a set of constraints met. */
interface LiftRange {
  min: number;
  max: number;
}

/**
 * What the picture is fitted around, from what must always hold to what is only worth a little table size.
 * Every level keeps the constraints of the levels before it.
 */
const ESSENTIAL_LEVEL = 0;
const NEAR_PLATES_LEVEL = 1;
const SPEECH_BUBBLE_LEVEL = 2;

/** How much farther the camera may back off to keep each optional clearance (1.3 = a table 23% smaller). */
export interface ClearanceLimits {
  /** Near plates above the open action bar: they hold stacks and names, so they are worth a smaller table. */
  nearPlates: number;
  /** The speech bubble under the HUD strip: it lasts 3.5 s, so it is only worth a barely smaller table. */
  speechBubble: number;
}

export const CLEARANCE_LIMITS: ClearanceLimits = { nearPlates: 1.3, speechBubble: 1.08 };

interface FrameMeasure {
  fitsSideways: boolean;
  /**
   * One range per level. Essential: the table, the far plates under the HUD strip, the viewer's hand above the bar
   * and the dealer's head. Then, in turn: the near plates above the bar and the speech bubble under the strip.
   */
  levels: LiftRange[];
}

function measureGameFrame(aspect: number, distance: number, insets: GameFrameInsets): FrameMeasure {
  fitCamera.aspect = aspect;
  fitCamera.updateProjectionMatrix();
  placeCamera(fitCamera, { ...GAME_POSE_BASE, distance }, GAME_TARGET, distance);
  fitCamera.updateMatrixWorld(true);

  let highest = -Infinity;
  let lowest = Infinity;
  let cornersFitSideways = true;
  for (const corner of GAME_FRAME_CORNERS) {
    const ndc = fitPoint.copy(corner).project(fitCamera);
    highest = Math.max(highest, ndc.y);
    lowest = Math.min(lowest, ndc.y);
    cornersFitSideways &&= Math.abs(ndc.x) <= GAME_FRAME_SIDE_FILL;
  }

  // Plates have a fixed pixel size, so on narrow screens they, not the table, decide how far the camera backs off.
  const sideFill = Math.min(GAME_FRAME_SIDE_FILL, 1 - (2 * insets.sidePlateHalfWidthPx) / insets.viewportWidthPx);
  const platesFitSideways = SIDE_PLATE_ANCHORS.every((anchor) => Math.abs(fitPoint.copy(anchor).project(fitCamera).x) <= sideFill);

  // Each bound is the range of lifts that keeps one edge of the frame inside the free band of the screen.
  const reserve = insets.wideLandscape ? DOCKED_ACTION_BAR_RESERVE : ACTION_BAR_RESERVE;
  const topFill = Math.min(GAME_FRAME_TOP_FILL, 1 - (2 * insets.topReservePx) / insets.viewportHeightPx);
  const essential: LiftRange = {
    min: Math.max((-1 + 2 * reserve - lowest) / 2, minLiftAboveActionBar(insets, [VIEWER_HAND_NEAR_EDGE], 0)),
    max: Math.min((topFill - highest) / 2, maxLiftBelowHudStrip(insets, FAR_PLATE_ANCHORS, insets.plateHalfHeightPx)),
  };
  if (insets.wideLandscape) {
    essential.max = Math.min(essential.max, (DEALER_TOP_FILL - projectedY(DEALER_HEAD_FRAME_POINT)) / 2);
  }
  const nearPlates: LiftRange = {
    min: Math.max(essential.min, minLiftAboveActionBar(insets, NEAR_PLATE_ANCHORS, insets.plateHalfHeightPx)),
    max: essential.max,
  };
  const speechBubble: LiftRange = {
    min: nearPlates.min,
    max:
      insets.dealerBubbleRisePx > 0
        ? Math.min(nearPlates.max, maxLiftBelowHudStrip(insets, [DEALER_SPEECH_FRAME_POINT], insets.dealerBubbleRisePx))
        : nearPlates.max,
  };

  return { fitsSideways: cornersFitSideways && platesFitSideways, levels: [essential, nearPlates, speechBubble] };
}

/** NDC y of a world point seen from fitCamera (call after placing it). */
function projectedY(point: Vector3): number {
  return fitPoint.copy(point).project(fitCamera).y;
}

/** Smallest lift that keeps boxes hanging `dropPx` below the anchors above the open action bar. */
function minLiftAboveActionBar(insets: GameFrameInsets, anchors: readonly Vector3[], dropPx: number): number {
  if (insets.bottomReservePx <= 0) {
    return -Infinity;
  }
  const barTopFill = -1 + (2 * insets.bottomReservePx) / insets.viewportHeightPx;
  const lowestEdge = Math.min(...anchors.map(projectedY)) - (2 * dropPx) / insets.viewportHeightPx;
  return (barTopFill - lowestEdge) / 2;
}

/** Largest lift that keeps boxes rising `risePx` above the anchors under the HUD strip; there is no limit without a strip. */
function maxLiftBelowHudStrip(insets: GameFrameInsets, anchors: readonly Vector3[], risePx: number): number {
  if (insets.topReservePx <= 0) {
    return Infinity;
  }
  const stripBottomFill = 1 - (2 * insets.topReservePx) / insets.viewportHeightPx;
  const highestEdge = Math.max(...anchors.map(projectedY)) + (2 * risePx) / insets.viewportHeightPx;
  return (stripBottomFill - highestEdge) / 2;
}

/**
 * A HUD strip along the top, or the dealer's head, makes the free band lopsided, so the picture slides to leave
 * equal margins. Everywhere else the lift is the tuned constant and the clearances can only push the camera back.
 */
function liftWithin(range: LiftRange, insets: GameFrameInsets): number {
  const centersPicture = insets.topReservePx > 0 || insets.wideLandscape;
  return centersPicture ? (range.min + range.max) / 2 : GAME_POSE_BASE.lift;
}

/** Closest camera distance at which the frame meets the constraints of one level. */
function closestDistanceForLevel(aspect: number, insets: GameFrameInsets, level: number): number {
  let tooClose = 1;
  let farEnough = 80;
  for (let step = 0; step < 40; step++) {
    const middle = (tooClose + farEnough) / 2;
    const measure = measureGameFrame(aspect, middle, insets);
    const range = measure.levels[level];
    const lift = liftWithin(range, insets);
    if (measure.fitsSideways && lift >= range.min && lift <= range.max) {
      farEnough = middle;
    } else {
      tooClose = middle;
    }
  }
  return farEnough;
}

/**
 * Closest camera distance that keeps the whole frame on screen clear of the HUD. Solved on the real projection
 * because the near edge of the table looks larger than the far one at this elevation. On a short screen the
 * optional clearances would shrink the table a lot, so each may push the camera back by a limited factor only.
 */
export function computeGamePose(
  aspect: number,
  insets: GameFrameInsets = NO_FRAME_INSETS,
  limits: ClearanceLimits = CLEARANCE_LIMITS,
): CameraPose {
  const essentialDistance = closestDistanceForLevel(aspect, insets, ESSENTIAL_LEVEL);
  const nearPlatesDistance = closestDistanceForLevel(aspect, insets, NEAR_PLATES_LEVEL);
  const nearPlatesLimit = essentialDistance * limits.nearPlates;

  if (nearPlatesDistance > nearPlatesLimit) {
    // Clearing the near plates entirely would shrink the table too much: slide the picture up as far as the far side
    // allows, at the largest distance the limit grants.
    const { levels } = measureGameFrame(aspect, nearPlatesLimit, insets);
    const lift = Math.min(levels[NEAR_PLATES_LEVEL].min, levels[ESSENTIAL_LEVEL].max);
    return { ...GAME_POSE_BASE, distance: nearPlatesLimit, lift };
  }

  const speechBubbleDistance = closestDistanceForLevel(aspect, insets, SPEECH_BUBBLE_LEVEL);
  const clearsSpeechBubble = speechBubbleDistance <= nearPlatesDistance * limits.speechBubble;
  const level = clearsSpeechBubble ? SPEECH_BUBBLE_LEVEL : NEAR_PLATES_LEVEL;
  const distance = clearsSpeechBubble ? speechBubbleDistance : nearPlatesDistance;
  const { levels } = measureGameFrame(aspect, distance, insets);
  return { ...GAME_POSE_BASE, distance, lift: liftWithin(levels[level], insets) };
}

export function computeLobbyPose(aspect: number, azimuth: number): CameraPose {
  const distanceToFitWidth = LOBBY_FRAME_WIDTH / 2 / (TAN_HALF_FOV * aspect);
  return {
    azimuth,
    elevation: LOBBY_ELEVATION,
    distance: MathUtils.clamp(distanceToFitWidth, LOBBY_MIN_DISTANCE, LOBBY_MAX_DISTANCE),
    targetX: 0,
    targetY: LOBBY_TARGET_Y,
    targetZ: 0,
    lift: 0,
  };
}

export function placeCamera(camera: PerspectiveCamera, pose: CameraPose, focus: Vector3, distance: number): void {
  const horizontalReach = Math.cos(pose.elevation) * distance;
  camera.position.set(
    focus.x + Math.sin(pose.azimuth) * horizontalReach,
    focus.y + Math.sin(pose.elevation) * distance,
    focus.z + Math.cos(pose.azimuth) * horizontalReach,
  );
  camera.lookAt(focus);
}

function readCssPixels(style: CSSStyleDeclaration, propertyName: string): number {
  const value = Number.parseFloat(style.getPropertyValue(propertyName));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The action bar reserve only counts where the bar is on screen, and then it also has to clear the home bar. */
export function resolveBottomReserve(actionBarReservePx: number, safeAreaBottomPx: number): number {
  return actionBarReservePx > 0 ? actionBarReservePx + Math.max(0, safeAreaBottomPx) : 0;
}

function isWideLandscape(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(WIDE_LANDSCAPE_QUERY).matches;
}

function createSafeAreaProbe(): HTMLElement {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:absolute;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom, 0px);';
  return probe;
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function readStoredUserZoom(): number {
  try {
    const stored = Number(localStorage.getItem(USER_ZOOM_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? MathUtils.clamp(stored, USER_ZOOM_MIN, USER_ZOOM_MAX) : USER_ZOOM_MAX;
  } catch {
    return USER_ZOOM_MAX;
  }
}

function writeStoredUserZoom(value: number): void {
  try {
    localStorage.setItem(USER_ZOOM_STORAGE_KEY, value.toFixed(3));
  } catch {
    // Blocked storage only means the zoom is not remembered across visits.
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function collectMaterials(object: Object3D): Material[] {
  const materials = new Set<Material>();
  object.traverse((child) => {
    if (child instanceof Mesh) {
      const meshMaterials: Material[] = Array.isArray(child.material) ? child.material : [child.material];
      meshMaterials.forEach((material) => materials.add(material));
    }
  });
  return [...materials];
}

type FrameCallback = (deltaSeconds: number, elapsedSeconds: number) => void;

export class Stage {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly tableRoot = new Group();

  private readonly container: HTMLElement;
  private readonly safeAreaProbe = createSafeAreaProbe();
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly keyLight: SpotLight;
  private readonly cameraFillLight: PointLight;
  private readonly fillLight = new HemisphereLight(STUDIO_FILL_LIGHT.sky, STUDIO_FILL_LIGHT.ground, STUDIO_FILL_LIGHT.intensity);
  private readonly rimLight = new DirectionalLight(STUDIO_RIM_LIGHT.color, STUDIO_RIM_LIGHT.intensity);
  private readonly fog = new Fog(FOG_COLOR, 0, 1);
  /** The neutral studio lighting used until (or unless) the card room brings its own environment. */
  private studioEnvironment: WebGLRenderTarget | null = null;
  private readonly frameCallbacks = new Set<FrameCallback>();
  private readonly resizeObserver: ResizeObserver;

  private width = 1;
  private height = 1;
  private bloomEnabled = true;
  private shadowMapSize = 0;
  private governor = new FrameBudgetGovernor(buildRenderLevels(window.devicePixelRatio || 1, 'high'));

  private running = false;
  private lastFrameTime = 0;
  private elapsed = 0;

  private readonly rig: CameraPose;
  private lobbyMode = true;
  private flight: gsap.core.Tween | null = null;
  private resolveFlight: (() => void) | null = null;

  private readonly zoom = { weight: 0, amount: 0.2, focus: new Vector3() };
  private zoomTimeline: gsap.core.Timeline | null = null;
  private resolveZoom: (() => void) | null = null;

  private readonly shakeState = { amplitude: 0 };
  private shakeTween: gsap.core.Tween | null = null;

  private lamp: Object3D | null = null;
  private lampWanted = true;
  private readonly lampOpacity = { value: 1 };
  private lampTween: gsap.core.Tween | null = null;

  private readonly scratchFocus = new Vector3();
  private readonly scratchFromTable = new Vector3();

  private readonly userZoom = { value: readStoredUserZoom() };
  private userZoomTarget = this.userZoom.value;
  private userZoomTween: gsap.core.Tween | null = null;
  private readonly activeTouches = new Map<number, { x: number; y: number }>();
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;

  constructor(container: HTMLElement) {
    this.container = container;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    this.renderer = this.createRenderer();
    this.labelRenderer = this.createLabelRenderer();
    container.append(this.renderer.domElement, this.labelRenderer.domElement, this.safeAreaProbe);

    this.camera = new PerspectiveCamera(VERTICAL_FOV_DEGREES, 1, 0.05, 80);
    this.rig = computeLobbyPose(1, Math.PI * 0.12);
    this.scene.add(this.camera, this.tableRoot);

    this.configureScene();
    this.keyLight = this.addLights();
    // No distance decay: with 1/d² falloff the viewer's floating hand, much nearer the camera than the felt, was blown out.
    this.cameraFillLight = new PointLight('#ffddb8', CAMERA_FILL_INTENSITY, 0, 0);
    this.cameraFillLight.position.set(0.2, 0.3, 0);
    this.camera.add(this.cameraFillLight);
    this.addRoom();

    const bloomResolution = new Vector2(1, 1);
    this.bloomPass = new UnrealBloomPass(bloomResolution, 0.28, 0.55, BLOOM_THRESHOLD);
    this.composer = this.createComposer();

    this.resizeObserver = new ResizeObserver(() => this.handleContainerResize());
    this.resizeObserver.observe(container);
    this.listenForUserZoom(container);

    this.applyRenderLevel(this.governor.level);
  }

  /** Picks the starting level for the chosen quality; the frame governor then lowers or restores it as the device copes. */
  setQuality(quality: Quality): void {
    this.governor = new FrameBudgetGovernor(buildRenderLevels(window.devicePixelRatio || 1, quality));
    this.applyRenderLevel(this.governor.level);
  }

  private applyRenderLevel(level: RenderLevel): void {
    this.bloomEnabled = level.bloom;
    if (level.shadowMapSize !== this.shadowMapSize) {
      this.shadowMapSize = level.shadowMapSize;
      this.keyLight.shadow.mapSize.set(level.shadowMapSize, level.shadowMapSize);
      // A new size only takes effect once the old shadow map is released.
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    this.renderer.setPixelRatio(level.pixelRatio);
    this.composer.setPixelRatio(level.pixelRatio);
    this.applySize();
  }

  onFrame(callback: FrameCallback): () => void {
    this.frameCallbacks.add(callback);
    return () => {
      this.frameCallbacks.delete(callback);
    };
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastFrameTime = performance.now();
    requestAnimationFrame(this.tick);
  }

  /** Slow cinematic orbit at a low angle with the lamp on. Call playIntro() or resetCamera() to leave it. */
  setLobbyMode(enabled: boolean): void {
    if (enabled === this.lobbyMode) {
      return;
    }
    this.lobbyMode = enabled;
    this.cancelZoom();

    if (enabled) {
      this.setLampVisible(true);
      void this.flyTo(computeLobbyPose(this.camera.aspect, this.rig.azimuth), 1.8, 'power2.inOut');
      return;
    }
    void this.flyTo(this.gamePose(), 1.4, 'power2.inOut', () => this.hideLampWhenCameraIsHigh());
  }

  async playIntro(): Promise<void> {
    this.lobbyMode = false;
    this.cancelZoom();
    const duration = prefersReducedMotion() ? 0.6 : 3;
    await this.flyTo(this.gamePose(), duration, 'power3.inOut', () => this.hideLampWhenCameraIsHigh());
    if (!this.lobbyMode) {
      this.setLampVisible(false);
    }
  }

  /** 1 = the whole table fits; smaller values move the camera closer to the viewer's cards. */
  setUserZoom(value: number): void {
    this.userZoomTarget = MathUtils.clamp(value, USER_ZOOM_MIN, USER_ZOOM_MAX);
    writeStoredUserZoom(this.userZoomTarget);
    this.userZoomTween?.kill();
    this.userZoomTween = gsap.to(this.userZoom, {
      value: this.userZoomTarget,
      duration: USER_ZOOM_SECONDS,
      ease: 'power2.out',
    });
  }

  getUserZoom(): number {
    return this.userZoomTarget;
  }

  /** Switches between the whole-table view and the closest view of the viewer's hand. */
  toggleCloseView(): void {
    const isClose = this.userZoomTarget < (USER_ZOOM_MIN + USER_ZOOM_MAX) / 2;
    this.setUserZoom(isClose ? USER_ZOOM_MAX : USER_ZOOM_MIN);
  }

  shake(intensity = 0.015, duration = 0.45): void {
    if (prefersReducedMotion()) {
      return;
    }
    this.shakeTween?.kill();
    this.shakeState.amplitude = intensity;
    this.shakeTween = gsap.to(this.shakeState, { amplitude: 0, duration, ease: 'power2.out' });
  }

  /** Pushes the camera toward a point and eases back. Resolves when the camera is home again. */
  dramaticZoom(target: Vector3, amount = 0.2, duration = 1.1): Promise<void> {
    if (prefersReducedMotion() || this.lobbyMode) {
      return Promise.resolve();
    }
    this.cancelZoom();
    this.zoom.amount = amount;
    this.zoom.focus.copy(target);

    return new Promise<void>((resolve) => {
      this.resolveZoom = resolve;
      this.zoomTimeline = gsap
        .timeline({ onComplete: () => this.finishZoom() })
        .to(this.zoom, { weight: 1, duration: duration * 0.35, ease: 'power2.out' })
        .to(this.zoom, { weight: 0, duration: duration * 0.45, ease: 'power2.inOut' }, `+=${duration * 0.2}`);
    });
  }

  resetCamera(duration = 0.8): void {
    if (this.lobbyMode) {
      return;
    }
    this.cancelZoom();
    gsap.to(this.zoom, { weight: 0, duration: Math.min(duration, 0.5), ease: 'power2.out' });
    void this.flyTo(this.gamePose(), duration, 'power2.inOut');
  }

  /** CSS pixels relative to the stage container. */
  projectToScreen(point: Vector3): { x: number; y: number } {
    this.camera.updateMatrixWorld();
    const ndc = point.clone().project(this.camera);
    return {
      x: (ndc.x * 0.5 + 0.5) * this.width,
      y: (-ndc.y * 0.5 + 0.5) * this.height,
    };
  }

  setLampVisible(visible: boolean): void {
    this.lampWanted = visible;
    if (this.lamp) {
      this.fadeLamp(this.lamp, visible);
    }
  }

  registerLamp(lamp: Object3D | null): void {
    this.lampTween?.kill();
    this.lamp = lamp;
    if (!lamp) {
      return;
    }
    for (const material of collectMaterials(lamp)) {
      if (!material.transparent) {
        material.transparent = true;
        material.needsUpdate = true;
      }
      material.opacity = this.lampWanted ? 1 : 0;
    }
    this.lampOpacity.value = this.lampWanted ? 1 : 0;
    lamp.visible = this.lampWanted;
  }

  private createRenderer(): WebGLRenderer {
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = STUDIO_EXPOSURE;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.setClearColor(new Color(BACKGROUND_COLOR));
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;';
    return renderer;
  }

  private createLabelRenderer(): CSS2DRenderer {
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    return labelRenderer;
  }

  private configureScene(): void {
    this.scene.background = new Color(BACKGROUND_COLOR);
    this.scene.fog = this.fog;

    const generator = new PMREMGenerator(this.renderer);
    const roomEnvironment = new RoomEnvironment();
    this.studioEnvironment = generator.fromScene(roomEnvironment, 0.04);
    this.scene.environment = this.studioEnvironment.texture;
    this.scene.environmentIntensity = STUDIO_ENVIRONMENT_INTENSITY;
    roomEnvironment.dispose();
    generator.dispose();
  }

  /**
   * Lights the table with the card room's own (already prefiltered) environment instead of the neutral studio,
   * with the exposure that keeps the felt and the cards as bright as before, and warms the fill and rim lights to
   * the room's candle light. The caller keeps the texture.
   */
  setEnvironment(environment: Texture, intensity = ROOM_ENVIRONMENT_INTENSITY, exposure = ROOM_EXPOSURE): void {
    this.studioEnvironment?.dispose();
    this.studioEnvironment = null;
    this.scene.environment = environment;
    this.scene.environmentIntensity = intensity;
    this.renderer.toneMappingExposure = exposure;
    this.fillLight.color.set(ROOM_FILL_LIGHT.sky);
    this.fillLight.groundColor.set(ROOM_FILL_LIGHT.ground);
    this.fillLight.intensity = ROOM_FILL_LIGHT.intensity;
    this.rimLight.color.set(ROOM_RIM_LIGHT.color);
    this.rimLight.intensity = ROOM_RIM_LIGHT.intensity;
  }

  private addLights(): SpotLight {
    const keyLight = new SpotLight('#ffd9a8', 2.5, 0, 1.0, 0.9, 1.2);
    keyLight.position.copy(LAMP_POSITION);
    keyLight.target.position.copy(TABLE_CENTER);
    keyLight.castShadow = true;
    keyLight.shadow.bias = -0.0003;
    keyLight.shadow.normalBias = 0.02;
    keyLight.shadow.camera.near = 0.3;
    keyLight.shadow.camera.far = 4.5;

    this.rimLight.position.set(0.8, 2.2, -2.6);
    this.rimLight.target.position.copy(TABLE_CENTER);

    this.scene.add(keyLight, keyLight.target, this.fillLight, this.rimLight, this.rimLight.target);
    return keyLight;
  }

  private addRoom(): void {
    const carpet = createCarpetTexture(this.renderer.capabilities.getMaxAnisotropy());
    carpet.repeat.set(20, 20);

    const floor = new Mesh(
      new PlaneGeometry(60, 60),
      new MeshStandardMaterial({ map: carpet, roughness: 0.95, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  private createComposer(): EffectComposer {
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    composer.addPass(this.bloomPass);
    composer.addPass(new OutputPass());
    return composer;
  }

  private handleContainerResize(): void {
    this.applySize();
    if (!this.flight && !this.lobbyMode) {
      Object.assign(this.rig, this.gamePose());
    }
  }

  /** The game pose for the current viewport, fitted around the HUD the stylesheet lays over it. */
  private gamePose(): CameraPose {
    const style = getComputedStyle(this.container);
    // The stylesheet only sets this reserve in layouts where the action bar is on screen, over the near seats.
    const actionBarReserve = readCssPixels(style, '--hud-bottom-reserve');
    return computeGamePose(this.camera.aspect, {
      viewportWidthPx: this.width,
      viewportHeightPx: this.height,
      sidePlateHalfWidthPx: readCssPixels(style, '--side-plate-half-width'),
      plateHalfHeightPx: readCssPixels(style, '--plate-half-height'),
      topReservePx: readCssPixels(style, '--hud-top-reserve'),
      bottomReservePx: resolveBottomReserve(actionBarReserve, this.readSafeAreaBottom()),
      dealerBubbleRisePx: readCssPixels(style, '--dealer-bubble-rise'),
      wideLandscape: isWideLandscape(),
    });
  }

  /** env(safe-area-inset-bottom) can only be resolved by the browser, so a probe element carries it as padding. */
  private readSafeAreaBottom(): number {
    return readCssPixels(getComputedStyle(this.safeAreaProbe), 'padding-bottom');
  }

  private applySize(): void {
    this.width = Math.max(1, Math.floor(this.container.clientWidth || window.innerWidth));
    this.height = Math.max(1, Math.floor(this.container.clientHeight || window.innerHeight));

    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height);
    this.labelRenderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  private readonly tick = (now: number): void => {
    if (!this.running) {
      return;
    }
    requestAnimationFrame(this.tick);

    const frameMs = now - this.lastFrameTime;
    const delta = Math.min(frameMs / 1000, 0.1);
    this.lastFrameTime = now;
    this.elapsed += delta;

    this.advanceLobbyOrbit(delta);
    for (const callback of [...this.frameCallbacks]) {
      callback(delta, this.elapsed);
    }
    this.updateCamera();
    this.render(delta);

    const nextLevel = this.governor.recordFrame(frameMs);
    if (nextLevel) {
      this.applyRenderLevel(nextLevel);
    }
  };

  private advanceLobbyOrbit(delta: number): void {
    if (!this.lobbyMode || this.flight) {
      return;
    }
    const azimuth = this.rig.azimuth + LOBBY_ORBIT_SPEED * delta;
    Object.assign(this.rig, computeLobbyPose(this.camera.aspect, azimuth));
    this.rig.elevation = LOBBY_ELEVATION + LOBBY_ELEVATION_SWAY * Math.sin(this.elapsed * 0.2);
  }

  private updateCamera(): void {
    const pose = this.rig;
    const userZoom = this.lobbyMode ? 1 : this.userZoom.value;
    const closeness = (USER_ZOOM_MAX - userZoom) / (USER_ZOOM_MAX - USER_ZOOM_MIN);
    const focus = this.scratchFocus.set(pose.targetX, pose.targetY, pose.targetZ + closeness * USER_ZOOM_FOCUS_SHIFT_Z);
    focus.lerp(this.zoom.focus, this.zoom.weight * ZOOM_FOCUS_PULL);
    const distance = pose.distance * userZoom * (1 - this.zoom.amount * this.zoom.weight);
    placeCamera(this.camera, pose, focus, distance);

    const amplitude = this.shakeState.amplitude;
    if (amplitude > 0.00001) {
      this.camera.position.x += Math.sin(this.elapsed * 47 + 1.3) * amplitude;
      this.camera.position.y += Math.sin(this.elapsed * 53 + 4.1) * amplitude * 0.8;
      this.camera.position.z += Math.sin(this.elapsed * 41 + 2.2) * amplitude;
    }

    if (Math.abs(pose.lift) > 0.0001) {
      this.camera.setViewOffset(this.width, this.height, 0, pose.lift * this.height, this.width, this.height);
    } else {
      this.camera.clearViewOffset();
    }

    const fromTable = this.scratchFromTable.subVectors(this.camera.position, TABLE_CENTER);
    const elevation = Math.atan2(fromTable.y, Math.hypot(fromTable.x, fromTable.z));
    const fogRange = fogRangeForCamera(fromTable.length(), elevation);
    this.fog.near = fogRange.near;
    this.fog.far = fogRange.far;
  }

  private render(delta: number): void {
    if (this.bloomEnabled) {
      this.composer.render(delta);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this.labelRenderer.render(this.scene, this.camera);
  }

  private flyTo(
    pose: CameraPose,
    durationSeconds: number,
    ease: string,
    onUpdate?: () => void,
  ): Promise<void> {
    this.flight?.kill();
    this.resolveFlight?.();

    // Take the short way around when the target azimuth is the same direction modulo a full turn.
    const azimuth = this.rig.azimuth + wrapAngle(pose.azimuth - this.rig.azimuth);

    return new Promise<void>((resolve) => {
      this.resolveFlight = resolve;
      this.flight = gsap.to(this.rig, {
        ...pose,
        azimuth,
        duration: durationSeconds,
        ease,
        onUpdate,
        onComplete: () => {
          this.flight = null;
          this.resolveFlight = null;
          this.rig.azimuth = wrapAngle(this.rig.azimuth);
          if (!this.lobbyMode) {
            Object.assign(this.rig, this.gamePose());
          }
          resolve();
        },
      });
    });
  }

  private listenForUserZoom(container: HTMLElement): void {
    // Pinch gestures need raw touch pointers instead of the browser's page zoom.
    container.style.touchAction = 'none';
    container.addEventListener('wheel', this.handleWheel, { passive: false });
    container.addEventListener('dblclick', () => this.setUserZoom(USER_ZOOM_MAX));
    container.addEventListener('pointerdown', this.handlePointerDown);
    container.addEventListener('pointermove', this.handlePointerMove);
    container.addEventListener('pointerup', this.handlePointerEnd);
    container.addEventListener('pointercancel', this.handlePointerEnd);
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.lobbyMode) {
      return;
    }
    event.preventDefault();
    this.setUserZoom(this.userZoomTarget * Math.exp(event.deltaY * USER_ZOOM_WHEEL_SENSITIVITY));
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') {
      return;
    }
    this.activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.activeTouches.size === 2) {
      this.pinchStartDistance = this.touchSpread();
      this.pinchStartZoom = this.userZoomTarget;
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const touch = this.activeTouches.get(event.pointerId);
    if (!touch) {
      return;
    }
    touch.x = event.clientX;
    touch.y = event.clientY;
    if (this.activeTouches.size === 2 && this.pinchStartDistance > 0 && !this.lobbyMode) {
      this.setUserZoom(this.pinchStartZoom * (this.pinchStartDistance / Math.max(1, this.touchSpread())));
    }
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    this.activeTouches.delete(event.pointerId);
    if (this.activeTouches.size < 2) {
      this.pinchStartDistance = 0;
    }
  };

  private touchSpread(): number {
    const [first, second] = [...this.activeTouches.values()];
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  private cancelZoom(): void {
    this.zoomTimeline?.kill();
    this.zoomTimeline = null;
    this.resolveZoom?.();
    this.resolveZoom = null;
  }

  private finishZoom(): void {
    this.zoom.weight = 0;
    this.zoomTimeline = null;
    this.resolveZoom?.();
    this.resolveZoom = null;
  }

  private hideLampWhenCameraIsHigh(): void {
    if (this.lampWanted && this.rig.elevation > LAMP_HIDE_ELEVATION) {
      this.setLampVisible(false);
    }
  }

  private fadeLamp(lamp: Object3D, visible: boolean): void {
    this.lampTween?.kill();
    const materials = collectMaterials(lamp);
    if (visible) {
      lamp.visible = true;
    }
    this.lampTween = gsap.to(this.lampOpacity, {
      value: visible ? 1 : 0,
      duration: LAMP_FADE_SECONDS,
      ease: 'power1.inOut',
      onUpdate: () => {
        for (const material of materials) {
          material.opacity = this.lampOpacity.value;
        }
      },
      onComplete: () => {
        lamp.visible = visible;
      },
    });
  }
}
