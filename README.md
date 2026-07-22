# Tournament Room

Tournament Room is the first foundation for a polished 3D chess tournament-training application. It is deliberately separated into domain rules, presentation, engine communication, and persistence boundaries so that desktop packaging, account authentication, cloud sync, and a selectable local save folder can be added without replacing the board or rules engine.

## Included now

- A responsive 3D-perspective tournament table with camera control, keyboard navigation, flip-board view, and click-or-drag movement.
- Legal chess: normal moves, checks, checkmate, stalemate, castling, en passant, promotion, fifty-move rule, threefold repetition, and insufficient-material draws.
- FEN and PGN output, move record, takebacks, local-session recovery, and downloadable PGN saves.
- An optional local Stockfish connector. The browser never launches executables or sends positions over the network; a loopback-only bridge talks UCI to the bundled Stockfish executable in `lib\stockfish`.
- A launch menu for free-form analysis, coached play, opening preparation, and tournament simulation.
- A grounded AI Coach mode that grades moves with Stockfish, explains material, activity, pawn structure, and king safety, and previews principal variations without changing the live game.
- An optional checkpoint-backed neural grounding service that adds learned verdict, concept, WDL, and legal-move policy signals without replacing Stockfish's verified analysis.
- A resumable PGN-to-JSONL dataset builder that legally replays games, caches Stockfish MultiPV/WDL labels, and preserves game-level split provenance.
- An Opening Prep mode with six opening families, learn/practice workflows, repertoire branches, key ideas, and browser-local progress.
- Tournament games with selectable Stockfish or CustomChessEngine opponents, player color, time controls, touch-move enforcement, a cursor-following selected piece, player clock presses, and automatic engine clock presses.
- Local-network tournament rooms for playing on two devices. A six-character room code pairs the browsers through a lightweight WebSocket relay running on the host computer; moves and clocks are validated in both browsers and never sent to a cloud service.
- A browser-local CustomChessEngine compatibility adapter: aggressive tactical play, approximately 1900 strength at its recommended depth 4 setting.

## Camera controls

The camera is intentionally navigable like a compact 3D training room:

- `W` `A` `S` `D`: move around the table.
- `Space` / `Shift`: move closer / farther away.
- `I` `J` `K` `L`: raise/lower and turn the viewing angle.

These shortcuts stay inactive while an input, select, or promotion choice has focus.

## Run locally

Open a PowerShell window in this folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\start-tournament-room.ps1
```

This starts the local-only Stockfish bridge, the local-network tournament relay, and the web app. If `ai\artifacts\chess-coach-grounding.onnx` and the inference dependencies are present, it also starts the neural grounding service. It opens the app at `http://127.0.0.1:8787/` and prints a second network address such as `http://192.168.1.20:8787/`.

To enable the trained checkpoint after downloading it from the training Pod:

```powershell
python -m venv .\ai\.venv
.\ai\.venv\Scripts\python -m pip install -r .\ai\requirements-inference.txt
New-Item -ItemType Directory -Force .\ai\artifacts | Out-Null
# Copy the exported model and metadata to .\ai\artifacts\chess-coach-grounding.onnx*
```

The full-precision ONNX model is preferred because ONNX Runtime is substantially smaller than a local PyTorch installation. The `.pt` checkpoint remains supported when PyTorch is installed. The app deliberately falls back to its Stockfish and deterministic-feature coach if the model service is absent or fails. Use `-NoGrounding` to skip service startup explicitly.

To play on another device:

1. Keep the launcher window open and connect both devices to the same local network.
2. Open the printed network address on the second device.
3. On the host, choose **Tournament simulation → Another device → Create match**.
4. On the second device, choose **Tournament simulation → Another device → Join match**, then enter the host's six-character room code.

The browser uses WebSocket because browsers cannot open an unrestricted raw TCP socket. The relay is TCP-based, carries only the small JSON move/clock messages, and listens on the local network at port `8766`. The app server listens at port `8787`. A firewall prompt may need to be allowed for private networks.

To run without Stockfish or network rooms, use the loopback-only web server directly:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\start-local-server.ps1 -OpenBrowser
```

The launcher is already pointed at `lib\stockfish\stockfish-windows-x86-64-avx2.exe`. The bridge listens only on `127.0.0.1`; it never exposes Stockfish or sends positions over the network.

## AI Coach and Opening Prep

Choose **AI coach** from the session menu and play moves normally. The coach uses local Stockfish MultiPV and win/draw/loss output for its authoritative verdict, while a deterministic feature analyzer grounds the written explanation in the board's material, activity, pawn structure, and king safety. When the trained grounding service is available, its learned concept and verdict estimates appear as a separate **Neural grounding** panel. Neural policy output is filtered through the position's legal moves and never overrides Stockfish. Use **Preview played line** or **Preview best line** to step through a projected continuation; the scoresheet and live position remain unchanged.

The coach card shows the neural model's connection state independently from Stockfish. A connected report includes the model's strategic concept, Stockfish-verdict agreement, legal-move policy rank, highest learned move signal, and side-to-move WDL outlook. If the service stops or returns an incompatible schema, the card switches to **Stockfish fallback active** and exposes a retry control without interrupting the verified coach report.

Completed coach reports are also retained in a small browser-local training buffer. **Export model data** downloads those grounded examples as JSONL for the custom chess-language model; the buffer is capped, replaces duplicate position/move samples, and is never uploaded automatically. For larger corpora, `tools/build-coach-dataset.ps1` replays PGN files and labels sampled moves through the local Stockfish bridge. The model architecture, dataset instructions, and training entry point live under `ai/`.

Long labeling jobs can use `tools/build-coach-dataset-parallel.ps1`. It assigns
whole games to deterministic shards, launches independent Stockfish UCI
workers, resumes each shard and engine cache separately, and produces a merged
dataset only after settings, shard ownership, counts, and duplicates pass
validation. The same workflow is available on RunPod through
`ai/cloud/label-and-train-runpod.sh` with separate labeling and training time
limits.

For a reproducible public source, `tools/get-public-coach-data.ps1` downloads
and verifies a CC0 Lichess standard-rated archive, then writes a bounded,
rating-filtered PGN sample under the Git-ignored `datasets/` directory. That
sample is still passed through Stockfish before model training; raw game results
are never treated as coaching explanations.

Choose **Opening Prep** to study the Italian Game, Ruy Lopez, Queen's Gambit, Sicilian Defense, French Defense, or Caro-Kann. **Learn the line** enables step-by-step playback. **Practice from memory** hides the prepared line, validates repertoire moves, supplies the opponent reply, and records completion and accuracy in browser-local storage.

Coach verdicts require the local Stockfish bridge. Opening lessons and static position features remain available when the bridge is offline. Live coaching stays disabled in tournament games.

## Architecture

| Area | Current boundary | Planned extension |
| --- | --- | --- |
| Rules | `js/domain/chess.js` | Shared desktop/server validation package |
| 3D view | `js/rendering/solid-board.js` and `js/rendering/renderer.js` | Camera presets and tournament-room polish |
| Engine | `js/engines/stockfish-client.js` and the local UCI bridge | Desktop sidecar with multi-PV and configurable strength |
| Coach | `js/coach/` combines Stockfish results, deterministic position features, and optional checkpoint inference | Grounded conversational narrator |
| AI model | `ai/chess_coach/` contains the relation-aware 64-square encoder, training pipeline, and loopback inference server; `tools/dataset/` builds game-grouped Stockfish labels | Attach and tune a licensed language decoder |
| Opening prep | `js/openings/` and `data/openings/` | Larger user-selectable repertoires and synced progress |
| Custom engine | `js/engines/custom-engine-client.js` and its worker | Worker-backed tactical search and selectable personality profiles |
| Tournament session | `js/app.js` and `js/tournament/tournament-clock.js` keep match rules, clock state, and opponent turns separate from analysis | Saved tournament metadata and adjudication history |
| Device rooms | `js/multiplayer/room-client.js` and `tools/start-room-relay.ps1` | Reconnect support and optional authenticated remote rooms |
| Saves | `js/services/game-storage.js` | User-selected folder and indexed game library |
| Accounts | No data collected | Auth service, verified email, encrypted sync |

## Product and licensing notes

The app does not yet implement accounts or collect email addresses. The profile control intentionally communicates this as a future feature. Browser save permissions cannot silently write to an arbitrary folder, so the current **Save game** action records the session in browser storage and downloads a standard `.pgn`; desktop packaging can replace that adapter with a user-chosen game library folder. Network-room messages stay inside the host's local network and are discarded by the relay rather than stored.

Stockfish is distributed under GPLv3. If you distribute a packaged version that bundles Stockfish, include its license and comply with the source-distribution obligations described in `lib\stockfish\Copying.txt`.
