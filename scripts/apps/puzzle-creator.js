/**
 * Keeper's Puzzle Assembler - the Keeper's creator / management window (ApplicationV2).
 */
import { MODULE_ID, PuzzleManager } from "../puzzle-manager.js";
import { PATTERNS, slicePuzzle, workSize, loadImage, drawPreview } from "../slicer.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const FilePickerImpl = () => foundry.applications.apps.FilePicker.implementation;

const ROTATION_STEPS = [15, 30, 45, 90];

function blankDraft() {
  return {
    id: null,
    name: "",
    image: "",
    count: 9,
    pattern: "torn",
    seed: Math.floor(Math.random() * 900000) + 100000,
    allowRotation: true,
    scrambleRotation: true,
    rotationStep: 45,
    snapDistance: 18,
    snapAngle: 12,
    showGhost: false,
    sounds: { pickup: "", snap: "", solved: "", volume: 0.8 },
    rewardUuid: ""
  };
}

function draftFrom(pz) {
  return foundry.utils.mergeObject(blankDraft(), foundry.utils.deepClone(pz), { inplace: false });
}

export class PuzzleCreator extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: "kpa-creator",
    classes: ["kpa-app", "kpa-creator-app"],
    window: { title: "Keeper's Puzzle Assembler", icon: "fa-solid fa-puzzle-piece", resizable: true },
    position: { width: 760, height: 820 },
    actions: {
      pickFile: PuzzleCreator.onPickFile,
      randomSeed: PuzzleCreator.onRandomSeed,
      saveSlice: PuzzleCreator.onSaveSlice,
      newPuzzle: PuzzleCreator.onNewPuzzle,
      deletePuzzle: PuzzleCreator.onDeletePuzzle,
      resetProgress: PuzzleCreator.onResetProgress,
      openBoard: PuzzleCreator.onOpenBoard,
      distribute: PuzzleCreator.onDistribute,
      allShared: PuzzleCreator.onAllShared,
      allKeeper: PuzzleCreator.onAllKeeper,
      makeHandout: PuzzleCreator.onMakeHandout,
      makeItem: PuzzleCreator.onMakeItem,
      clearReward: PuzzleCreator.onClearReward,
      clearFile: PuzzleCreator.onClearFile
    }
  };

  static PARTS = {
    creator: { template: `modules/${MODULE_ID}/templates/puzzle-creator.hbs` }
  };

  static open(puzzleId = null) {
    if (!game.user.isGM) {
      ui.notifications.warn("Only the Keeper can open the Puzzle Creator.");
      return null;
    }
    this.instance ??= new this();
    if (puzzleId && PuzzleManager.getPuzzle(puzzleId)) this.instance.select(puzzleId);
    this.instance.render({ force: true });
    return this.instance;
  }

  constructor(options = {}) {
    super(options);
    this.puzzleId = null;
    this.draft = blankDraft();
    this._previewToken = 0;
    this._refreshTimer = null;
  }

  select(puzzleId) {
    const pz = PuzzleManager.getPuzzle(puzzleId);
    this.puzzleId = pz?.id ?? null;
    this.draft = pz ? draftFrom(pz) : blankDraft();
  }

  /* -------------------------------------------------------------- */
  /*  Context                                                        */
  /* -------------------------------------------------------------- */

  async _prepareContext() {
    const puzzles = Object.values(PuzzleManager.getPuzzles());
    const saved = this.puzzleId ? PuzzleManager.getPuzzle(this.puzzleId) : null;
    if (this.puzzleId && !saved) {
      this.puzzleId = null;
      this.draft = blankDraft();
    }
    const d = this.draft;

    let rows = [];
    if (saved) {
      const tex = await PuzzleManager.getTextures(saved);
      const keeperId = PuzzleManager.keeperId();
      const opts = [
        { value: keeperId, label: "Keeper (unassigned)" },
        { value: "shared", label: "Shared / Public Pool" },
        ...PuzzleManager.players().map(u => ({
          value: u.id,
          label: `${PuzzleManager.displayName(u.id)} (${u.name})${u.active ? "" : " - offline"}`
        }))
      ];
      rows = saved.pieces.map((p, i) => {
        const owner = game.users.get(p.ownerId)?.isGM ? keeperId : p.ownerId;
        return {
          id: p.id,
          n: i + 1,
          src: tex[p.id] ?? "",
          onBoard: p.state === "board",
          locked: p.locked,
          options: opts.map(o => ({ ...o, selected: o.value === owner }))
        };
      });
    }

    const journals = game.journal.contents
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(j => ({ value: j.uuid, label: j.name, selected: j.uuid === d.rewardUuid }));
    let rewardName = "";
    if (d.rewardUuid) {
      const doc = fromUuidSync(d.rewardUuid);
      rewardName = doc?.name ?? "(not found)";
      if (doc && !journals.some(j => j.value === d.rewardUuid)) journals.push({ value: d.rewardUuid, label: doc.name, selected: true });
    }

    return {
      puzzles: puzzles.map(p => ({ id: p.id, name: p.name, selected: p.id === this.puzzleId })),
      isSaved: !!saved,
      completed: !!saved?.completed,
      d,
      patterns: PATTERNS.map(p => ({ ...p, selected: p.value === d.pattern })),
      rotationSteps: ROTATION_STEPS.map(v => ({ value: v, selected: v === Number(d.rotationStep) })),
      rows,
      journals,
      rewardName,
      hasHandout: !!saved?.handoutUuid,
      hasItem: !!saved?.itemUuid,
      pieceCount: saved?.pieces.length ?? 0
    };
  }

  /* -------------------------------------------------------------- */
  /*  Render + live binding                                          */
  /* -------------------------------------------------------------- */

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    PuzzleManager.apps.add(this);
  }

  async _onClose(options) {
    PuzzleManager.apps.delete(this);
    return super._onClose?.(options);
  }

  refreshSoon() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.rendered && this.render({ parts: ["creator"] }), 60);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;

    el.querySelectorAll("[data-draft]").forEach(input => {
      const handler = () => this._onDraftInput(input);
      input.addEventListener(input.matches("input[type=text], input[type=number], input[type=range]") ? "input" : "change", handler);
    });

    el.querySelector("[name=puzzleSelect]")?.addEventListener("change", ev => {
      this.select(ev.currentTarget.value);
      this.render({ parts: ["creator"] });
    });

    el.querySelectorAll("select[data-piece-owner]").forEach(sel => {
      sel.addEventListener("change", ev => {
        PuzzleManager.setOwner(this.puzzleId, ev.currentTarget.dataset.pieceOwner, ev.currentTarget.value);
      });
    });

    const drop = el.querySelector(".kpa-reward-drop");
    if (drop) {
      drop.addEventListener("dragover", ev => { ev.preventDefault(); drop.classList.add("kpa-over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("kpa-over"));
      drop.addEventListener("drop", ev => this._onRewardDrop(ev, drop));
    }

    this._updatePreview();
  }

  _onDraftInput(input) {
    const key = input.dataset.draft;
    let value;
    if (input.type === "checkbox") value = input.checked;
    else if (input.type === "number" || input.type === "range" || input.dataset.number !== undefined) value = Number(input.value);
    else value = input.value;
    foundry.utils.setProperty(this.draft, key, value);
    if (input.type === "range") {
      const out = input.parentElement.querySelector(".kpa-range-value");
      if (out) out.textContent = String(value);
    }
    if (key === "rewardUuid") this.render({ parts: ["creator"] });
    if (["image", "count", "pattern", "seed"].includes(key)) this._updatePreview();
    if (key === "allowRotation") this.render({ parts: ["creator"] });
  }

  async _updatePreview() {
    const canvas = this.element?.querySelector("canvas.kpa-preview");
    const note = this.element?.querySelector(".kpa-preview-note");
    if (!canvas) return;
    const token = ++this._previewToken;
    const d = this.draft;
    if (!d.image) {
      canvas.width = 480;
      canvas.height = 270;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, 480, 270);
      ctx.fillStyle = "#777";
      ctx.font = "16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Choose a base image to preview the cut lines", 240, 135);
      if (note) note.textContent = "";
      return;
    }
    try {
      const img = await loadImage(d.image);
      if (token !== this._previewToken) return;
      const { width, height } = workSize(img.naturalWidth, img.naturalHeight);
      const pieces = slicePuzzle({ pattern: d.pattern, count: d.count, width, height, seed: d.seed });
      drawPreview(canvas, img, pieces, width, height);
      if (note) note.textContent = `${pieces.length} pieces, seed ${d.seed}`;
    } catch (err) {
      if (note) note.textContent = "Could not load that image.";
    }
  }

  async _onRewardDrop(ev, drop) {
    ev.preventDefault();
    drop.classList.remove("kpa-over");
    let data;
    try {
      const TE = foundry.applications.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
      data = TE?.getDragEventData ? TE.getDragEventData(ev) : JSON.parse(ev.dataTransfer.getData("text/plain"));
    } catch (err) {
      return;
    }
    if (!data || !["JournalEntry", "JournalEntryPage"].includes(data.type)) {
      ui.notifications.warn("Drop a Journal Entry here.");
      return;
    }
    let doc = await fromUuid(data.uuid);
    if (doc?.documentName === "JournalEntryPage") doc = doc.parent;
    if (!doc) return;
    this.draft.rewardUuid = doc.uuid;
    this.render({ parts: ["creator"] });
  }

  /* -------------------------------------------------------------- */
  /*  Actions                                                        */
  /* -------------------------------------------------------------- */

  static onPickFile(event, target) {
    const key = target.dataset.target;
    const type = target.dataset.type || "image";
    const current = foundry.utils.getProperty(this.draft, key) ?? "";
    new (FilePickerImpl())({
      type,
      current,
      callback: path => {
        foundry.utils.setProperty(this.draft, key, path);
        if (key === "image" && !this.draft.name) {
          this.draft.name = decodeURIComponent(path.split("/").pop().replace(/\.[^.]+$/, "")).replace(/[_-]+/g, " ");
        }
        this.render({ parts: ["creator"] });
      }
    }).render({ force: true });
  }

  static onClearFile(event, target) {
    foundry.utils.setProperty(this.draft, target.dataset.target, "");
    this.render({ parts: ["creator"] });
  }

  static onRandomSeed() {
    this.draft.seed = Math.floor(Math.random() * 900000) + 100000;
    this.render({ parts: ["creator"] });
  }

  static async onSaveSlice() {
    const d = this.draft;
    if (!d.image) return ui.notifications.warn("Choose a base image first.");
    try {
      const id = await PuzzleManager.savePuzzle({ ...d, id: this.puzzleId });
      this.select(id);
      ui.notifications.info(`Puzzle "${PuzzleManager.getPuzzle(id).name}" saved.`);
      this.render({ parts: ["creator"] });
    } catch (err) {
      console.error(err);
      ui.notifications.error(`Could not save the puzzle: ${err.message}`);
    }
  }

  static onNewPuzzle() {
    this.puzzleId = null;
    this.draft = blankDraft();
    this.render({ parts: ["creator"] });
  }

  static async onDeletePuzzle() {
    const pz = this.puzzleId && PuzzleManager.getPuzzle(this.puzzleId);
    if (!pz) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Puzzle" },
      content: `<p>Delete the puzzle <strong>${foundry.utils.escapeHTML(pz.name)}</strong>? Generated handouts and items are kept but will stop working.</p>`
    });
    if (!ok) return;
    await PuzzleManager.deletePuzzle(pz.id);
    this.puzzleId = null;
    this.draft = blankDraft();
    this.render({ parts: ["creator"] });
  }

  static async onResetProgress() {
    if (!this.puzzleId) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Reset Progress" },
      content: "<p>Return every piece to its tray and clear the solved state? Piece owners are kept. A reward journal that was already unlocked stays unlocked.</p>"
    });
    if (ok) await PuzzleManager.resetProgress(this.puzzleId);
  }

  static onOpenBoard() {
    if (this.puzzleId) PuzzleManager.openBoardFn?.(this.puzzleId);
  }

  static async onDistribute() {
    if (!this.puzzleId) return;
    const n = await PuzzleManager.distributeRandomly(this.puzzleId);
    if (n) ui.notifications.info(`Dealt ${n} fragments among the connected players.`);
  }

  static onAllShared() {
    if (this.puzzleId) PuzzleManager.setAllOwner(this.puzzleId, "shared");
  }

  static onAllKeeper() {
    if (this.puzzleId) PuzzleManager.setAllOwner(this.puzzleId, PuzzleManager.keeperId());
  }

  static async onMakeHandout() {
    if (this.puzzleId) await PuzzleManager.createHandout(this.puzzleId);
  }

  static async onMakeItem() {
    if (this.puzzleId) await PuzzleManager.createItem(this.puzzleId);
  }

  static onClearReward() {
    this.draft.rewardUuid = "";
    this.render({ parts: ["creator"] });
  }
}
