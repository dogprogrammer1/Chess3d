# Tournament Room

Tournament Room is the first foundation for a polished 3D chess tournament-training application. It is deliberately separated into domain rules, presentation, engine communication, and persistence boundaries so that desktop packaging, account authentication, cloud sync, and a selectable local save folder can be added without replacing the board or rules engine.

## Included now

- A responsive 3D-perspective tournament table with camera control, keyboard navigation, flip-board view, and click-or-drag movement.
- Legal chess: normal moves, checks, checkmate, stalemate, castling, en passant, promotion, fifty-move rule, threefold repetition, and insufficient-material draws.
- FEN and PGN output, move record, takebacks, local-session recovery, and downloadable PGN saves.
- An optional local Stockfish connector. The browser never launches executables or sends positions over the network; a loopback-only bridge talks UCI to the Stockfish executable already in `C:\Users\C.She29\Documents\stockfish`.
- Analysis-board and versus-Stockfish modes, with beginner/club/tournament/expert presets and a manual depth control.
- A browser-local CustomChessEngine compatibility adapter: aggressive tactical play, approximately 1900 strength at its recommended depth 4 setting.

## Camera controls

The camera is intentionally navigable like a compact 3D training room:

- `W` `A` `S` `D`: move around the table.
- `Space` / `Shift`: move closer / farther away.
- `I` `J` `K` `L`: raise/lower and turn the viewing angle.

These shortcuts stay inactive while an input, select, or promotion choice has focus.

## Run locally

Open a PowerShell window in this folder and run the local web server:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\start-local-server.ps1
```

Then open `http://127.0.0.1:8787/` in a browser. Keep this window open while using the app.

To enable Stockfish, open a second PowerShell window and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\start-stockfish-bridge.ps1
```

The script is already pointed at `C:\Users\C.She29\Documents\stockfish\stockfish-windows-x86-64-avx2.exe`. Leave the bridge running, then select **Connect engine** in the app. This is a local-only connection (`127.0.0.1`) and it does not expose Stockfish to the network.

## Architecture

| Area | Current boundary | Planned extension |
| --- | --- | --- |
| Rules | `js/chess.js` | Shared desktop/server validation package |
| 3D view | `js/renderer.js` + CSS perspective | WebGL tournament room, clocks, animated pieces |
| Engine | `js/stockfish.js` and local UCI bridge | Desktop sidecar with multi-PV and configurable strength |
| Custom engine | `js/custom-engine.js` | Worker-backed tactical search and selectable personality profiles |
| Saves | `js/storage.js` | User-selected folder and indexed game library |
| Accounts | No data collected | Auth service, verified email, encrypted sync |

## Product and licensing notes

The app does not yet implement accounts or collect email addresses. The profile control intentionally communicates this as a future feature. Browser save permissions cannot silently write to an arbitrary folder, so the current **Save game** action records the session in browser storage and downloads a standard `.pgn`; desktop packaging can replace that adapter with a user-chosen game library folder.

Stockfish is distributed under GPLv3. If you distribute a packaged version that bundles Stockfish, include its license and comply with the source-distribution obligations described in `C:\Users\C.She29\Documents\stockfish\Copying.txt`.
