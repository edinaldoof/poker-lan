import { describe, expect, it } from 'vitest';
import { streetSteps } from '../src/client/ui/JudgePanel';

const statesOf = (street: Parameters<typeof streetSteps>[0]): string[] => streetSteps(street).map((step) => step.state);

describe('street progress', () => {
  it('lists the five stops in the order they are played', () => {
    expect(streetSteps('preflop').map((step) => step.label)).toEqual(['Pré-flop', 'Flop', 'Turn', 'River', 'Showdown']);
  });

  it('marks the stops already played as done and the rest as ahead', () => {
    expect(statesOf('preflop')).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(statesOf('turn')).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    expect(statesOf('showdown')).toEqual(['done', 'done', 'done', 'done', 'current']);
  });

  it('keeps every stop ahead between hands', () => {
    expect(statesOf('idle')).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
  });
});
