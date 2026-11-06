import { type Card, rankValue, SUITS, suitOf } from '../../shared/cards';
import { formatChips } from '../../shared/format';
import { CATEGORY_NAMES, HandCategory } from '../../shared/handEvaluator';

export type ManualSection = 'como-jogar' | 'ranking' | 'juiz' | 'controles' | 'glossario';

export const MANUAL_SECTION_IDS: readonly ManualSection[] = ['como-jogar', 'ranking', 'juiz', 'controles', 'glossario'];

export function isManualSection(value: unknown): value is ManualSection {
  return typeof value === 'string' && (MANUAL_SECTION_IDS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------------------------------
   Card art (atlas) helpers
   --------------------------------------------------------------------------------------------- */

/** 'back' is the face-down card, drawn from the card back cell of the atlas. */
export type ManualCard = Card | 'back';

export const CARD_ATLAS_URL = '/assets/cards/cards_atlas.webp';
/** The atlas is a 13 x 5 grid of cells, so each CSS cell shows 1/13 of the width and 1/5 of the height. */
export const CARD_ATLAS_BACKGROUND_SIZE = '1300% 500%';

const ATLAS_LAST_COLUMN = 12;
const ATLAS_LAST_ROW = 4;

/** Atlas columns run A, 2, 3 ... 10, J, Q, K; rows run clubs, diamonds, hearts, spades; the back is row 4. */
export function cardAtlasCell(card: ManualCard): { column: number; row: number } {
  if (card === 'back') return { column: 0, row: ATLAS_LAST_ROW };
  const value = rankValue(card);
  const column = value === 14 ? 0 : value - 1;
  const row = SUITS.indexOf(suitOf(card));
  return { column, row };
}

function formatCssPercent(value: number): string {
  return `${Number(value.toFixed(4))}%`;
}

/** CSS `background-position` for a card, for an atlas drawn with CARD_ATLAS_BACKGROUND_SIZE. */
export function cardBackgroundPosition(card: ManualCard): string {
  const { column, row } = cardAtlasCell(card);
  return `${formatCssPercent((column / ATLAS_LAST_COLUMN) * 100)} ${formatCssPercent((row / ATLAS_LAST_ROW) * 100)}`;
}

/* ---------------------------------------------------------------------------------------------
   Text helpers
   --------------------------------------------------------------------------------------------- */

export interface InlineToken {
  kind: 'text' | 'strong' | 'code';
  text: string;
}

/**
 * Splits the tiny inline markup used by the manual copy: **bold** and `code`. The renderer turns the
 * tokens into elements, so no HTML is ever parsed.
 */
export function parseInlineMarkup(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /\*\*(.+?)\*\*|`(.+?)`/g;
  let cursor = 0;
  let match = pattern.exec(source);
  while (match !== null) {
    if (match.index > cursor) tokens.push({ kind: 'text', text: source.slice(cursor, match.index) });
    if (match[1] !== undefined) tokens.push({ kind: 'strong', text: match[1] });
    else tokens.push({ kind: 'code', text: match[2] });
    cursor = pattern.lastIndex;
    match = pattern.exec(source);
  }
  if (cursor < source.length) tokens.push({ kind: 'text', text: source.slice(cursor) });
  return tokens;
}

/** Lowercase, accent-free form used for matching hand names and searching the glossary. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

const NON_BREAKING_SPACE = ' ';

/** "0,0032 %", "43,8 %": Brazilian decimal comma, one decimal from 1 % up. */
export function formatProbability(percent: number): string {
  const digits = percent < 1 ? String(percent) : percent.toFixed(1);
  return `${digits.replace('.', ',')}${NON_BREAKING_SPACE}%`;
}

/* ---------------------------------------------------------------------------------------------
   Hand ranking
   --------------------------------------------------------------------------------------------- */

type FiveCards = readonly [Card, Card, Card, Card, Card];

export interface HandRankingEntry {
  /** 1 = strongest. */
  position: number;
  category: HandCategory;
  name: string;
  /** Example hand, in the order the evaluator reports its best five. */
  cards: FiveCards;
  /** How many of the trailing cards only break ties (they are not part of the combination). */
  kickerCount: number;
  description: string;
  tiebreak: string;
  /** Approximate chance of finishing with this category using 7 cards. */
  probabilityPercent: number;
}

export const HAND_RANKING: readonly HandRankingEntry[] = [
  {
    position: 1,
    category: HandCategory.RoyalFlush,
    name: CATEGORY_NAMES[HandCategory.RoyalFlush],
    cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'],
    kickerCount: 0,
    description: '10, Valete, Dama, Rei e Ás do mesmo naipe. A mão imbatível: só empata se estiver inteira na mesa.',
    tiebreak: 'Não há desempate: o naipe nunca conta.',
    probabilityPercent: 0.0032,
  },
  {
    position: 2,
    category: HandCategory.StraightFlush,
    name: CATEGORY_NAMES[HandCategory.StraightFlush],
    cards: ['9h', '8h', '7h', '6h', '5h'],
    kickerCount: 0,
    description: 'Cinco cartas em sequência e todas do mesmo naipe.',
    tiebreak: 'Vence a sequência com a carta mais alta.',
    probabilityPercent: 0.028,
  },
  {
    position: 3,
    category: HandCategory.FourOfAKind,
    name: CATEGORY_NAMES[HandCategory.FourOfAKind],
    cards: ['Qs', 'Qh', 'Qd', 'Qc', '9s'],
    kickerCount: 1,
    description: 'Quatro cartas do mesmo valor, mais um kicker.',
    tiebreak: 'Vence a quadra mais alta; depois, o kicker.',
    probabilityPercent: 0.17,
  },
  {
    position: 4,
    category: HandCategory.FullHouse,
    name: CATEGORY_NAMES[HandCategory.FullHouse],
    cards: ['Ks', 'Kh', 'Kd', '9c', '9s'],
    kickerCount: 0,
    description: 'Uma trinca junto com um par.',
    tiebreak: 'Vence a trinca mais alta; depois, o par.',
    probabilityPercent: 2.6,
  },
  {
    position: 5,
    category: HandCategory.Flush,
    name: CATEGORY_NAMES[HandCategory.Flush],
    cards: ['Ad', 'Jd', '8d', '5d', '3d'],
    kickerCount: 0,
    description: 'Cinco cartas do mesmo naipe, fora de sequência.',
    tiebreak: 'Vence a carta mais alta; se empatar, a seguinte, e assim por diante.',
    probabilityPercent: 3.0,
  },
  {
    position: 6,
    category: HandCategory.Straight,
    name: CATEGORY_NAMES[HandCategory.Straight],
    cards: ['Td', '9c', '8h', '7s', '6d'],
    kickerCount: 0,
    description: 'Cinco cartas em sequência, de naipes variados.',
    tiebreak: 'Vence a carta mais alta da sequência. A roda (A-2-3-4-5) é a menor de todas.',
    probabilityPercent: 4.6,
  },
  {
    position: 7,
    category: HandCategory.ThreeOfAKind,
    name: CATEGORY_NAMES[HandCategory.ThreeOfAKind],
    cards: ['7s', '7h', '7d', 'Kc', '2s'],
    kickerCount: 2,
    description: 'Três cartas do mesmo valor, mais dois kickers.',
    tiebreak: 'Vence a trinca mais alta; depois, os kickers.',
    probabilityPercent: 4.8,
  },
  {
    position: 8,
    category: HandCategory.TwoPair,
    name: CATEGORY_NAMES[HandCategory.TwoPair],
    cards: ['Js', 'Jd', '4h', '4c', 'As'],
    kickerCount: 1,
    description: 'Dois pares de valores diferentes, mais um kicker.',
    tiebreak: 'Vence o par mais alto; depois o par mais baixo; por fim, o kicker.',
    probabilityPercent: 23.5,
  },
  {
    position: 9,
    category: HandCategory.OnePair,
    name: CATEGORY_NAMES[HandCategory.OnePair],
    cards: ['Qs', 'Qd', '9h', '6c', '3d'],
    kickerCount: 3,
    description: 'Duas cartas do mesmo valor, mais três kickers.',
    tiebreak: 'Vence o par mais alto; depois, os kickers do maior para o menor.',
    probabilityPercent: 43.8,
  },
  {
    position: 10,
    category: HandCategory.HighCard,
    name: CATEGORY_NAMES[HandCategory.HighCard],
    cards: ['Ah', 'Jd', '8c', '5s', '2d'],
    kickerCount: 4,
    description: 'Nenhuma combinação: vale a carta mais alta, e as outras só desempatam.',
    tiebreak: 'Vence a carta mais alta; se empatar, compara-se a segunda, e assim por diante.',
    probabilityPercent: 17.4,
  },
];

const PROBABILITIES = HAND_RANKING.map((entry) => entry.probabilityPercent);
const LOG_MIN_PROBABILITY = Math.log10(Math.min(...PROBABILITIES));
const LOG_MAX_PROBABILITY = Math.log10(Math.max(...PROBABILITIES));
const MIN_BAR_RATIO = 0.04;

/**
 * Width (0..1) of the probability bar. The scale is logarithmic because the rarest hand is about
 * 14 000 times less likely than the commonest: on a linear scale only the last three bars would show.
 */
export function probabilityBarRatio(percent: number): number {
  const position = (Math.log10(percent) - LOG_MIN_PROBABILITY) / (LOG_MAX_PROBABILITY - LOG_MIN_PROBABILITY);
  const clamped = Math.min(1, Math.max(0, position));
  return MIN_BAR_RATIO + (1 - MIN_BAR_RATIO) * clamped;
}

/** The lowest straight, shown in the ranking notes. */
export const WHEEL_EXAMPLE: FiveCards = ['Ad', '2s', '3h', '4c', '5d'];

/**
 * Maps the hand names the server sends (`evaluateHand().name` and `describeStartingHand()`) to a
 * ranking category. Two unpaired hole cards ("Ás e Rei do mesmo naipe") are, for now, a high card.
 * Returns null for anything unrecognised, including empty names.
 */
export function handNameToCategory(handName: string | null | undefined): HandCategory | null {
  if (handName === null || handName === undefined) return null;
  const name = normalizeForSearch(handName);
  if (name === '') return null;

  // Order matters: "straight flush" must be tested before "flush", "dois pares" before "par".
  if (name.startsWith('royal flush')) return HandCategory.RoyalFlush;
  if (name.startsWith('straight flush')) return HandCategory.StraightFlush;
  if (name.startsWith('quadra')) return HandCategory.FourOfAKind;
  if (name.startsWith('full house')) return HandCategory.FullHouse;
  if (name.startsWith('flush')) return HandCategory.Flush;
  if (name.startsWith('sequencia')) return HandCategory.Straight;
  if (name.startsWith('trinca')) return HandCategory.ThreeOfAKind;
  if (name.startsWith('dois pares')) return HandCategory.TwoPair;
  if (name === 'par' || name.startsWith('par de')) return HandCategory.OnePair;
  if (name.startsWith('carta alta')) return HandCategory.HighCard;
  if (/^[a-z]+ e [a-z]+( do mesmo naipe)?$/.test(name)) return HandCategory.HighCard;
  return null;
}

/* ---------------------------------------------------------------------------------------------
   Worked examples shared by the copy and the tests
   --------------------------------------------------------------------------------------------- */

/** Three players all-in with different stacks; the largest stack's excess is never called. */
export const SIDE_POT_EXAMPLE = {
  players: [
    { name: 'Ana', stack: 100 },
    { name: 'Bruno', stack: 300 },
    { name: 'Carla', stack: 500 },
  ],
  mainPot: 300,
  sidePot: 400,
  returned: 200,
} as const;

export const ODD_CHIP_EXAMPLE = { pot: 101, firstShare: 51, secondShare: 50 } as const;

/* ---------------------------------------------------------------------------------------------
   Glossary
   --------------------------------------------------------------------------------------------- */

export interface GlossaryEntry {
  term: string;
  aliases?: readonly string[];
  definition: string;
}

const GLOSSARY_SOURCE: readonly GlossaryEntry[] = [
  {
    term: 'All-in',
    definition: 'Apostar todas as suas fichas. Você segue na mão até o showdown, mas só disputa o que cobriu (veja Side pot).',
  },
  {
    term: 'Bad beat',
    definition: 'Perder uma mão muito forte para outra ainda melhor, em geral por uma carta de sorte no turn ou no river.',
  },
  {
    term: 'Blinds',
    aliases: ['Small blind', 'Big blind', 'SB', 'BB'],
    definition: 'Apostas obrigatórias (small blind e big blind) postadas antes da distribuição das cartas, para haver o que disputar.',
  },
  { term: 'Board', aliases: ['Mesa', 'Cartas comunitárias'], definition: 'As cartas comunitárias viradas no centro da mesa, até cinco.' },
  { term: 'Bluff', aliases: ['Blefe'], definition: 'Apostar com uma mão fraca para fazer adversários melhores desistirem.' },
  {
    term: 'Button / Dealer',
    aliases: ['Botão', 'Dealer', 'Button'],
    definition: 'Marcador da última posição de ação depois do flop. Avança uma posição no sentido horário a cada mão.',
  },
  { term: 'Check-raise', definition: 'Dar check e, quando um adversário aposta, aumentar.' },
  {
    term: 'Draw',
    aliases: ['Projeto'],
    definition: 'Mão ainda incompleta que depende das próximas cartas, como quatro cartas do mesmo naipe à espera da quinta.',
  },
  {
    term: 'Equity',
    definition: 'Sua fatia esperada do pote, dada a chance de vencer a mão. Os bots estimam a equity por simulação.',
  },
  { term: 'Flop', definition: 'As três primeiras cartas comunitárias, viradas juntas depois do pré-flop.' },
  {
    term: 'Heads-up',
    definition: 'Disputa entre apenas dois jogadores. Nela, o Dealer paga o small blind e age primeiro no pré-flop.',
  },
  { term: 'Hole cards', aliases: ['Cartas fechadas'], definition: 'As duas cartas fechadas de cada jogador; só você vê as suas.' },
  {
    term: 'Kicker',
    definition: 'Carta de desempate fora da combinação principal. Par de Reis com Ás de kicker vence Par de Reis com Dama.',
  },
  { term: 'Limp', definition: 'Apenas pagar o big blind no pré-flop, em vez de aumentar.' },
  {
    term: 'Muck',
    definition: 'Descartar a mão sem mostrá-la. As cartas de quem desiste deslizam para o muck, ao lado da mesa.',
  },
  { term: 'Nuts', definition: 'A melhor mão possível diante das cartas que estão na mesa.' },
  {
    term: 'Pot odds',
    definition:
      'Relação entre o que você paga e o tamanho do pote. Com 80 no pote, pagar 20 só compensa se você vencer pelo menos 20 % das vezes (20 ÷ 100, o pote final).',
  },
  { term: 'Pote', aliases: ['Pot'], definition: 'Total de fichas apostadas na mão, que o vencedor leva.' },
  {
    term: 'Rebuy',
    aliases: ['Recomprar'],
    definition: 'Comprar novas fichas depois de ficar sem nada. Aqui, o botão Recomprar devolve o stack inicial da partida.',
  },
  { term: 'River', definition: 'A quinta e última carta comunitária.' },
  { term: 'Showdown', definition: 'A revelação das mãos de quem sobrou depois da última rodada de apostas.' },
  {
    term: 'Side pot',
    aliases: ['Pote lateral'],
    definition: 'Pote paralelo criado quando alguém vai all-in com menos fichas que os outros; essa pessoa só disputa o pote principal.',
  },
  { term: 'Stack', aliases: ['Fichas'], definition: 'A quantidade de fichas de um jogador.' },
  { term: 'Turn', definition: 'A quarta carta comunitária.' },
  { term: 'UTG', aliases: ['Under the gun'], definition: 'O primeiro a agir no pré-flop, logo à esquerda do big blind.' },
];

export const GLOSSARY: readonly GlossaryEntry[] = [...GLOSSARY_SOURCE].sort((a, b) =>
  a.term.localeCompare(b.term, 'pt-BR', { sensitivity: 'base' }),
);

/** Entries whose term, alias or definition contains the query (accent and case insensitive). */
export function filterGlossary(entries: readonly GlossaryEntry[], query: string): GlossaryEntry[] {
  const needle = normalizeForSearch(query);
  if (needle === '') return [...entries];
  return entries.filter((entry) =>
    [entry.term, ...(entry.aliases ?? []), entry.definition].some((text) => normalizeForSearch(text).includes(needle)),
  );
}

/* ---------------------------------------------------------------------------------------------
   Manual structure
   --------------------------------------------------------------------------------------------- */

export type CalloutTone = 'tip' | 'example' | 'warning' | 'note';
export type ActionTone = 'fold' | 'call' | 'raise' | 'allin' | 'neutral';

export interface ManualStep {
  title: string;
  text: string;
  cards?: readonly ManualCard[];
}

export interface ManualDefinition {
  term: string;
  text: string;
  keys?: readonly string[];
  tone?: ActionTone;
}

export interface ManualShortcut {
  keys: readonly string[];
  text: string;
}

export interface ManualFeature {
  glyph: string;
  title: string;
  text: string;
}

export type ManualBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered?: boolean; items: readonly string[] }
  | { kind: 'steps'; items: readonly ManualStep[] }
  | { kind: 'definitions'; items: readonly ManualDefinition[] }
  | { kind: 'callout'; tone: CalloutTone; title: string; text?: string; items?: readonly string[] }
  | { kind: 'table'; caption: string; headers: readonly string[]; rows: readonly (readonly string[])[] }
  | { kind: 'cards'; cards: readonly ManualCard[]; caption: string }
  | { kind: 'shortcuts'; items: readonly ManualShortcut[] }
  | { kind: 'features'; items: readonly ManualFeature[] }
  | { kind: 'ranking' }
  | { kind: 'glossary' };

export interface ManualSectionContent {
  id: ManualSection;
  title: string;
  glyph: string;
  summary: string;
  blocks: readonly ManualBlock[];
}

const [SIDE_POT_SHORT, SIDE_POT_MEDIUM, SIDE_POT_LONG] = SIDE_POT_EXAMPLE.players;
const SIDE_POT_TOTAL = SIDE_POT_EXAMPLE.mainPot + SIDE_POT_EXAMPLE.sidePot;

const HOW_TO_PLAY: ManualSectionContent = {
  id: 'como-jogar',
  title: 'Como jogar',
  glyph: '♠',
  summary: 'Texas Hold’em No-Limit, da primeira carta ao pote.',
  blocks: [
    { kind: 'heading', text: 'Objetivo' },
    {
      kind: 'paragraph',
      text: 'Ganhar fichas. Você consegue de duas formas: ficando com a **melhor mão de cinco cartas** no showdown, ou fazendo todos os adversários desistirem antes disso.',
    },
    {
      kind: 'paragraph',
      text: 'Cada jogador recebe **duas cartas fechadas** (só você vê as suas) e **cinco cartas comunitárias** são viradas no centro da mesa. Sua mão é a melhor combinação de cinco entre essas sete: pode usar as duas suas, apenas uma ou nenhuma (jogar com a mesa).',
    },
    {
      kind: 'callout',
      tone: 'tip',
      title: 'Dica',
      text: 'Em dúvida sobre qual mão é maior? Veja a aba **Ranking de mãos**: durante a partida, ela marca a categoria que você tem agora.',
    },

    { kind: 'heading', text: 'Fluxo de uma mão' },
    {
      kind: 'steps',
      items: [
        {
          title: 'Blinds',
          text: 'Duas apostas obrigatórias são postadas automaticamente: o **small blind** (SB) e o **big blind** (BB, em geral o dobro do SB). Quem não tem fichas suficientes posta o que tem.',
        },
        {
          title: 'Pré-flop',
          text: 'Cada jogador recebe 2 cartas fechadas. A primeira rodada de apostas começa pelo jogador à esquerda do big blind. Se todos apenas pagarem, o big blind ainda pode aumentar.',
          cards: ['back', 'back'],
        },
        {
          title: 'Flop',
          text: 'Três cartas comunitárias são viradas. Nova rodada de apostas, começando pelo primeiro jogador à esquerda do Dealer que ainda está na mão.',
          cards: ['Qs', '9h', '4d'],
        },
        { title: 'Turn', text: 'A quarta carta comunitária e mais uma rodada de apostas.', cards: ['Jc'] },
        { title: 'River', text: 'A quinta e última carta comunitária, com a última rodada de apostas.', cards: ['2s'] },
        {
          title: 'Showdown',
          text: 'Quem continua na mão revela as cartas. O Juiz destaca as 5 cartas vencedoras e paga o pote. Se todos desistirem menos um, ele leva o pote sem mostrar nada.',
        },
      ],
    },
    {
      kind: 'paragraph',
      text: 'Uma rodada de apostas termina quando todos que ainda podem agir já agiram e igualaram a maior aposta. Se todos estiverem all-in (ou só um jogador ainda puder apostar), não há mais apostas: o Juiz revela as mãos e vira as cartas que faltam.',
    },

    { kind: 'heading', text: 'Posições' },
    {
      kind: 'list',
      items: [
        '**Dealer (botão):** marcador branco “DEALER” que avança uma posição no sentido horário a cada mão. Depois do flop, age por último, a melhor posição da mesa.',
        '**Small blind (SB):** o primeiro jogador à esquerda do Dealer. Posta o blind menor. Seu marcador é azul.',
        '**Big blind (BB):** o jogador seguinte. Posta o blind maior, que define a aposta mínima. Seu marcador é dourado.',
      ],
    },
    {
      kind: 'callout',
      tone: 'note',
      title: 'Heads-up (2 jogadores)',
      text: 'O Dealer posta o small blind, age primeiro no pré-flop e por último depois do flop. O outro jogador é o big blind.',
    },

    { kind: 'heading', text: 'Ações' },
    {
      kind: 'definitions',
      items: [
        { term: 'Fold', keys: ['F'], tone: 'fold', text: 'Desiste da mão. O que você já colocou no pote fica lá, e você só volta na próxima mão.' },
        { term: 'Check', keys: ['C'], tone: 'call', text: 'Passa a vez sem apostar. Só é possível quando não há aposta a cobrir.' },
        {
          term: 'Pagar',
          keys: ['C'],
          tone: 'call',
          text: 'Iguala a maior aposta da rodada. Se faltarem fichas, você paga o que tem e fica all-in.',
        },
        { term: 'Apostar', keys: ['R'], tone: 'raise', text: 'Faz a primeira aposta da rodada. O valor mínimo é o big blind.' },
        {
          term: 'Aumentar',
          keys: ['R'],
          tone: 'raise',
          text: 'Eleva a aposta atual. Você escolhe o total para o qual aumenta (“aumentar para 300”), não só o acréscimo.',
        },
        {
          term: 'All-In',
          keys: ['A'],
          tone: 'allin',
          text: 'Coloca todas as suas fichas no pote. Você continua na disputa até o showdown, mesmo sem poder apostar mais.',
        },
      ],
    },

    { kind: 'heading', text: 'Regras do No-Limit' },
    {
      kind: 'list',
      items: [
        '**Aposta mínima:** igual ao big blind.',
        '**Aumento mínimo:** pelo menos do tamanho do último aumento completo da rodada.',
        '**Aposta máxima:** nenhuma. Você pode apostar todas as fichas a qualquer momento, e daí vem o “No-Limit”.',
        '**All-in curto não reabre a ação:** se alguém vai all-in por menos que um aumento completo, quem já havia agido só pode pagar ou desistir. Se vários all-ins curtos somarem um aumento completo, a ação reabre.',
      ],
    },
    {
      kind: 'callout',
      tone: 'example',
      title: 'Exemplo',
      items: [
        'Blinds 10/20: o primeiro aumento mínimo é para **40** (os 20 do big blind + 20).',
        'Bruno aumenta para 60, um aumento de 40. Agora o aumento mínimo é para **100** (60 + 40).',
        'No flop, Ana aposta 100 e Bruno paga. Carla vai all-in com 130: é um aumento de apenas 30, menor que o mínimo de 100. Ana e Bruno, que já agiram, **só podem pagar os 30 restantes ou desistir**.',
      ],
    },

    { kind: 'heading', text: 'Side pots' },
    {
      kind: 'paragraph',
      text: 'Quem vai all-in com menos fichas só pode ganhar de cada adversário o mesmo que colocou. O Juiz separa o excedente em um **side pot** que o all-in curto não disputa, e devolve a aposta que ninguém cobriu.',
    },
    {
      kind: 'table',
      caption: 'Os três jogadores vão all-in',
      headers: ['Jogador', 'Fichas', 'Aposta total'],
      rows: SIDE_POT_EXAMPLE.players.map((player) => [player.name, formatChips(player.stack), `${formatChips(player.stack)} (all-in)`]),
    },
    {
      kind: 'table',
      caption: 'Como o Juiz divide o dinheiro',
      headers: ['Pote', 'Valor', 'Quem disputa'],
      rows: [
        [
          'Principal',
          `${formatChips(SIDE_POT_EXAMPLE.mainPot)} (3 × ${formatChips(SIDE_POT_SHORT.stack)})`,
          `${SIDE_POT_SHORT.name}, ${SIDE_POT_MEDIUM.name} e ${SIDE_POT_LONG.name}`,
        ],
        [
          'Side pot',
          `${formatChips(SIDE_POT_EXAMPLE.sidePot)} (2 × ${formatChips(SIDE_POT_MEDIUM.stack - SIDE_POT_SHORT.stack)})`,
          `${SIDE_POT_MEDIUM.name} e ${SIDE_POT_LONG.name}`,
        ],
        [
          'Devolvido',
          `${formatChips(SIDE_POT_EXAMPLE.returned)} (${formatChips(SIDE_POT_LONG.stack)} − ${formatChips(SIDE_POT_MEDIUM.stack)})`,
          `Volta para ${SIDE_POT_LONG.name}: ninguém cobriu`,
        ],
      ],
    },
    {
      kind: 'callout',
      tone: 'example',
      title: 'Quem leva o quê',
      items: [
        `${SIDE_POT_SHORT.name} tem a melhor mão, ${SIDE_POT_MEDIUM.name} a segunda e ${SIDE_POT_LONG.name} a pior: ${SIDE_POT_SHORT.name} leva o principal (**${formatChips(SIDE_POT_EXAMPLE.mainPot)}**), ${SIDE_POT_MEDIUM.name} leva o side pot (**${formatChips(SIDE_POT_EXAMPLE.sidePot)}**) e ${SIDE_POT_LONG.name} recebe de volta **${formatChips(SIDE_POT_EXAMPLE.returned)}**.`,
        `${SIDE_POT_LONG.name} tem a melhor mão: leva os dois potes (**${formatChips(SIDE_POT_TOTAL)}**) e ainda recupera os ${formatChips(SIDE_POT_EXAMPLE.returned)} que ninguém cobriu.`,
      ],
    },

    { kind: 'heading', text: 'Pote dividido' },
    {
      kind: 'paragraph',
      text: 'Se duas ou mais mãos empatam, o pote é dividido em partes iguais. Os naipes nunca desempatam. Quando sobram fichas que não dividem igual, as **fichas ímpares** vão uma a uma para os vencedores, começando pelo primeiro à esquerda do Dealer.',
    },
    {
      kind: 'callout',
      tone: 'example',
      title: 'Exemplo',
      text: `Pote de ${ODD_CHIP_EXAMPLE.pot} entre dois vencedores: o primeiro à esquerda do Dealer recebe ${ODD_CHIP_EXAMPLE.firstShare} e o outro recebe ${ODD_CHIP_EXAMPLE.secondShare}.`,
    },

    { kind: 'heading', text: 'Sem fichas e saída' },
    {
      kind: 'list',
      items: [
        'Se suas fichas acabarem, o Juiz avisa **Sem fichas — Recomprar**. Entre as mãos, o botão **Recomprar** devolve o stack inicial da partida. Sem recomprar, você acompanha o jogo sem participar das mãos. Os bots recompram sozinhos.',
        '**Sair da mesa** (na engrenagem de configurações) desiste da mão atual, se você estiver nela, e libera o seu assento quando a mão termina.',
      ],
    },
  ],
};

const HAND_RANKING_SECTION: ManualSectionContent = {
  id: 'ranking',
  title: 'Ranking de mãos',
  glyph: '♛',
  summary: 'As 10 categorias, da mais forte para a mais fraca.',
  blocks: [
    {
      kind: 'paragraph',
      text: 'Cada exemplo mostra as cinco cartas da mão. As cartas **esmaecidas são kickers**: não fazem parte da combinação e só servem para desempatar. A porcentagem é a chance aproximada de terminar com essa categoria usando 7 cartas (as 2 suas e as 5 da mesa).',
    },
    { kind: 'ranking' },
    {
      kind: 'callout',
      tone: 'tip',
      title: 'Para guardar',
      text: 'Perto de 6 em cada 10 mãos terminam em Par ou Carta Alta, e Full House ou melhor aparece em menos de 3 % delas.',
    },

    { kind: 'heading', text: 'Desempate' },
    {
      kind: 'list',
      items: [
        '**Kickers:** duas mãos da mesma categoria comparam primeiro a combinação e depois as cartas restantes, da mais alta para a mais baixa. Par de Reis com Ás vence Par de Reis com Dama.',
        '**Naipes nunca desempatam.** Se todas as cinco cartas têm os mesmos valores, o pote é dividido.',
        '**Jogar a mesa:** se as 5 cartas comunitárias formam a melhor mão, quem continua na disputa empata e divide o pote.',
      ],
    },
    {
      kind: 'cards',
      cards: WHEEL_EXAMPLE,
      caption: 'A roda (A-2-3-4-5) é a menor sequência: aqui o Ás vale 1. A maior é 10-J-Q-K-A, e a sequência não “dá a volta” (Q-K-A-2-3 não vale).',
    },
  ],
};

const JUDGE: ManualSectionContent = {
  id: 'juiz',
  title: 'O Juiz',
  glyph: '⚖',
  summary: 'O dealer automático que cuida de tudo na mesa.',
  blocks: [
    {
      kind: 'paragraph',
      text: 'O Juiz roda no servidor, então todos jogam sob as mesmas regras: ninguém erra uma conta, ninguém trapaceia e ninguém vê as cartas dos outros antes do showdown.',
    },
    {
      kind: 'features',
      items: [
        {
          glyph: '♠',
          title: 'Embaralha e distribui',
          text: 'Sorteia o baralho no servidor, entrega duas cartas a cada jogador e vira o flop, o turn e o river no ritmo certo.',
        },
        {
          glyph: '♪',
          title: 'Narra cada lance',
          text: 'Anuncia blinds, ações, streets, all-ins e resultados no topo da tela e no registro da aba Juiz, e também em voz pt-BR.',
        },
        {
          glyph: '⏱',
          title: 'Controla o tempo',
          text: 'Cada jogada tem uma barra de tempo que muda de cor, com um tique por segundo nos últimos 10 s. Se o tempo acabar, o Juiz dá check automático quando possível, ou fold.',
        },
        {
          glyph: '✔',
          title: 'Valida cada aposta',
          text: 'Toda jogada é conferida no servidor. Aumento abaixo do mínimo, check diante de uma aposta ou jogada fora da vez é recusado com uma mensagem, e a vez continua com você.',
        },
        {
          glyph: '∑',
          title: 'Calcula os potes',
          text: 'Soma as apostas, cria os side pots, devolve a aposta que ninguém cobriu e divide os potes empatados, inclusive a ficha ímpar.',
        },
        {
          glyph: '★',
          title: 'Revela e destaca',
          text: 'No showdown vira as mãos, diz o nome de cada uma e destaca as 5 cartas vencedoras, enquanto as outras escurecem.',
        },
        {
          glyph: '◉',
          title: 'Recolhe e paga',
          text: 'Recolhe as apostas para o pote ao fim de cada rodada e empurra as fichas para quem ganhou.',
        },
        {
          glyph: '⚙',
          title: 'Cuida da mesa',
          text: 'Move o botão, posta os blinds, tira da mão quem sai, recompra pelos bots e espera por jogadores quando faltam.',
        },
      ],
    },

    { kind: 'heading', text: 'Narração' },
    {
      kind: 'definitions',
      items: [
        { term: 'Completa', text: 'Fala todos os lances: blinds, checks, apostas, folds e resultados.' },
        { term: 'Essencial', text: 'Fala só o que importa: streets, all-ins, resultados e timeouts.' },
        { term: 'Desligada', text: 'Só o texto no topo e no registro, sem voz.' },
      ],
    },
    {
      kind: 'paragraph',
      text: 'Escolha o modo, a voz e a velocidade em **Configurações** (a engrenagem). As vozes disponíveis vêm do seu sistema; as em português do Brasil aparecem primeiro.',
    },
    {
      kind: 'callout',
      tone: 'example',
      title: 'O que o Juiz anuncia',
      items: [
        'Mão #12 — Dealer: Ana · Blinds 10/20',
        'Bruno aumenta para 300.',
        'ALL-IN! Carla empurra 1.540 fichas!',
        'Tempo esgotado! O Juiz aplica check automático para Davi.',
        'Showdown! Bruno vence o pote de 2.400 com Full House de Ases e Reis!',
      ],
    },
  ],
};

const CONTROLS: ManualSectionContent = {
  id: 'controles',
  title: 'Controles',
  glyph: '⌨',
  summary: 'Botões, atalhos, câmera, configurações e como entrar na mesa.',
  blocks: [
    { kind: 'heading', text: 'Barra de ações' },
    {
      kind: 'definitions',
      items: [
        { term: 'Fold', keys: ['F'], tone: 'fold', text: 'Desiste da mão.' },
        { term: 'Check / Pagar', keys: ['C'], tone: 'call', text: 'Passa a vez, ou paga a aposta atual (o botão mostra o valor).' },
        { term: 'Apostar / Aumentar', keys: ['R'], tone: 'raise', text: 'Faz a aposta ou o aumento no valor escolhido. A tecla R leva o cursor ao campo de valor; Enter confirma.' },
        { term: 'All-In', keys: ['A'], tone: 'allin', text: 'Aposta todas as suas fichas.' },
      ],
    },
    {
      kind: 'paragraph',
      text: 'Os botões só ficam ativos na sua vez. Fora dela, a barra mostra “Aguardando <nome>…” e o tempo de quem está jogando.',
    },

    { kind: 'heading', text: 'Valor da aposta' },
    {
      kind: 'list',
      items: [
        'Use o **controle deslizante** (que anda de small blind em small blind) ou digite o total no **campo numérico**.',
        '**2× BB:** duas vezes o big blind quando você abre a aposta; com uma aposta na mesa, o dobro dela.',
        '**½ Pote** e **Pote:** o aumento tem o tamanho de meio pote, ou de um pote inteiro, depois de você pagar.',
        '**All-In:** todas as suas fichas.',
        'Os atalhos respeitam sempre o mínimo permitido e as fichas que você tem.',
      ],
    },

    { kind: 'heading', text: 'Atalhos de teclado' },
    {
      kind: 'shortcuts',
      items: [
        { keys: ['F'], text: 'Fold' },
        { keys: ['C'], text: 'Check ou Pagar' },
        { keys: ['R'], text: 'Ir ao campo de valor da aposta ou do aumento' },
        { keys: ['A'], text: 'All-In' },
        { keys: ['Enter'], text: 'Confirmar a aposta ou o aumento no valor escolhido' },
        { keys: ['?', 'H'], text: 'Abrir e fechar este manual' },
        { keys: ['Esc'], text: 'Fechar este manual' },
      ],
    },
    {
      kind: 'paragraph',
      text: 'Os atalhos de jogada só funcionam na sua vez e ficam desativados enquanto este manual está aberto.',
    },

    { kind: 'heading', text: 'Câmera e zoom' },
    {
      kind: 'list',
      items: [
        '**Roda do mouse** ou **pinça** no celular: aproxima a câmera das suas cartas, sem perder de vista as cartas comunitárias.',
        '**Botão 🔍 Zoom:** alterna entre a visão geral da mesa e a visão aproximada da sua mão.',
        '**Duplo clique** na mesa: volta à visão geral. O nível de zoom fica salvo neste navegador.',
      ],
    },

    { kind: 'heading', text: 'Configurações' },
    {
      kind: 'definitions',
      items: [
        { term: 'Volume', text: 'Volume geral do jogo.' },
        { term: 'Efeitos sonoros', text: 'Liga ou desliga os sons de cartas, fichas e alertas.' },
        { term: 'Som ambiente', text: 'Som de sala ao fundo. Vem desligado.' },
        { term: 'Narração', text: 'Completa, Essencial ou Desligada.' },
        { term: 'Voz', text: 'A voz do Juiz, entre as instaladas no seu sistema.' },
        { term: 'Velocidade da voz', text: 'Velocidade da fala do Juiz.' },
        { term: 'Qualidade gráfica', text: 'Alta (sombras e brilho) ou Baixa, recomendada para celulares e computadores mais fracos.' },
        { term: 'Cor do feltro', text: 'Esmeralda, Azul Royal ou Bordô.' },
        { term: 'Sair da mesa', text: 'Desiste da mão e libera o seu assento ao fim dela.' },
      ],
    },
    { kind: 'paragraph', text: 'As configurações ficam salvas neste navegador.' },

    { kind: 'heading', text: 'Controles do anfitrião' },
    {
      kind: 'paragraph',
      text: 'Qualquer jogador sentado pode usar estes controles. Antes de a partida começar, o lobby mostra:',
    },
    {
      kind: 'list',
      items: [
        '**Blinds:** 5/10, 10/20, 25/50 ou 50/100.',
        '**Fichas iniciais:** 1.000, 2.000, 5.000 ou 10.000.',
        '**Tempo por jogada:** 15, 30, 45 ou 60 segundos.',
        '**Adicionar Bot** e **Remover Bot**, para completar a mesa com adversários de estilos diferentes.',
        '**Iniciar Partida**, liberado com pelo menos 2 jogadores.',
        'Com a partida em andamento, o menu compacto **+ Bot / − Bot** continua disponível. O botão **Recomprar** aparece quando suas fichas acabam.',
      ],
    },

    { kind: 'heading', text: 'Entrando por outros dispositivos' },
    {
      kind: 'steps',
      items: [
        { title: 'Mesma rede', text: 'Conecte todos os dispositivos ao mesmo Wi-Fi, ou a cabos ligados ao mesmo roteador.' },
        {
          title: 'Endereço do lobby',
          text: 'Abra no navegador do celular, tablet ou computador o endereço mostrado no lobby, parecido com `http://192.168.0.12:3000`.',
        },
        { title: 'Entre na mesa', text: 'Escolha nome, cor e avatar. Com 8 jogadores sentados, quem chega depois assiste como espectador.' },
      ],
    },
    {
      kind: 'callout',
      tone: 'warning',
      title: 'Não abriu?',
      text: 'Redes de convidado ou com isolamento de clientes podem bloquear a conexão entre dispositivos. Use o endereço do computador que roda o servidor, nunca `localhost`.',
    },

    { kind: 'heading', text: 'Reconexão' },
    {
      kind: 'paragraph',
      text: 'Se a página recarregar ou o Wi-Fi cair, abra o endereço de novo **no mesmo navegador**: o Juiz reconhece você e devolve o seu assento. Enquanto você estiver fora, o tempo da sua vez cai para 8 segundos (check ou fold automático). Depois de 2 minutos desconectado, você sai da mesa ao fim da mão.',
    },
    {
      kind: 'callout',
      tone: 'note',
      title: 'Atenção',
      text: 'Outro navegador, uma aba anônima ou dados do site apagados contam como um jogador novo.',
    },
  ],
};

const GLOSSARY_SECTION: ManualSectionContent = {
  id: 'glossario',
  title: 'Glossário',
  glyph: 'Aa',
  summary: 'Os termos de poker que você vai ouvir do Juiz e dos amigos.',
  blocks: [{ kind: 'glossary' }],
};

export const MANUAL_SECTIONS: readonly ManualSectionContent[] = [HOW_TO_PLAY, HAND_RANKING_SECTION, JUDGE, CONTROLS, GLOSSARY_SECTION];

export function getManualSection(id: ManualSection): ManualSectionContent {
  const section = MANUAL_SECTIONS.find((candidate) => candidate.id === id);
  if (section === undefined) throw new Error(`Unknown manual section: ${id}`);
  return section;
}
