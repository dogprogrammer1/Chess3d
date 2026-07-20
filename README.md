# Tournament Room

Tournament Room is the first foundation for a polished 3D chess tournament-training application. It is deliberately separated into domain rules, presentation, engine communication, and persistence boundaries so that desktop packaging, account authentication, cloud sync, and a selectable local save folder can be added without replacing the board or rules engine.

## Included now

- A responsive 3D-perspective tournament table with camera control, keyboard navigation, flip-board view, and click-or-drag movement.
- Legal chess: normal moves, checks, checkmate, stalemate, castling, en passant, promotion, fifty-move rule, threefold repetition, and insufficient-material draws.
- FEN and PGN output, move record, takebacks, local-session recovery, and downloadable PGN saves.
- An optional local Stockfish connector. The browser never launches executables or sends positions over the network; a loopback-only bridge talks UCI to the bundled Stockfish executable in `lib\stockfish`.
- A launch menu that separates free-form analysis from a tournament game simulation.
- Tournament games with selectable Stockfish or CustomChessEngine opponents, player color, time controls, touch-move enforcement, a cursor-following selected piece, player clock presses, and automatic engine clock presses.
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

This starts the local-only Stockfish bridge, opens the app at `http://127.0.0.1:8787/`, and automatically connects Stockfish. Keep this window open while using the app. When both the app page and this window are closed, the launcher also stops the bridge it started.

To run without Stockfish, use the web server directly:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\start-local-server.ps1 -OpenBrowser
```

The launcher is already pointed at `lib\stockfish\stockfish-windows-x86-64-avx2.exe`. The bridge listens only on `127.0.0.1`; it never exposes Stockfish or sends positions over the network.

## Architecture

| Area | Current boundary | Planned extension |
| --- | --- | --- |
| Rules | `js/chess.js` | Shared desktop/server validation package |
| 3D view | Single interactive WebGL canvas in `js/solid-board.js` with mesh raycasting and touch-move dragging | Camera presets and tournament-room polish |
| Engine | `js/stockfish.js` and local UCI bridge | Desktop sidecar with multi-PV and configurable strength |
| Custom engine | `js/custom-engine.js` | Worker-backed tactical search and selectable personality profiles |
| Tournament session | `js/app.js` and `js/tournament-clock.js` keep match rules, clock state, and engine turns separate from analysis | Saved tournament metadata and adjudication history |
| Saves | `js/storage.js` | User-selected folder and indexed game library |
| Accounts | No data collected | Auth service, verified email, encrypted sync |

## Product and licensing notes

The app does not yet implement accounts or collect email addresses. The profile control intentionally communicates this as a future feature. Browser save permissions cannot silently write to an arbitrary folder, so the current **Save game** action records the session in browser storage and downloads a standard `.pgn`; desktop packaging can replace that adapter with a user-chosen game library folder.

Stockfish is distributed under GPLv3. If you distribute a packaged version that bundles Stockfish, include its license and comply with the source-distribution obligations described in `lib\stockfish\Copying.txt`.
