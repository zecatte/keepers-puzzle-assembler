# Keeper's Puzzle Assembler (keepers-puzzle-assembler)

Foundry VTT v13-v14 module for investigative games. The Keeper slices an image (Grid, Random Rectangles, Torn Paper, Voronoi Shards), hands fragments to Investigators as private pieces, and players trade and assemble them on a shared mat. Solving the puzzle unlocks and opens a reward Journal Entry for everyone.

## Install
1. Put this folder in `Data/modules/keepers-puzzle-assembler/` (or install from a manifest URL once hosted), restart Foundry.
2. Enable it in the world (Manage Modules). Keep a GM online while players move pieces.

## Use
1. Journal Directory > **Puzzle Assembler** (Keeper only). Choose a base image, piece count, pattern; check the cut-line preview; **Slice & Save**.
2. Optional: pick sounds (pick-up, snap, solved), link a Reward Journal (dropdown or drag-drop).
3. Distribute: per-piece owner (Keeper / Shared pool / player) or "Distribute randomly among active players".
4. Give players access: **Generate Handout Journal** (open-board button + their own fragment thumbnails) and/or **Generate Inventory Item** (drag to a sheet; "Inspect Puzzle" button in its header).
5. Players drag pieces from My Pieces onto the mat; right-click / R / wheel rotates; pieces snap when close and correctly rotated. Right-click a tray piece (or use its buttons) to Give or Share.
6. API: `game.modules.get("keepers-puzzle-assembler").api.openBoard(puzzleId)`.

## Notes
- All state is stored in one hidden world setting; piece textures are re-rendered on each client from the stored cut polygons. Hidden pieces are not drawn for other players, but a determined player could read the setting data in the browser console; this is table-trust privacy, not cheat-proof.
- Never store assets inside module folders; keep your images/sounds under `assets/`.
