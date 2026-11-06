import type { NarrationTone } from '../../shared/protocol';
import type { ActionTone } from './actionCallout';
import { svgEl } from './dom';

const TONE_ICON_PATHS: Record<NarrationTone, string[]> = {
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5.5', 'M12 7.6v.2'],
  action: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  street: ['M7 5h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M17.5 8.5l2.4.8a1.5 1.5 0 0 1 .9 1.9l-2.7 8.3'],
  win: ['M8 4h8v5a4 4 0 0 1-8 0z', 'M8 6H5v1a3 3 0 0 0 3 3', 'M16 6h3v1a3 3 0 0 1-3 3', 'M12 13v4', 'M8 20h8', 'M9.5 17h5'],
  warn: ['M12 3.5l9.5 16.5h-19z', 'M12 10v4.5', 'M12 17.2v.2'],
  alert: ['M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 2.5 1.5 2C10.5 8 11 5.5 12 3z'],
};

const ACTION_ICON_PATHS: Record<ActionTone, string[]> = {
  fold: ['M12 5v14', 'M6 13l6 6 6-6'],
  check: ['M5 13l4 4L19 7'],
  call: ['M4 12h12', 'M12 7l5 5-5 5'],
  bet: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  raise: ['M12 19V6', 'M6 11l6-6 6 6'],
  allin: ['M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 2.5 1.5 2C10.5 8 11 5.5 12 3z'],
  blind: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
};

function createPathIcon(paths: string[], size: number): SVGSVGElement {
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
    class: 'icon',
  });
  for (const pathData of paths) icon.appendChild(svgEl('path', { d: pathData }));
  return icon;
}

export function createToneIcon(tone: NarrationTone, size = 16): SVGSVGElement {
  return createPathIcon(TONE_ICON_PATHS[tone], size);
}

export function createActionIcon(tone: ActionTone, size = 14): SVGSVGElement {
  return createPathIcon(ACTION_ICON_PATHS[tone], size);
}
