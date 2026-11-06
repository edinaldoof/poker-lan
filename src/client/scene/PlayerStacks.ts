import * as THREE from 'three';
import { CHIP_DENOMINATIONS, CHIP_HEIGHT, type InstancedChipSource } from './ChipFactory';
import { PLAYER_STACK_MAX_CHIPS, playerStackChips, type PlacedChip } from './playerStackLayout';

/** Where a seat's stack stands: a point on the felt and its yaw (local +Z toward the rail, see SeatAnchor.stackYaw). */
export interface StackPlacement {
  position: THREE.Vector3;
  yaw: number;
}

interface SeatStack {
  amount: number;
  placement: StackPlacement;
  chips: PlacedChip[];
  height: number;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * The chips each seated player owns, stacked on the felt in front of them. Every chip of every stack is an instance
 * of one InstancedMesh per denomination, so the whole table costs one draw call per denomination (plus its shadow
 * pass) however many players and chips there are.
 */
export class PlayerStacks {
  readonly root = new THREE.Group();
  private readonly meshes = new Map<number, THREE.InstancedMesh>();
  private readonly stacks = new Map<number, SeatStack>();

  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchRotation = new THREE.Quaternion();
  private readonly unitScale = new THREE.Vector3(1, 1, 1);

  constructor(source: InstancedChipSource, seatCount: number) {
    this.root.name = 'player-stacks';
    const capacity = seatCount * PLAYER_STACK_MAX_CHIPS;
    for (const denomination of CHIP_DENOMINATIONS) {
      const mesh = source.createInstancedChips(denomination, capacity);
      mesh.name = `player-chips-${denomination}`;
      // The instances spread over the whole table and move every hand; culling them would need fresh bounds each time.
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.meshes.set(denomination, mesh);
      this.root.add(mesh);
    }
  }

  /** Shows `amount` chips for the seat at `placement`; zero or less clears the spot. */
  set(seat: number, amount: number, placement: StackPlacement): void {
    if (amount <= 0) {
      this.remove(seat);
      return;
    }
    const existing = this.stacks.get(seat);
    if (existing && existing.amount === amount && samePlacement(existing.placement, placement)) return;
    const chips = playerStackChips(amount, seat);
    this.stacks.set(seat, {
      amount,
      placement: { position: placement.position.clone(), yaw: placement.yaw },
      chips,
      height: chips.reduce((top, chip) => Math.max(top, chip.y + CHIP_HEIGHT), 0),
    });
    this.rewrite();
  }

  remove(seat: number): void {
    if (this.stacks.delete(seat)) this.rewrite();
  }

  clear(): void {
    if (this.stacks.size === 0) return;
    this.stacks.clear();
    this.rewrite();
  }

  /** Chips the seat's stack shows right now (0 when it has none). */
  amountOf(seat: number): number {
    return this.stacks.get(seat)?.amount ?? 0;
  }

  /** The chips the seat's stack shows, in the stack's own frame (see StackPlacement); empty when it has none. */
  chipsOf(seat: number): PlacedChip[] {
    return [...(this.stacks.get(seat)?.chips ?? [])];
  }

  /** Height of the seat's tallest column above the felt (0 when it has none). */
  heightOf(seat: number): number {
    return this.stacks.get(seat)?.height ?? 0;
  }

  /** Seats that currently show a stack, with their amounts. */
  amounts(): Map<number, number> {
    return new Map([...this.stacks].map(([seat, stack]) => [seat, stack.amount]));
  }

  /** Releases the instance buffers; geometry and materials belong to the chip factory. */
  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.stacks.clear();
    this.root.removeFromParent();
  }

  /** Rewrites every instance: at most a few hundred matrices, cheaper than tracking which ones moved. */
  private rewrite(): void {
    for (const mesh of this.meshes.values()) mesh.count = 0;
    for (const stack of this.stacks.values()) {
      for (const chip of stack.chips) this.writeChip(stack.placement, chip);
    }
    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = mesh.count > 0;
    }
  }

  private writeChip(placement: StackPlacement, chip: PlacedChip): void {
    const mesh = this.meshes.get(chip.denomination);
    if (!mesh) return;
    this.scratchPosition.set(chip.x, chip.y, chip.z).applyAxisAngle(Y_AXIS, placement.yaw).add(placement.position);
    this.scratchRotation.setFromAxisAngle(Y_AXIS, placement.yaw + chip.yaw);
    this.scratchMatrix.compose(this.scratchPosition, this.scratchRotation, this.unitScale);
    mesh.setMatrixAt(mesh.count, this.scratchMatrix);
    mesh.count += 1;
  }
}

function samePlacement(first: StackPlacement, second: StackPlacement): boolean {
  return first.yaw === second.yaw && first.position.equals(second.position);
}
