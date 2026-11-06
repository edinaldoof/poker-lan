# Mesa Real · Texas Hold'em LAN

Mesa Real é um jogo de **Texas Hold'em No-Limit** para múltiplos jogadores na rede local (LAN). O servidor é a
autoridade da partida: ele embaralha, distribui cartas, controla os turnos e paga os potes. Os jogadores entram
pelo navegador, em um computador, tablet ou celular, sem instalar nada além do Node.js no computador que roda o
servidor.

A mesa é renderizada em 3D com Three.js e as animações usam GSAP. Um "Juiz" narra cada lance em texto e em voz.

## Recursos

- **Mesa 3D** com o modelo de mesa, as cartas e as fichas do projeto, iluminação de clube noturno e câmera que
  acompanha a jogada.
- **Juiz (Dealer narrador)**: anuncia início de mão, blinds, ações, flop/turn/river, all-ins, showdown e vencedores,
  com voz em português do Brasil quando o navegador oferece uma voz pt-BR.
- **Bots** com personalidades diferentes (agressivos, cautelosos, blefadores), que decidem com base em equity
  estimada por Monte Carlo e no pote.
- **Side pots** e **pote dividido** calculados corretamente, inclusive com all-ins de valores diferentes.
- **Timers de turno** configuráveis (10 a 120 segundos). Quem estoura o tempo recebe check automático, ou fold
  quando não há check disponível.
- **Reconexão**: se a página for recarregada ou o Wi-Fi cair, o jogador volta ao próprio assento.
- **LAN**: qualquer dispositivo na mesma rede acessa o jogo pelo endereço IP do servidor. Não há serviço externo.
- Mesa para **até 8 assentos**, com jogadores humanos e bots misturados. Quem chega com a mesa cheia assiste como
  espectador.

## Requisitos

- **Node.js 20 ou superior** (https://nodejs.org). Qualquer versão LTS recente serve.
- Um navegador moderno com **WebGL** (Chrome, Edge, Firefox ou Safari) nos dispositivos que vão jogar.
- Para regenerar os assets 3D a partir dos arquivos originais (opcional): **Python 3** com a biblioteca **Pillow**
  (`pip install pillow`).

## Instalação

Na pasta do projeto:

```bash
npm install
```

No Windows, você também pode dar um duplo clique em `start-windows.bat`. Ele instala as dependências na primeira
vez e depois inicia o servidor.

## Executando

```bash
npm start
```

O comando compila o cliente (`npm run build`, gerando `dist/client`) e inicia o servidor. O terminal mostra um
banner parecido com este:

```
Mesa Real rodando.
  Neste computador:  http://localhost:3000
  Na rede local:     http://192.168.0.12:3000
                     http://192.168.1.25:3000
```

Use o endereço `http://localhost:3000` no próprio computador. Os endereços `http://192.168.x.x:3000` são os que
os amigos devem abrir. Para encerrar o servidor, pressione `Ctrl+C` no terminal.

Se você alterar o código do cliente, rode `npm run build` de novo (ou `npm start`) antes de atualizar a página.

## Como os amigos entram

1. Conecte todos os dispositivos **na mesma rede**: mesmo Wi-Fi ou cabo ligado ao mesmo roteador. Redes de
   convidado ou com isolamento de clientes podem bloquear a conexão entre dispositivos.
2. No computador que roda o servidor, veja no terminal o endereço `http://192.168.x.x:3000` (o IP começa com
   `192.168.`, `10.` ou `172.16.` até `172.31.`).
3. Em qualquer navegador moderno, inclusive no celular, abra esse endereço.
4. Escolha um nome, uma cor e um avatar e clique em entrar na mesa.

Quando houver mais de um endereço listado, escolha o do adaptador que está ativo, normalmente o Wi-Fi ou a
conexão cabeada. Ignore endereços de adaptadores virtuais (WSL, Docker, Hyper-V, VirtualBox, VMware).

### Firewall do Windows

Na primeira execução, o Windows pode perguntar se o Node.js pode se comunicar em redes. Marque **redes privadas**
e permita o acesso. Se você recusou ou o site não abre para outros dispositivos, libere a porta manualmente em um
terminal aberto **como administrador**:

```bat
netsh advfirewall firewall add rule name="Mesa Real Poker" dir=in action=allow protocol=TCP localport=3000
```

Para remover a regra depois:

```bat
netsh advfirewall firewall delete rule name="Mesa Real Poker"
```

Se você mudar a porta (veja abaixo), troque `localport=3000` pela porta escolhida.

## Porta personalizada

Por padrão o servidor usa a porta **3000**. Para outra porta, defina a variável de ambiente `PORT`.

No Windows (PowerShell):

```powershell
$env:PORT = "4000"; npm start
```

No Windows (cmd):

```bat
set PORT=4000 && npm start
```

No Linux ou macOS:

```bash
PORT=4000 npm start
```

## Modo de desenvolvimento

```bash
npm run dev
```

Esse modo sobe o servidor com o Vite embutido no mesmo processo, na mesma porta (3000). Alterações no cliente
aparecem no navegador na hora (HMR), e alterações no servidor reiniciam o processo automaticamente. Não é preciso
rodar `npm run build` nesse modo.

Se você quiser somente o servidor de desenvolvimento do cliente (porta 5173, com proxy para o Socket.io no
servidor da porta 3000), use `npm run dev:client` em um terminal separado, com o servidor rodando em outro.

## Testes e verificação de tipos

```bash
npm test          # roda a suíte de testes (Vitest)
npm run typecheck # verifica os tipos TypeScript sem gerar arquivos
```

Os testes cobrem o avaliador de mãos, o cálculo de potes (side pots), as regras da mesa, a inteligência dos bots e
a narração do Juiz.

## Controles

### Na mesa

- **Fold** (desistir da mão).
- **Check / Pagar**: passa a vez quando não há aposta a cobrir, ou paga a aposta atual.
- **Apostar / Aumentar**: escolha o valor com o controle deslizante, com o campo numérico ou com os atalhos.
- **All-In**: aposta todas as suas fichas.
- **Atalhos de aumento**: "2× BB" (duas vezes o big blind), "½ Pote" (meio pote) e "Pote" (um pote).

### Atalhos de teclado

| Tecla | Ação |
|---|---|
| `F` | Fold |
| `C` | Check ou Pagar |
| `R` | Aumentar (ou apostar, quando for a primeira aposta da rodada) |
| `A` | All-In |
| `Enter` | Confirmar o valor do aumento |

Os atalhos só funcionam na sua vez. Fora dela, os botões ficam desativados e a barra mostra "Aguardando <nome>…".

### Câmera e zoom

- **Roda do mouse** (ou **pinça** no celular): aproxima a câmera das suas cartas; a linha das cartas comunitárias continua visível.
- **Botão 🔍 Zoom** na barra superior: alterna entre a visão geral da mesa e a visão aproximada da sua mão.
- **Duplo clique** na mesa: volta para a visão geral. O nível de zoom fica salvo neste navegador.

### Configurações

O botão de engrenagem abre as configurações, que ficam salvas no navegador:

- **Volume** geral, **efeitos sonoros** (ligar ou desligar) e **ambiente** (som de sala, desligado por padrão).
- **Narração**: *Completa* (todos os lances), *Essencial* (só eventos importantes, como streets, all-ins, resultados
  e timeouts) ou *Desligada*.
- **Voz**: escolha a voz do Juiz entre as vozes instaladas no sistema. Vozes pt-BR aparecem primeiro.
- **Velocidade** da fala.
- **Qualidade**: *Alta* (sombras e bloom de pós-processamento) ou *Baixa* (recomendada para celulares e
  computadores mais fracos).
- **Cor do feltro**: *Esmeralda*, *Azul Royal* ou *Bordô*.
- **Sair da mesa**.

### Mesa e partida (anfitrião)

Qualquer jogador sentado pode:

- **Adicionar Bot** e **Remover Bot**.
- **Iniciar Partida**, na fase de lobby, com pelo menos 2 jogadores. Antes de iniciar, escolha os blinds (5/10,
  10/20, 25/50 ou 50/100), o stack inicial (1.000, 2.000, 5.000 ou 10.000 fichas) e o tempo por jogada (15, 30, 45
  ou 60 segundos).
- **Recomprar** fichas, quando o seu stack zerar entre as mãos.

## Ferramentas de assets (opcional)

Os modelos 3D, texturas e cartas usados pelo jogo já estão em `public/assets`. Se você tiver os arquivos originais,
pode regenerá-los:

```bash
npm run prepare-assets
```

O script lê os arquivos originais da pasta `~/Downloads` (no Windows, `C:\Users\<seu usuário>\Downloads`) e grava os
arquivos prontos para a web em `public/assets`. Ele espera encontrar:

- `Chips.obj`: modelo das fichas.
- `Textures.rar`: texturas das fichas (o Windows extrai com o `tar` nativo).
- `All+the+Cards+Texture.zip`: atlas das cartas.
- `Poker_table.3DS`: modelo da mesa.

Para usar outra pasta, passe-a como argumento: `npm run prepare-assets -- "D:\meus-assets"`. O script pode ser
executado várias vezes sem problemas.

## Estrutura do projeto

Resumo da arquitetura. O contrato completo, com as APIs de cada módulo, está em `docs/ARCHITECTURE.md`.

```
poker-lan/
├─ src/
│  ├─ server/              Autoridade da partida (Node + Express + Socket.io)
│  │  ├─ index.ts          Servidor HTTP, Socket.io, modo --dev e rotas
│  │  ├─ lan.ts            Descoberta dos endereços IPv4 da rede local
│  │  └─ game/             Regras e fluxo da mesa
│  │     ├─ Deck.ts            Embaralhamento
│  │     ├─ pots.ts            Cálculo de potes e side pots
│  │     ├─ TableEngine.ts     Regras puras do Hold'em No-Limit
│  │     ├─ BotBrain.ts        Decisões dos bots
│  │     ├─ GameController.ts  Juiz/Dealer: jogadores, turnos, timers e transmissão
│  │     └─ narration.ts       Textos PT-BR do Juiz
│  ├─ client/              Interface e cena 3D (Three.js + GSAP, sem framework)
│  │  ├─ main.ts           Inicialização e carregamento dos assets
│  │  ├─ GameClient.ts     Fila de eventos ordenada por seq
│  │  ├─ net/              Conexão Socket.io e identificação do jogador
│  │  ├─ scene/            Palco, layout dos assentos, mesa, cartas, fichas e animações
│  │  ├─ audio/            Sons sintetizados (Web Audio) e voz do Juiz
│  │  ├─ ui/               Lobby, HUD, barra de ações, log e configurações
│  │  └─ styles.css
│  └─ shared/              Código compartilhado entre servidor e cliente
│     ├─ cards.ts          Cartas e baralho
│     ├─ handEvaluator.ts  Avaliação das mãos de poker
│     ├─ protocol.ts       Tipos e eventos do Socket.io
│     └─ format.ts         Formatação de fichas (ex.: 2.400)
├─ tests/                  Testes Vitest
├─ tools/prepare_assets.py Conversão dos assets originais
├─ public/assets/          Modelos 3D, texturas, cartas e fichas
├─ docs/ARCHITECTURE.md    Contrato técnico dos módulos
├─ index.html              Entrada da aplicação
├─ vite.config.ts          Configuração do Vite (build e dev do cliente)
└─ package.json
```

Pontos que valem saber ao alterar o código:

- O servidor é a única fonte de verdade. O cliente só exibe o estado recebido e envia ações; ele não calcula nada
  do que afeta o resultado da mão.
- Cada jogador recebe uma visão personalizada da mesa: as cartas dos outros só aparecem no showdown.
- Os valores em dinheiro são sempre inteiros (fichas).
- Nomes de jogadores são tratados como texto puro, nunca como HTML.

## Solução de problemas

**A tela fica preta ou aparece uma mensagem sobre WebGL.**
O navegador não conseguiu iniciar a renderização 3D. Verifique se a aceleração por hardware está ativada nas
configurações do navegador (em *Sistema* ou *Desempenho*) e se o driver de vídeo está atualizado. Em máquinas
antigas, escolha a qualidade *Baixa* na tela de configurações, ou tente outro navegador. Abra `chrome://gpu` (ou
`edge://gpu`) para ver o status do WebGL.

**Não há som.**
Os navegadores só liberam o áudio depois de um clique ou toque na página. Clique em qualquer lugar da mesa ou no
botão de entrar uma vez. Se os efeitos continuarem mudos, confira se *efeitos sonoros* e o *volume* estão ligados
nas configurações, e se o volume do sistema não está no mudo.

**O Juiz não fala, ou fala em outro idioma.**
A narração usa as vozes instaladas no seu sistema operacional. Instale uma voz em português do Brasil:

- **Windows 10/11**: *Configurações → Hora e idioma → Fala* → *Adicionar vozes* → Português (Brasil). Reinicie o
  navegador depois.
- **macOS**: *Ajustes do Sistema → Acessibilidade → Conteúdo falado → Vozes do Sistema* → baixe uma voz em
  português.
- **Android e iOS**: instale uma voz pt-BR nas configurações de síntese de fala do sistema.

Depois, escolha a voz em *Configurações → Voz*. Se preferir, troque a narração para *Essencial* ou *Desligada*.

**Outros dispositivos não conseguem abrir a mesa.**
Confirme que todos estão na mesma rede, que o servidor está rodando e que você usou o endereço `192.168.x.x` do
computador que roda o servidor, não `localhost`. Libere a porta no firewall (veja a seção acima).

**O servidor avisa que a porta está em uso ou não inicia.**
Outro programa, ou outra instância do Mesa Real, está usando a porta 3000. Feche-o ou escolha outra porta com a
variável `PORT`.

**O servidor avisa para executar `npm run build`.**
O cliente ainda não foi compilado (a pasta `dist/client` não existe). Rode `npm start`, que compila e inicia tudo
de uma vez.

**`npm` ou `node` não são reconhecidos.**
O Node.js não está instalado ou não está no PATH. Instale a versão 20 ou superior e abra um novo terminal.

**Um jogador caiu e não voltou.**
Ele pode reabrir a página no mesmo navegador para recuperar o próprio assento. Jogadores desconectados por mais de
2 minutos saem da mesa após a mão atual.
