import { svgEl } from './dom';

export type ActionIconName = 'fold' | 'check' | 'call' | 'raise' | 'allIn' | 'minus' | 'plus';

type IconShape = { tag: 'path'; d: string } | { tag: 'circle'; cx: number; cy: number; r: number } | { tag: 'rect'; x: number; y: number; width: number; height: number; rx: number };

const ICON_SHAPES: Record<ActionIconName, IconShape[]> = {
  // A card thrown in with a cross on it.
  fold: [
    { tag: 'rect', x: 5.5, y: 3, width: 13, height: 18, rx: 2.5 },
    { tag: 'path', d: 'M9.8 9.3l4.4 4.4' },
    { tag: 'path', d: 'M14.2 9.3l-4.4 4.4' },
  ],
  check: [{ tag: 'path', d: 'M5 12.5l4.6 4.6L19 7.6' }],
  // A chip seen from above: rim, inlay and the four edge stripes.
  call: [
    { tag: 'circle', cx: 12, cy: 12, r: 8.5 },
    { tag: 'circle', cx: 12, cy: 12, r: 3.4 },
    { tag: 'path', d: 'M12 3.5V6' },
    { tag: 'path', d: 'M12 18v2.5' },
    { tag: 'path', d: 'M3.5 12H6' },
    { tag: 'path', d: 'M18 12h2.5' },
  ],
  raise: [
    { tag: 'path', d: 'M12 19.5V5.5' },
    { tag: 'path', d: 'M6 11.2l6-5.7 6 5.7' },
  ],
  allIn: [
    { tag: 'path', d: 'M12.4 2.8c.5 3.2 4.6 5 4.6 9.7a5 5 0 0 1-10 0c0-2 .9-3.4 2.2-4.5.2 1.5.9 2.4 1.9 2.8-.9-2.6-.8-5.2 1.3-8z' },
  ],
  minus: [{ tag: 'path', d: 'M6 12h12' }],
  plus: [
    { tag: 'path', d: 'M6 12h12' },
    { tag: 'path', d: 'M12 6v12' },
  ],
};

function buildShape(shape: IconShape): SVGElement {
  switch (shape.tag) {
    case 'path':
      return svgEl('path', { d: shape.d });
    case 'circle':
      return svgEl('circle', { cx: shape.cx, cy: shape.cy, r: shape.r });
    case 'rect':
      return svgEl('rect', { x: shape.x, y: shape.y, width: shape.width, height: shape.height, rx: shape.rx });
  }
}

/** Stroke icons that take their colour from the button text. */
export function createActionIcon(name: ActionIconName, size = 20): SVGSVGElement {
  const icon = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'action-icon',
  });
  for (const shape of ICON_SHAPES[name]) icon.appendChild(buildShape(shape));
  return icon;
}
