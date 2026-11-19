/**
 * Keeper's Puzzle Assembler - entry point.
 * Hooks, world setting, socket router, Journal Directory button, handout + item integration.
 */
import { MODULE_ID, SOCKET, SETTING, PuzzleManager } from "./puzzle-manager.js";
import { PuzzleBoard } from "./apps/puzzle-board.js";
import { PuzzleCreator } from "./apps/puzzle-creator.js";

const rootOf = html => (html instanceof HTMLElement ? html : html?.[0] ?? null);

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING, {
    name: "Puzzle data",
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: () => PuzzleManager.refresh()
  });
});

Hooks.once("ready", () => {
  PuzzleManager.openBoardFn = id => PuzzleBoard.open(id);
  game.socket.on(SOCKET, msg => PuzzleManager.onSocket(msg));
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      openBoard: id => PuzzleBoard.open(id),
      openCreator: id => PuzzleCreator.open(id),
      manager: PuzzleManager
    };
  }
});

/* ---------------------------------------------------------------- */
/*  Journal Directory button (Keeper only)                           */
/* ---------------------------------------------------------------- */

Hooks.on("renderJournalDirectory", (app, html) => {
  if (!game.user.isGM) return;
  const el = rootOf(html);
  if (!el || el.querySelector(".kpa-dir-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "kpa-dir-btn";
  btn.innerHTML = '<i class="fa-solid fa-puzzle-piece"></i> Puzzle Assembler';
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    PuzzleCreator.open();
  });
  const target = el.querySelector(".header-actions") ?? el.querySelector(".directory-header") ?? el.querySelector("header");
  if (target) target.append(btn);
});

/* ---------------------------------------------------------------- */
/*  Handout journal: "Open board" button + per-viewer thumbnails     */
/* ---------------------------------------------------------------- */

function decorateJournal(app, html) {
  const el = rootOf(html) ?? rootOf(app?.element);
  if (!el?.querySelector?.(".kpa-handout")) return;
  PuzzleManager.handoutApps.add(app);
  PuzzleManager.decorateHandout(el);
}
for (const hook of ["renderJournalEntryPageSheet", "renderJournalEntryPageTextSheet", "renderJournalEntrySheet", "renderJournalSheet"]) {
  Hooks.on(hook, decorateJournal);
}

/* ---------------------------------------------------------------- */
/*  Item sheet: "Inspect Puzzle" header button                       */
/* ---------------------------------------------------------------- */

function decorateItemSheet(app, html) {
  const item = app.document ?? app.object;
  const puzzleId = item?.getFlag?.(MODULE_ID, "puzzleId");
  if (!puzzleId) return;
  const el = rootOf(html) ?? rootOf(app.element);
  const header = el?.querySelector?.(".window-header");
  if (!header || header.querySelector(".kpa-item-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "kpa-item-btn header-control";
  btn.title = "Inspect Puzzle";
  btn.innerHTML = '<i class="fa-solid fa-puzzle-piece"></i> <span>Inspect Puzzle</span>';
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    PuzzleBoard.open(puzzleId);
  });
  const anchor = header.querySelector('[data-action="close"], .close, .header-button.close');
  if (anchor) anchor.before(btn);
  else header.append(btn);
}
for (const hook of ["renderItemSheet", "renderItemSheetV2"]) Hooks.on(hook, decorateItemSheet);
