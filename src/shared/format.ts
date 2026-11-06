const chipFormatter = new Intl.NumberFormat('pt-BR');

/** Formats chip counts the Brazilian way, e.g. 2400 -> "2.400". */
export function formatChips(amount: number): string {
  return chipFormatter.format(Math.round(amount));
}
