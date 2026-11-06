import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

/** Real-size playing cards would vanish in the dealer's hands next to the table's oversized ones. */
export const HELD_DECK_SIZE = Object.freeze({ width: 0.085, thickness: 0.02, length: 0.12 });
export const HELD_CHIP_RADIUS = 0.021;
export const HELD_CHIP_HEIGHT = 0.0034;
const HELD_CHIP_COUNT = 9;

export interface DealerProps {
  deck: Group;
  chips: Group;
  dispose: () => void;
}

/** The deck and the chip stack the croupier picks up during idle business; both start hidden. */
export function createDealerProps(): DealerProps {
  const edge = new MeshStandardMaterial({ color: '#efe8d6', roughness: 0.7 });
  const back = new MeshStandardMaterial({ color: '#7a1620', roughness: 0.5 });
  const chipRed = new MeshStandardMaterial({ color: '#b3202a', roughness: 0.45, metalness: 0.1 });
  const chipWhite = new MeshStandardMaterial({ color: '#e9e4d8', roughness: 0.45, metalness: 0.1 });

  const deckGeometry = new BoxGeometry(HELD_DECK_SIZE.width, HELD_DECK_SIZE.thickness, HELD_DECK_SIZE.length);
  // Box face order: +x, -x, +y, -y, +z, -z; the broad faces (+y, -y) show the card back.
  const deckMesh = new Mesh(deckGeometry, [edge, edge, back, back, edge, edge]);
  const deck = new Group();
  deck.add(deckMesh);

  const chipGeometry = new CylinderGeometry(HELD_CHIP_RADIUS, HELD_CHIP_RADIUS, HELD_CHIP_HEIGHT, 20);
  const chips = new Group();
  for (let index = 0; index < HELD_CHIP_COUNT; index++) {
    const chip = new Mesh(chipGeometry, index % 3 === 2 ? chipWhite : chipRed);
    chip.position.y = (index - (HELD_CHIP_COUNT - 1) / 2) * (HELD_CHIP_HEIGHT + 0.0004);
    chips.add(chip);
  }

  for (const prop of [deck, chips]) {
    prop.visible = false;
    prop.traverse((object) => {
      if (object instanceof Mesh) {
        object.castShadow = true;
      }
    });
  }

  return {
    deck,
    chips,
    dispose: () => {
      deckGeometry.dispose();
      chipGeometry.dispose();
      for (const material of [edge, back, chipRed, chipWhite]) material.dispose();
    },
  };
}
