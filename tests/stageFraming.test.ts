import { readFileSync } from 'node:fs';
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getSeatAnchor, SEAT_SLOTS } from '../src/client/scene/SeatLayout';
import {
  CLEARANCE_LIMITS,
  DEALER_HEAD_FRAME_POINT,
  DEALER_SPEECH_FRAME_POINT,
  DEALER_TOP_FILL,
  FAR_PLATE_ANCHORS,
  FAR_PLATE_SLOTS,
  GAME_FRAME_CORNERS,
  NEAR_PLATE_ANCHORS,
  NEAR_PLATE_SLOTS,
  SIDE_PLATE_ANCHORS,
  SIDE_PLATE_SLOTS,
  VERTICAL_FOV_DEGREES,
  VIEWER_HAND_NEAR_EDGE,
  computeGamePose,
  placeCamera,
  resolveBottomReserve,
  type CameraPose,
  type ClearanceLimits,
  type GameFrameInsets,
} from '../src/client/scene/Stage';

const STYLES_CSS = new URL('../src/client/styles.css', import.meta.url);
const HUD_CSS = new URL('../src/client/ui/hud.css', import.meta.url);
const SEAT_PLATES_CSS = new URL('../src/client/ui/seatPlates.css', import.meta.url);

/** The @media queries that carry the framing variables for each layout (they must match the stylesheets). */
const PHONE_PORTRAIT_QUERY = '(max-aspect-ratio: 1/1) and (max-width: 420px)';
const STACKED_HUD_QUERY = '(min-height: 521px) and ((width < 1000px) or (aspect-ratio < 5/4))';
const STACKED_HUD_PHONE_QUERY = '(min-height: 521px) and (max-width: 599px)';
const LANDSCAPE_PHONE_QUERY = '(max-height: 520px)';
const LANDSCAPE_PHONE_PLATES_QUERY = '(max-height: 520px) and (min-aspect-ratio: 1/1)';

const NO_CLEARANCE_LIMITS: ClearanceLimits = { nearPlates: 1, speechBubble: 1 };
const UNLIMITED_CLEARANCE: ClearanceLimits = { nearPlates: Infinity, speechBubble: Infinity };

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads a framing variable, in px, from the :root rule of a stylesheet: the one inside the given @media query, or the
 * base one. The stylesheets are the source of truth for these sizes, so the tests take them from there.
 */
function readFramingVariable(stylesheet: URL, name: string, media?: string): number {
  const css = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rootRule =
    media === undefined
      ? /(?<=^|\})\s*:root\s*\{([^}]*)\}/g
      : new RegExp(`@media ${escapeForRegExp(media)}\\s*\\{\\s*:root\\s*\\{([^}]*)\\}`, 'g');
  for (const [, declarations] of css.matchAll(rootRule)) {
    const declaration = new RegExp(`${escapeForRegExp(name)}\\s*:\\s*([\\d.]+)px`).exec(declarations);
    if (declaration) {
      return Number(declaration[1]);
    }
  }
  throw new Error(`${name} is not declared ${media === undefined ? 'in the base :root rule' : `under @media ${media}`} of ${stylesheet.pathname}`);
}

/** Wide landscape: the base :root values (nothing reserved), the dealer is framed and the action bar is docked at the side. */
function wideInsets(width: number, height: number): GameFrameInsets {
  return {
    viewportWidthPx: width,
    viewportHeightPx: height,
    sidePlateHalfWidthPx: readFramingVariable(STYLES_CSS, '--side-plate-half-width'),
    plateHalfHeightPx: readFramingVariable(STYLES_CSS, '--plate-half-height'),
    topReservePx: readFramingVariable(STYLES_CSS, '--hud-top-reserve'),
    bottomReservePx: readFramingVariable(STYLES_CSS, '--hud-bottom-reserve'),
    dealerBubbleRisePx: readFramingVariable(STYLES_CSS, '--dealer-bubble-rise'),
    wideLandscape: true,
  };
}

/** Phones in portrait: the Judge stacks under the toolbar and the action bar is a bottom sheet. */
function phonePortraitInsets(width: number, height: number): GameFrameInsets {
  return {
    viewportWidthPx: width,
    viewportHeightPx: height,
    sidePlateHalfWidthPx: readFramingVariable(STYLES_CSS, '--side-plate-half-width', PHONE_PORTRAIT_QUERY),
    plateHalfHeightPx: readFramingVariable(STYLES_CSS, '--plate-half-height', PHONE_PORTRAIT_QUERY),
    topReservePx: readFramingVariable(STYLES_CSS, '--hud-top-reserve', STACKED_HUD_QUERY),
    bottomReservePx: readFramingVariable(STYLES_CSS, '--hud-bottom-reserve', STACKED_HUD_PHONE_QUERY),
    dealerBubbleRisePx: readFramingVariable(STYLES_CSS, '--dealer-bubble-rise', STACKED_HUD_QUERY),
    wideLandscape: false,
  };
}

/** Landscape phones: the toolbar and the Judge share one strip and the action bar covers the lower part. */
function landscapePhoneInsets(width: number, height: number): GameFrameInsets {
  return {
    viewportWidthPx: width,
    viewportHeightPx: height,
    sidePlateHalfWidthPx: readFramingVariable(SEAT_PLATES_CSS, '--side-plate-half-width', LANDSCAPE_PHONE_PLATES_QUERY),
    plateHalfHeightPx: readFramingVariable(STYLES_CSS, '--plate-half-height', LANDSCAPE_PHONE_PLATES_QUERY),
    topReservePx: readFramingVariable(HUD_CSS, '--hud-top-reserve', LANDSCAPE_PHONE_QUERY),
    bottomReservePx: readFramingVariable(STYLES_CSS, '--hud-bottom-reserve', LANDSCAPE_PHONE_QUERY),
    dealerBubbleRisePx: readFramingVariable(STYLES_CSS, '--dealer-bubble-rise'),
    wideLandscape: false,
  };
}

function framedCamera(width: number, height: number, pose: CameraPose): PerspectiveCamera {
  const camera = new PerspectiveCamera(VERTICAL_FOV_DEGREES, width / height, 0.05, 80);
  placeCamera(camera, pose, new Vector3(pose.targetX, pose.targetY, pose.targetZ), pose.distance);
  camera.setViewOffset(width, height, 0, pose.lift * height, width, height);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function projectToPixels(camera: PerspectiveCamera, point: Vector3, width: number, height: number): { x: number; y: number } {
  const ndc = point.clone().project(camera);
  return { x: (ndc.x * 0.5 + 0.5) * width, y: (-ndc.y * 0.5 + 0.5) * height };
}

/** Where the HUD-relevant edges of the picture land on screen, in CSS pixels from the top. */
function frameEdges(insets: GameFrameInsets, pose: CameraPose): {
  farPlateTop: number;
  nearPlateBottom: number;
  speechBubbleTop: number;
  handNearEdge: number;
} {
  const { viewportWidthPx: width, viewportHeightPx: height } = insets;
  const camera = framedCamera(width, height, pose);
  const screenY = (point: Vector3): number => projectToPixels(camera, point, width, height).y;
  return {
    farPlateTop: Math.min(...FAR_PLATE_ANCHORS.map(screenY)) - insets.plateHalfHeightPx,
    nearPlateBottom: Math.max(...NEAR_PLATE_ANCHORS.map(screenY)) + insets.plateHalfHeightPx,
    speechBubbleTop: screenY(DEALER_SPEECH_FRAME_POINT) - insets.dealerBubbleRisePx,
    handNearEdge: screenY(VIEWER_HAND_NEAR_EDGE),
  };
}

describe('framing variables read from the stylesheets', () => {
  it('declares every variable Stage reads in the base layout', () => {
    const insets = wideInsets(1366, 768);

    expect(insets.sidePlateHalfWidthPx).toBeGreaterThan(0);
    expect(insets.plateHalfHeightPx).toBeGreaterThan(0);
    expect(insets.topReservePx).toBe(0);
    expect(insets.bottomReservePx).toBe(0);
    expect(insets.dealerBubbleRisePx).toBe(0);
  });

  it('reserves the HUD in the stacked layouts and shrinks plates with the screen', () => {
    const phone = phonePortraitInsets(390, 844);
    const landscape = landscapePhoneInsets(740, 360);

    expect(phone.topReservePx).toBeGreaterThan(0);
    expect(phone.bottomReservePx).toBeGreaterThan(0);
    expect(phone.dealerBubbleRisePx).toBeGreaterThan(0);
    expect(phone.plateHalfHeightPx).toBeGreaterThan(landscape.plateHalfHeightPx);
    expect(landscape.dealerBubbleRisePx).toBe(0);
  });
});

describe('plate slots', () => {
  const plateDepth = (slot: number): number => getSeatAnchor(slot).plate.z;
  const otherSlots = (taken: number[]): number[] => Array.from({ length: SEAT_SLOTS }, (_, slot) => slot).filter((slot) => !taken.includes(slot));

  it('lists the seats whose plates are on the far side, farthest from the viewer', () => {
    expect(FAR_PLATE_SLOTS).toHaveLength(FAR_PLATE_ANCHORS.length);
    for (const slot of FAR_PLATE_SLOTS) {
      for (const other of otherSlots(FAR_PLATE_SLOTS)) {
        expect(plateDepth(slot)).toBeLessThanOrEqual(plateDepth(other) + 1e-9);
      }
    }
  });

  it('lists the seats whose plates are on the viewer side, closest to the viewer', () => {
    expect(NEAR_PLATE_SLOTS).toHaveLength(NEAR_PLATE_ANCHORS.length);
    for (const slot of NEAR_PLATE_SLOTS) {
      for (const other of otherSlots(NEAR_PLATE_SLOTS)) {
        expect(plateDepth(slot)).toBeGreaterThanOrEqual(plateDepth(other) - 1e-9);
      }
    }
  });
});

describe('game camera framing', () => {
  const WIDE_SCREENS: [number, number][] = [
    [1920, 1080],
    [1366, 768],
    [1280, 720],
    [1440, 900],
    [2048, 1152],
  ];

  it.each(WIDE_SCREENS)('ignores the plate width inset on a wide %i x %i screen', (width, height) => {
    const withPlates = computeGamePose(width / height, wideInsets(width, height));
    const withoutPlates = computeGamePose(width / height, { ...wideInsets(width, height), sidePlateHalfWidthPx: 0 });

    expect(withPlates.distance).toBeCloseTo(withoutPlates.distance, 6);
    expect(withPlates.lift).toBeCloseTo(withoutPlates.lift, 6);
  });

  it.each(WIDE_SCREENS)('keeps the dealer head on screen and the table framed on a wide %i x %i screen', (width, height) => {
    const pose = computeGamePose(width / height, wideInsets(width, height));
    const camera = framedCamera(width, height, pose);

    const head = projectToPixels(camera, DEALER_HEAD_FRAME_POINT, width, height);
    const topEdgeOfHeadRoom = ((1 - DEALER_TOP_FILL) / 2) * height;
    expect(head.y).toBeGreaterThanOrEqual(topEdgeOfHeadRoom - 0.5);
    expect(head.x).toBeGreaterThan(0);
    expect(head.x).toBeLessThan(width);

    for (const corner of GAME_FRAME_CORNERS) {
      const onScreen = projectToPixels(camera, corner, width, height);
      expect(onScreen.x).toBeGreaterThanOrEqual(0);
      expect(onScreen.x).toBeLessThanOrEqual(width);
      expect(onScreen.y).toBeGreaterThanOrEqual(0);
      expect(onScreen.y).toBeLessThanOrEqual(height);
    }
  });

  it('keeps the table large while the dealer fits: the head is the limit, not a loose margin', () => {
    const [width, height] = [1366, 768];
    const pose = computeGamePose(width / height, wideInsets(width, height));
    const closer = { ...pose, distance: pose.distance * 0.96 };
    const head = projectToPixels(framedCamera(width, height, pose), DEALER_HEAD_FRAME_POINT, width, height);
    const headWhenCloser = projectToPixels(framedCamera(width, height, closer), DEALER_HEAD_FRAME_POINT, width, height);

    expect(head.y).toBeLessThan(height * 0.2);
    expect(headWhenCloser.y).toBeLessThan(head.y);
  });

  it('docks the action bar: a wide screen gives the table more of its height than a bottom-bar layout would', () => {
    const [width, height] = [1366, 768];
    const docked = computeGamePose(width / height, wideInsets(width, height));
    const bottomBar = computeGamePose(width / height, { ...wideInsets(width, height), wideLandscape: false });
    const lowestCorner = (pose: CameraPose): number =>
      Math.max(...GAME_FRAME_CORNERS.map((corner) => projectToPixels(framedCamera(width, height, pose), corner, width, height).y));

    expect(lowestCorner(docked)).toBeGreaterThan(lowestCorner(bottomBar));
  });
});

describe('portrait phone framing', () => {
  it('backs the camera off until the side plates fit on screen', () => {
    const [width, height] = [360, 640];
    const insets = phonePortraitInsets(width, height);
    const withoutPlates = computeGamePose(width / height);
    const fitted = computeGamePose(width / height, insets);

    expect(SIDE_PLATE_SLOTS).toHaveLength(SIDE_PLATE_ANCHORS.length);
    for (const anchor of SIDE_PLATE_ANCHORS) {
      const unfitted = projectToPixels(framedCamera(width, height, withoutPlates), anchor, width, height);
      const onScreen = projectToPixels(framedCamera(width, height, fitted), anchor, width, height);

      expect(Math.min(unfitted.x, width - unfitted.x)).toBeLessThan(insets.sidePlateHalfWidthPx);
      expect(Math.min(onScreen.x, width - onScreen.x)).toBeGreaterThanOrEqual(insets.sidePlateHalfWidthPx - 0.5);
    }
    expect(fitted.distance).toBeGreaterThan(withoutPlates.distance);
  });

  it('puts the Judge strip above the far plates and the speech bubble, and the open bar below the near plates, on a 390 x 844 phone', () => {
    const insets = phonePortraitInsets(390, 844);
    const edges = frameEdges(insets, computeGamePose(390 / 844, insets));

    expect(edges.farPlateTop).toBeGreaterThanOrEqual(insets.topReservePx - 0.5);
    expect(edges.speechBubbleTop).toBeGreaterThanOrEqual(insets.topReservePx - 0.5);
    expect(edges.nearPlateBottom).toBeLessThanOrEqual(844 - insets.bottomReservePx + 0.5);
    expect(edges.handNearEdge).toBeLessThanOrEqual(844 - insets.bottomReservePx + 0.5);
  });

  it('keeps the near plates above the bar plus the home-bar inset', () => {
    const insets = phonePortraitInsets(390, 844);
    const withHomeBar = { ...insets, bottomReservePx: resolveBottomReserve(insets.bottomReservePx, 34) };
    const edges = frameEdges(withHomeBar, computeGamePose(390 / 844, withHomeBar));

    expect(withHomeBar.bottomReservePx).toBe(insets.bottomReservePx + 34);
    expect(edges.nearPlateBottom).toBeLessThanOrEqual(844 - withHomeBar.bottomReservePx + 0.5);
  });

  it('keeps the near plates above the open bar on a 360 x 740 phone and the table within the allowed shrink', () => {
    const [width, height] = [360, 740];
    const insets = phonePortraitInsets(width, height);
    const pose = computeGamePose(width / height, insets);
    const essential = computeGamePose(width / height, insets, NO_CLEARANCE_LIMITS);
    const edges = frameEdges(insets, pose);

    expect(edges.farPlateTop).toBeGreaterThanOrEqual(insets.topReservePx - 0.5);
    expect(edges.nearPlateBottom).toBeLessThanOrEqual(height - insets.bottomReservePx + 0.5);
    expect(pose.distance).toBeLessThanOrEqual(essential.distance * CLEARANCE_LIMITS.nearPlates * CLEARANCE_LIMITS.speechBubble + 1e-9);
  });

  it('does not buy the speech bubble clearance with more table size than its limit', () => {
    // The slim action bar leaves a 360 x 740 phone enough height to clear the bubble inside the limit, so the limit
    // only binds on shorter phones: 360 x 640 is the common small size where the strict pose needs a much larger table.
    const [width, height] = [360, 640];
    const insets = phonePortraitInsets(width, height);
    const withBubble = computeGamePose(width / height, insets);
    const withoutBubble = computeGamePose(width / height, { ...insets, dealerBubbleRisePx: 0 });
    const strict = computeGamePose(width / height, insets, UNLIMITED_CLEARANCE);

    expect(withBubble.distance).toBeLessThanOrEqual(withoutBubble.distance * CLEARANCE_LIMITS.speechBubble + 1e-9);
    expect(strict.distance).toBeGreaterThan(withBubble.distance);
  });

  it('clears the speech bubble on any phone when its size is not limited', () => {
    for (const [width, height] of [
      [360, 740],
      [375, 667],
      [390, 844],
    ]) {
      const insets = phonePortraitInsets(width, height);
      const edges = frameEdges(insets, computeGamePose(width / height, insets, UNLIMITED_CLEARANCE));

      expect(edges.speechBubbleTop).toBeGreaterThanOrEqual(insets.topReservePx - 0.5);
      expect(edges.nearPlateBottom).toBeLessThanOrEqual(height - insets.bottomReservePx + 0.5);
    }
  });

  it('does not frame the dealer on a portrait phone', () => {
    const [width, height] = [390, 844];
    const insets = phonePortraitInsets(width, height);
    const pose = computeGamePose(width / height, insets);
    const withDealer = computeGamePose(width / height, { ...insets, wideLandscape: true });

    expect(withDealer.distance).toBeGreaterThanOrEqual(pose.distance);
    for (const anchor of [...SIDE_PLATE_ANCHORS, ...FAR_PLATE_ANCHORS]) {
      const onScreen = projectToPixels(framedCamera(width, height, pose), anchor, width, height);
      expect(onScreen.x).toBeGreaterThan(0);
      expect(onScreen.x).toBeLessThan(width);
    }
  });
});

describe('landscape phone framing', () => {
  const [width, height] = [740, 360];

  it('keeps the far-side plate boxes below the HUD strip and the viewer hand above the action bar', () => {
    const insets = landscapePhoneInsets(width, height);
    const edges = frameEdges(insets, computeGamePose(width / height, insets));

    expect(edges.farPlateTop).toBeGreaterThanOrEqual(insets.topReservePx - 0.5);
    expect(edges.handNearEdge).toBeLessThanOrEqual(height - insets.bottomReservePx + 0.5);
  });

  it('lifts the near plates out from under the open bar as far as the table size limit allows', () => {
    const insets = landscapePhoneInsets(width, height);
    const pose = computeGamePose(width / height, insets);
    const essential = computeGamePose(width / height, insets, NO_CLEARANCE_LIMITS);
    const hiddenBehindBar = (poseToCheck: CameraPose): number =>
      frameEdges(insets, poseToCheck).nearPlateBottom - (height - insets.bottomReservePx);

    expect(hiddenBehindBar(pose)).toBeLessThan(hiddenBehindBar(essential));
    expect(hiddenBehindBar(pose)).toBeLessThan(insets.plateHalfHeightPx);
    expect(pose.distance).toBeLessThanOrEqual(essential.distance * CLEARANCE_LIMITS.nearPlates + 1e-9);
  });

  it('clears the near plates completely when the table size is not limited', () => {
    const insets = landscapePhoneInsets(width, height);
    const edges = frameEdges(insets, computeGamePose(width / height, insets, UNLIMITED_CLEARANCE));

    expect(edges.nearPlateBottom).toBeLessThanOrEqual(height - insets.bottomReservePx + 0.5);
    expect(edges.farPlateTop).toBeGreaterThanOrEqual(insets.topReservePx - 0.5);
  });

  it('still fits a very short window by sliding the picture instead of failing', () => {
    const insets = { ...landscapePhoneInsets(1280, 300), sidePlateHalfWidthPx: wideInsets(1280, 300).sidePlateHalfWidthPx };
    const pose = computeGamePose(1280 / 300, insets);

    expect(Number.isFinite(pose.distance)).toBe(true);
    expect(pose.distance).toBeLessThan(40);
  });
});

describe('tablet framing', () => {
  it('keeps the whole picture between the Judge strip and the bar on a 768 x 1024 portrait tablet', () => {
    const [width, height] = [768, 1024];
    const insets: GameFrameInsets = {
      ...phonePortraitInsets(width, height),
      sidePlateHalfWidthPx: readFramingVariable(STYLES_CSS, '--side-plate-half-width', '(max-aspect-ratio: 1/1)'),
      plateHalfHeightPx: readFramingVariable(STYLES_CSS, '--plate-half-height', '(max-aspect-ratio: 1/1)'),
      bottomReservePx: readFramingVariable(STYLES_CSS, '--hud-bottom-reserve', STACKED_HUD_QUERY),
    };
    const edges = frameEdges(insets, computeGamePose(width / height, insets));

    expect(edges.speechBubbleTop).toBeGreaterThanOrEqual(insets.topReservePx - 0.5);
    expect(edges.nearPlateBottom).toBeLessThanOrEqual(height - insets.bottomReservePx + 0.5);
  });
});

describe('seat anchors the frame measures', () => {
  it('keeps the viewer hand in front of the viewer cards', () => {
    expect(VIEWER_HAND_NEAR_EDGE.z).toBeGreaterThan(getSeatAnchor(0).cards.z);
  });
});

describe('bottom reserve for the action bar', () => {
  it('adds the home-bar inset only where the action bar is on screen', () => {
    expect(resolveBottomReserve(140, 34)).toBe(174);
    expect(resolveBottomReserve(0, 34)).toBe(0);
  });

  it('ignores a negative inset', () => {
    expect(resolveBottomReserve(140, -5)).toBe(140);
  });
});
