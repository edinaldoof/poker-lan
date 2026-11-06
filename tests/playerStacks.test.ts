import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CHIP_DENOMINATIONS, CHIP_HEIGHT, ChipFactory, type ChipPlacement } from '../src/client/scene/ChipFactory';
import { PLAYER_STACK_MAX_CHIPS, composePlayerStack, playerStackChips } from '../src/client/scene/playerStackLayout';
import { PlayerStacks, type StackPlacement } from '../src/client/scene/PlayerStacks';
import { FELT_Y, SEAT_SLOTS } from '../src/client/scene/SeatLayout';

function emptyInstancedChips(_denomination: number, capacity: number): THREE.InstancedMesh {
  const chips = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), capacity);
  chips.count = 0;
  return chips;
}

function placementAt(x: number, yaw = 0.3): StackPlacement {
  return { position: new THREE.Vector3(x, FELT_Y, 0), yaw };
}

function meshesOf(stacks: PlayerStacks): Map<number, THREE.InstancedMesh> {
  return new Map((stacks.root.children as THREE.InstancedMesh[]).map((mesh, index) => [CHIP_DENOMINATIONS[index], mesh]));
}

function instancePositions(mesh: THREE.InstancedMesh): THREE.Vector3[] {
  const matrix = new THREE.Matrix4();
  return Array.from({ length: mesh.count }, (_, index) => {
    mesh.getMatrixAt(index, matrix);
    return new THREE.Vector3().setFromMatrixPosition(matrix);
  });
}

/** The factory without its assets: unit boxes stand in for the chip models. */
function createBareChipFactory(): ChipFactory {
  type BareConstructor = new (
    high: THREE.BufferGeometry,
    low: THREE.BufferGeometry,
    materials: Map<number, THREE.MeshPhysicalMaterial>,
    normalMap: THREE.Texture,
  ) => ChipFactory;
  const materials = new Map(CHIP_DENOMINATIONS.map((denomination) => [denomination, new THREE.MeshPhysicalMaterial()]));
  return new (ChipFactory as unknown as BareConstructor)(new THREE.BoxGeometry(), new THREE.BoxGeometry(), materials, new THREE.Texture());
}

describe('PlayerStacks', () => {
  it('draws every chip of every stack as one instance of its denomination mesh', () => {
    const stacks = new PlayerStacks({ createInstancedChips: emptyInstancedChips }, SEAT_SLOTS);
    stacks.set(0, 2_000, placementAt(0));
    stacks.set(3, 9_870, placementAt(1));
    stacks.set(7, 1_000_000, placementAt(-1));

    const expected = new Map<number, number>();
    for (const amount of [2_000, 9_870, 1_000_000]) {
      for (const denomination of composePlayerStack(amount).flat()) expected.set(denomination, (expected.get(denomination) ?? 0) + 1);
    }
    for (const [denomination, mesh] of meshesOf(stacks)) {
      expect(mesh.count, `chips of ${denomination}`).toBe(expected.get(denomination) ?? 0);
      expect(mesh.visible).toBe(mesh.count > 0);
    }
  });

  it('stands every stack on the felt, turned by its placement yaw', () => {
    const stacks = new PlayerStacks({ createInstancedChips: emptyInstancedChips }, SEAT_SLOTS);
    const placement = placementAt(0.4, 1.1);
    stacks.set(2, 4_321, placement);

    const positions = [...meshesOf(stacks).values()].flatMap(instancePositions);
    const expected = playerStackChips(4_321, 2).map((chip) =>
      new THREE.Vector3(chip.x, chip.y, chip.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), placement.yaw).add(placement.position),
    );
    // Instance matrices are 32-bit floats.
    expect(Math.min(...positions.map((position) => position.y))).toBeCloseTo(FELT_Y, 6);
    for (const point of expected) {
      expect(Math.min(...positions.map((position) => position.distanceTo(point)))).toBeLessThan(1e-6);
    }
    expect(stacks.heightOf(2)).toBeCloseTo(Math.max(...playerStackChips(4_321, 2).map((chip) => chip.y)) + CHIP_HEIGHT, 9);
  });

  it('hides every instance once the stacks are removed or emptied', () => {
    const stacks = new PlayerStacks({ createInstancedChips: emptyInstancedChips }, SEAT_SLOTS);
    stacks.set(0, 2_000, placementAt(0));
    stacks.set(4, 600, placementAt(1));

    stacks.remove(0);
    stacks.set(4, 0, placementAt(1));

    expect([...meshesOf(stacks).values()].every((mesh) => mesh.count === 0 && !mesh.visible)).toBe(true);
    expect(stacks.amounts().size).toBe(0);
    expect(stacks.chipsOf(4)).toEqual([]);
  });

  it('has room for a full stack at every seat', () => {
    const stacks = new PlayerStacks({ createInstancedChips: emptyInstancedChips }, SEAT_SLOTS);
    for (let seat = 0; seat < SEAT_SLOTS; seat++) stacks.set(seat, 1_000_000, placementAt(seat));

    const largest = meshesOf(stacks).get(CHIP_DENOMINATIONS[0]);
    expect(largest?.count).toBe(SEAT_SLOTS * PLAYER_STACK_MAX_CHIPS);
    expect(largest?.count).toBeLessThanOrEqual(largest?.instanceMatrix.count ?? 0);
  });

  it('hands out a copy of its chips, so a pushed all-in cannot move the stack it came from', () => {
    const stacks = new PlayerStacks({ createInstancedChips: emptyInstancedChips }, SEAT_SLOTS);
    stacks.set(1, 750, placementAt(0));

    const chips = stacks.chipsOf(1);
    chips.length = 0;

    expect(stacks.chipsOf(1)).toEqual(playerStackChips(750, 1));
  });
});

describe('ChipFactory for the player stacks', () => {
  it('stops the players stacks casting shadows on low detail and restores them on high', () => {
    const factory = createBareChipFactory();
    const before = factory.createInstancedChips(100, 8);

    factory.setDetail('low');
    const during = factory.createInstancedChips(25, 8);
    expect(before.castShadow).toBe(false);
    expect(during.castShadow).toBe(false);
    expect(during.receiveShadow).toBe(true);

    factory.setDetail('high');
    expect(before.castShadow).toBe(true);
    expect(during.castShadow).toBe(true);
  });

  it('forgets a disposed instanced mesh', () => {
    const factory = createBareChipFactory();
    const chips = factory.createInstancedChips(100, 8);
    chips.dispose();

    factory.setDetail('low');
    expect(chips.castShadow).toBe(true);
  });

  it('lays out a pushed stack chip for chip and reports its top', () => {
    const factory = createBareChipFactory();
    const chips: ChipPlacement[] = playerStackChips(2_400, 3);
    const stack = factory.createStack(0);

    stack.showChips(2_400, chips);

    expect(stack.amount).toBe(2_400);
    expect(stack.children).toHaveLength(chips.length);
    stack.children.forEach((chip, index) => {
      expect(chip.position.toArray()).toEqual([chips[index].x, chips[index].y, chips[index].z]);
      expect(chip.rotation.y).toBe(chips[index].yaw);
    });
    expect(stack.topY).toBeCloseTo(Math.max(...chips.map((chip) => chip.y)) + CHIP_HEIGHT, 9);
  });
});
