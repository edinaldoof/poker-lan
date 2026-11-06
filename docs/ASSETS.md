# Créditos e licenças dos assets

Todos os arquivos ficam em `public/assets/` e são servidos em `/assets/...`. Nada é baixado em tempo de execução:
o jogo funciona offline na rede local.

## Sala de cartas (Poly Haven, CC0)

Todos os assets da sala vêm do [Poly Haven](https://polyhaven.com) e estão sob a licença
[CC0 1.0 Universal (domínio público)](https://creativecommons.org/publicdomain/zero/1.0/) — uso livre, inclusive
comercial, sem exigência de atribuição (veja <https://polyhaven.com/license>). Mesmo assim, ficam os créditos.

| Asset | Pasta em `public/assets/room/` | Origem | Uso no jogo |
|---|---|---|---|
| Warm Bar (HDRI 1k) | `hdri/warm_bar_1k.hdr` | <https://polyhaven.com/a/warm_bar> | Iluminação ambiente (IBL) de toda a cena |
| Dining Chair 02 | `models/dining_chair_02/` | <https://polyhaven.com/a/dining_chair_02> | Uma cadeira por lugar da mesa |
| Chandelier 03 | `models/Chandelier_03/` | <https://polyhaven.com/a/Chandelier_03> | Os dois lustres de velas |
| Gothic Cabinet 01 | `models/GothicCabinet_01/` | <https://polyhaven.com/a/GothicCabinet_01> | Armário na parede leste |
| Sofa 03 | `models/sofa_03/` | <https://polyhaven.com/a/sofa_03> | Sofá na parede oeste |
| Vintage Grandfather Clock 01 | `models/vintage_grandfather_clock_01/` | <https://polyhaven.com/a/vintage_grandfather_clock_01> | Relógio de pé (os ponteiros mostram a hora local) |
| Fancy Picture Frame 01 | `models/fancy_picture_frame_01/` | <https://polyhaven.com/a/fancy_picture_frame_01> | Os três quadros (cada um mostra um recorte da pintura) |
| Classic Console 01 | `models/ClassicConsole_01/` | <https://polyhaven.com/a/ClassicConsole_01> | Aparador atrás do crupiê |
| Dark Wood | `textures/dark_wood/` | <https://polyhaven.com/a/dark_wood> | Lambris, rodapé, molduras, vigas do teto e o assoalho |
| Quatrefoil Jacquard Fabric | `textures/quatrefoil_jacquard_fabric/` | <https://polyhaven.com/a/quatrefoil_jacquard_fabric> | Papel de parede adamascado |

### Preparação para a web

Os arquivos originais de 1k foram mantidos; o jogo usa cópias reduzidas geradas a partir deles (Python + Pillow):

- Texturas dos móveis de fundo (lustre, aparador, armário, relógio, sofá, molduras) reduzidas para 512 px
  (`*_512.jpg`); normal e rugosidade da tela da pintura em 256 px. Ficam em 1k apenas cor e normal da cadeira, a
  pintura e a cor da madeira das paredes. Os `.gltf` apontam para as cópias.
- `Chandelier_03_1k.gltf`: o vidro deixou de usar `KHR_materials_transmission` (o three.js faria uma passada
  extra de renderização por quadro) e não referencia mais o mapa de opacidade.
- `quatrefoil_jacquard_fabric_damask_diff_512.jpg`: cor bordô tom sobre tom criada a partir do canal de rugosidade
  do tecido (o desenho do quadrifólio só existe nesse canal). O papel de parede não usa normal map: o relevo do
  tecido não aparece à distância da sala, e as paredes cobrem metade do quadro do lobby
  (`quatrefoil_jacquard_fabric_nor_gl_512.jpg` ficou no projeto, sem uso).
- `dark_wood_planks_diff_1k.jpg`: tábuas de assoalho montadas com recortes da textura `dark_wood`.
- O HDRI é carregado como está; no navegador, as lâmpadas acima de luminância 3 são limitadas antes da filtragem
  (PMREM), para que cromados e latões não brilhem demais.

As cópias reduzidas e as texturas derivadas são obras derivadas de assets CC0 e seguem em domínio público.

## Demais assets (como documentados no repositório)

| Asset | Arquivo no jogo | Origem documentada | Observações |
|---|---|---|---|
| Mesa de pôquer com luminária | `table/poker_table.3ds` | Arquivo `Poker_table.3DS` (ver `tools/prepare_assets.py` e o README) | A origem/licença do arquivo original não está registrada no repositório |
| Baralho | `cards/cards_atlas.webp` | Pacote `All+the+Cards+Texture.zip` (ver `tools/prepare_assets.py`) | Atlas 13 × 5 recortado e reempacotado pelo script; origem/licença não registradas |
| Fichas | `chips/chip.obj`, `chips/chip_*.webp`, `chips/chip_normal.png` | `Chips.obj` e `Textures.rar` (ver `tools/prepare_assets.py`) | Origem/licença não registradas |
| Crupiê | `dealer/dealer.glb` | Renderpeople "Eric" rigged (`55-rp_eric_rigged_001_max.zip`, ver `tools/prepare_dealer.py`) | Personagem gratuito da Renderpeople; vale a licença da Renderpeople para modelos gratuitos |
| Fontes Barlow e Big Shoulders Display | pacotes `@fontsource/barlow` e `@fontsource/big-shoulders-display` | npm (Fontsource) | SIL Open Font License 1.1 |
| Feltro, madeira da mesa, couro, carpete, brilhos | — | Gerados por código (`FeltTexture.ts`, `proceduralTextures.ts`, `room/roomGlow.ts`, `room/candleLights.ts`) | Sem arquivo externo |
| Sons e narração | — | Sintetizados (Web Audio e `speechSynthesis` do navegador) | Sem arquivo externo |
