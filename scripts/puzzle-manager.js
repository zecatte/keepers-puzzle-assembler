/**
 * Keeper's Puzzle Assembler - state, privacy, ownership, snapping, generators, reward handling.
 * World settings can only be written by a GM, so every player action is a socket request
 * that the active Keeper client validates and applies.
 */
import { loadImage, slicePuzzle, renderPieceTextures, workSize, resolveImageUrl } from "./slicer.js";

export const MODULE_ID = "keepers-puzzle-assembler";
export const SOCKET = `module.${MODULE_ID}`;
export const SETTING = "puzzles";

const REQUEST_TYPES = ["PLACE_PIECE", "ROTATE_PIECE", "RETURN_PIECE", "TRANSFER_PIECE"];

const norm = deg => ((Math.round(deg) % 360) + 360) % 360;
const uid = () => foundry.utils.randomID(12);

export class PuzzleManager {
  /** Open apps (boards / creator) that want refreshSoon() calls. */
  static apps = new Set();
  /** Open journal sheets that contain a puzzle handout. */
  static handoutApps = new Set();
  /** Set by main.js to avoid a circular import. */
  static openBoardFn = null;

  static _queue = Promise.resolve();
  static _textures = new Map();
  static _pending = new Map();

  /* -------------------------------------------------------------- */
  /*  Reading                                                        */
  /* -------------------------------------------------------------- */

  static getPuzzles() {
    return game.settings.get(MODULE_ID, SETTING) ?? {};
  }

  static getPuzzle(id) {
    return this.getPuzzles()[id] ?? null;
  }

  static imageUrl(puzzle) {
    return resolveImageUrl(puzzle?.image);
  }

  static keeperId() {
    return (game.users.activeGM ?? game.users.find(u => u.isGM))?.id;
  }

  static displayName(userId) {
    if (userId === "shared") return "the party";
    const u = game.users.get(userId);
    if (!u) return "Someone";
    if (u.isGM) return "The Keeper";
    return u.character?.name ?? u.name;
  }

  static players() {
    return game.users.filter(u => !u.isGM);
  }

  /** Textures are rendered per client from the stored polygons and cached in memory. */
  static async getTextures(puzzle) {
    const key = `${puzzle.id}:${puzzle.sliceVersion}`;
    if (this._textures.has(key)) return this._textures.get(key);
    if (this._pending.has(key)) return this._pending.get(key);
    const promise = (async () => {
      try {
        const img = await loadImage(puzzle.image);
        const tex = await renderPieceTextures(img, puzzle.pieces, puzzle.width, puzzle.height, puzzle.pattern);
        this._textures.set(key, tex);
        return tex;
      } catch (err) {
        console.error(`${MODULE_ID} | texture rendering failed`, err);
        ui.notifications.error(`Keeper's Puzzle Assembler: could not load the image for "${puzzle.name}".`);
        return {};
      } finally {
        this._pending.delete(key);
      }
    })();
    this._pending.set(key, promise);
    return promise;
  }

  /**
   * Privacy filter. Unplaced pieces held by someone else are NEVER returned with an image,
   * only counted. The Keeper additionally receives `overview` with every held piece.
   */
  static view(puzzle, userId = game.user.id) {
    const isGM = game.users.get(userId)?.isGM ?? false;
    const tray = puzzle.pieces.filter(p => p.state === "tray");
    const mine = tray.filter(p => p.ownerId === userId);
    const shared = tray.filter(p => p.ownerId === "shared");
    const board = puzzle.pieces.filter(p => p.state === "board");
    const holders = [];
    const overview = [];
    const byOwner = new Map();
    for (const p of tray) {
      if (p.ownerId === userId || p.ownerId === "shared") continue;
      if (!byOwner.has(p.ownerId)) byOwner.set(p.ownerId, []);
      byOwner.get(p.ownerId).push(p);
    }
    for (const [ownerId, list] of byOwner) {
      const owner = game.users.get(ownerId);
      if (owner && !owner.isGM) holders.push({ userId: ownerId, name: this.displayName(ownerId), count: list.length });
      if (isGM) overview.push({ userId: ownerId, name: owner?.isGM ? "Keeper (unassigned)" : this.displayName(ownerId), pieces: list });
    }
    return { mine, shared, board, holders, overview };
  }

  /* -------------------------------------------------------------- */
  /*  Writing (GM only)                                              */
  /* -------------------------------------------------------------- */

  static _mutate(fn) {
    if (!game.user.isGM) throw new Error("Only a Keeper can modify puzzles.");
    const run = async () => {
      const all = foundry.utils.deepClone(this.getPuzzles());
      const result = await fn(all);
      await game.settings.set(MODULE_ID, SETTING, all);
      return result;
    };
    const p = this._queue.then(run);
    this._queue = p.catch(() => {});
    return p;
  }

  static randomRotation(pz) {
    if (!pz.allowRotation || !pz.scrambleRotation) return 0;
    const step = Math.max(5, Number(pz.rotationStep) || 45);
    return step * Math.floor(Math.random() * Math.floor(360 / step));
  }

  /** Create or update a puzzle from a creator draft. Re-slices only if the geometry inputs changed. */
  static async savePuzzle(def) {
    const geoSig = [def.image, def.count, def.pattern, def.seed].join("|");
    const prev = def.id ? this.getPuzzle(def.id) : null;
    let size = null;
    if (!prev || prev.geoSig !== geoSig) {
      const img = await loadImage(def.image);
      size = workSize(img.naturalWidth, img.naturalHeight);
    }
    return this._mutate(all => {
      const id = def.id && all[def.id] ? def.id : uid();
      const existing = all[id];
      const pz = existing ?? {};
      Object.assign(pz, {
        id,
        name: def.name || "Untitled Puzzle",
        image: def.image,
        pattern: def.pattern,
        count: Number(def.count),
        seed: Number(def.seed),
        allowRotation: !!def.allowRotation,
        scrambleRotation: !!def.scrambleRotation,
        rotationStep: Number(def.rotationStep) || 45,
        snapDistance: Number(def.snapDistance) || 18,
        snapAngle: Number(def.snapAngle) || 12,
        showGhost: !!def.showGhost,
        sounds: {
          pickup: def.sounds?.pickup ?? "",
          snap: def.sounds?.snap ?? "",
          solved: def.sounds?.solved ?? "",
          volume: Number(def.sounds?.volume ?? 0.8)
        },
        rewardUuid: def.rewardUuid ?? ""
      });
      if (!existing || existing.geoSig !== geoSig) {
        pz.width = size.width;
        pz.height = size.height;
        pz.geoSig = geoSig;
        pz.sliceVersion = Date.now();
        pz.completed = false;
        const keeper = this.keeperId();
        pz.pieces = slicePuzzle({ pattern: pz.pattern, count: pz.count, width: pz.width, height: pz.height, seed: pz.seed })
          .map(p => ({ ...p, ownerId: keeper, state: "tray", x: 0, y: 0, rotation: this.randomRotation(pz), locked: false }));
      } else if (!pz.allowRotation) {
        for (const p of pz.pieces) if (!p.locked) p.rotation = 0;
      }
      all[id] = pz;
      return id;
    });
  }

  static deletePuzzle(id) {
    this._textures.forEach((_, k) => k.startsWith(`${id}:`) && this._textures.delete(k));
    return this._mutate(all => { delete all[id]; });
  }

  static setOwner(puzzleId, pieceId, ownerId) {
    return this._mutate(all => {
      const p = all[puzzleId]?.pieces.find(x => x.id === pieceId);
      if (p && p.state === "tray") p.ownerId = ownerId;
    });
  }

  static setAllOwner(puzzleId, ownerId) {
    return this._mutate(all => {
      for (const p of all[puzzleId]?.pieces ?? []) if (p.state === "tray") p.ownerId = ownerId;
    });
  }

  /** Deal the unplaced pieces round-robin to the active (connected) non-GM users. */
  static async distributeRandomly(puzzleId) {
    const active = this.players().filter(u => u.active);
    if (!active.length) {
      ui.notifications.warn("No players are connected to distribute pieces to.");
      return 0;
    }
    return this._mutate(all => {
      const pz = all[puzzleId];
      if (!pz) return 0;
      const pool = pz.pieces.filter(p => p.state === "tray");
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      pool.forEach((p, i) => { p.ownerId = active[i % active.length].id; });
      return pool.length;
    });
  }

  static resetProgress(puzzleId) {
    return this._mutate(all => {
      const pz = all[puzzleId];
      if (!pz) return;
      pz.completed = false;
      for (const p of pz.pieces) {
        p.state = "tray";
        p.locked = false;
        p.x = 0;
        p.y = 0;
        p.rotation = this.randomRotation(pz);
      }
    });
  }

  /* -------------------------------------------------------------- */
  /*  Requests (players -> active Keeper)                            */
  /* -------------------------------------------------------------- */

  static async request(type, payload) {
    const msg = { type, userId: game.user.id, ...payload };
    if (game.user.isActiveGM) return this.processRequest(msg);
    if (!game.users.activeGM) {
      ui.notifications.warn("The Keeper must be online for pieces to be moved.");
      return;
    }
    game.socket.emit(SOCKET, msg);
  }

  /** Emit to everyone else AND apply locally (socket.emit does not loop back). */
  static broadcast(msg) {
    game.socket.emit(SOCKET, msg);
    this.onSocket(msg);
  }

  static onSocket(msg) {
    if (!msg?.type) return;
    if (REQUEST_TYPES.includes(msg.type)) {
      if (game.user.isActiveGM) this.processRequest(msg);
      return;
    }
    switch (msg.type) {
      case "DRAG_PIECE":
        if (msg.userId !== game.user.id) this.apps.forEach(a => a.applyRemoteDrag?.(msg));
        break;
      case "PIECE_SNAPPED":
        this.apps.forEach(a => a.flashSnap?.(msg));
        break;
      case "PIECE_TRANSFERRED":
        if (msg.toId === game.user.id && msg.fromId !== game.user.id && msg.toId !== "shared") {
          ui.notifications.info(`${this.displayName(msg.fromId)} handed you a fragment.`);
        }
        break;
      case "PUZZLE_SOLVED":
        this.apps.forEach(a => a.celebrate?.(msg));
        break;
      case "OPEN_JOURNAL":
        this.openJournal(msg.uuid);
        break;
    }
  }

  static async processRequest(msg) {
    try {
      switch (msg.type) {
        case "PLACE_PIECE": return await this._place(msg);
        case "ROTATE_PIECE": return await this._rotate(msg);
        case "RETURN_PIECE": return await this._return(msg);
        case "TRANSFER_PIECE": return await this._transfer(msg);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | request failed`, msg, err);
    }
  }

  static isSnapped(pz, pc) {
    const dist = Math.hypot(pc.x - pc.bbox.x, pc.y - pc.bbox.y);
    const a = norm(pz.allowRotation ? pc.rotation : 0);
    return dist <= pz.snapDistance && Math.min(a, 360 - a) <= pz.snapAngle;
  }

  static async _place(msg) {
    const sender = game.users.get(msg.userId);
    if (!sender) return;
    const events = [];
    await this._mutate(all => {
      const pz = all[msg.puzzleId];
      const pc = pz?.pieces.find(p => p.id === msg.pieceId);
      if (!pz || !pc || pc.locked || pz.completed) return;
      if (pc.state === "tray" && !(sender.isGM || pc.ownerId === sender.id || pc.ownerId === "shared")) return;
      pc.state = "board";
      pc.x = Math.round(Number(msg.x) || 0);
      pc.y = Math.round(Number(msg.y) || 0);
      pc.rotation = pz.allowRotation ? norm(msg.rotation) : 0;
      if (this.isSnapped(pz, pc)) {
        pc.x = pc.bbox.x;
        pc.y = pc.bbox.y;
        pc.rotation = 0;
        pc.locked = true;
        events.push("snap");
        if (pz.pieces.every(p => p.locked)) {
          pz.completed = true;
          events.push("solved");
        }
      }
    });
    const pz = this.getPuzzle(msg.puzzleId);
    if (!pz) return;
    if (events.includes("snap")) {
      this.playSound(pz, "snap", true);
      this.broadcast({ type: "PIECE_SNAPPED", puzzleId: pz.id, pieceId: msg.pieceId });
    }
    if (events.includes("solved")) await this.handleSolved(pz);
  }

  static _rotate(msg) {
    return this._mutate(all => {
      const pz = all[msg.puzzleId];
      const pc = pz?.pieces.find(p => p.id === msg.pieceId);
      if (!pz || !pc || pc.locked || pc.state !== "board" || !pz.allowRotation) return;
      pc.rotation = norm(msg.rotation);
    });
  }

  static _return(msg) {
    const sender = game.users.get(msg.userId);
    return this._mutate(all => {
      const pz = all[msg.puzzleId];
      const pc = pz?.pieces.find(p => p.id === msg.pieceId);
      if (!sender || !pc || pc.locked || pc.state !== "board") return;
      const to = msg.toId;
      if (to === "shared") {
        pc.ownerId = "shared";
      } else if (to === sender.id) {
        if (!(sender.isGM || pc.ownerId === sender.id || pc.ownerId === "shared")) return;
        pc.ownerId = sender.id;
      } else return;
      pc.state = "tray";
    });
  }

  static async _transfer(msg) {
    const sender = game.users.get(msg.userId);
    const to = msg.toId;
    if (!sender || !(to === "shared" || game.users.get(to))) return;
    if (to !== "shared" && game.users.get(to).isGM && !sender.isGM) return;
    let moved = false;
    await this._mutate(all => {
      const pz = all[msg.puzzleId];
      const pc = pz?.pieces.find(p => p.id === msg.pieceId);
      if (!pc || pc.state !== "tray" || pc.ownerId === to) return;
      const allowed = sender.isGM || pc.ownerId === sender.id || (pc.ownerId === "shared" && to === sender.id);
      if (!allowed) return;
      pc.ownerId = to;
      moved = true;
    });
    if (!moved) return;
    const pz = this.getPuzzle(msg.puzzleId);
    this.playSound(pz, "pickup", true);
    this.broadcast({ type: "PIECE_TRANSFERRED", puzzleId: msg.puzzleId, fromId: sender.id, toId: to });
    if (to === sender.id) return; // taking a shared fragment needs no announcement
    const who = this.displayName(sender.id);
    const text = to === "shared"
      ? `${who} laid a fragment out for everyone.`
      : `${who} handed a fragment to ${this.displayName(to)}.`;
    ChatMessage.create({
      content: `<p class="kpa-chat"><i class="fa-solid fa-puzzle-piece"></i> <em>${foundry.utils.escapeHTML(text)}</em></p>`,
      speaker: { alias: "Puzzle" }
    });
  }

  /* -------------------------------------------------------------- */
  /*  Audio                                                          */
  /* -------------------------------------------------------------- */

  static playSound(puzzle, key, broadcast = false) {
    const src = puzzle?.sounds?.[key];
    if (!src) return;
    try {
      foundry.audio.AudioHelper.play({ src, volume: puzzle.sounds.volume ?? 0.8, autoplay: true, loop: false }, broadcast);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not play ${key} sound`, err);
    }
  }

  /* -------------------------------------------------------------- */
  /*  Completion / reward                                            */
  /* -------------------------------------------------------------- */

  static async handleSolved(pz) {
    this.playSound(pz, "solved", true);
    this.broadcast({ type: "PUZZLE_SOLVED", puzzleId: pz.id });
    if (!pz.rewardUuid) return;
    let doc = await fromUuid(pz.rewardUuid);
    if (doc?.documentName === "JournalEntryPage") doc = doc.parent;
    if (!doc) {
      ui.notifications.warn(`Puzzle "${pz.name}" solved, but its reward journal could not be found.`);
      return;
    }
    const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
    if ((doc.ownership?.default ?? 0) < OBSERVER) await doc.update({ "ownership.default": OBSERVER });
    this.broadcast({ type: "OPEN_JOURNAL", uuid: doc.uuid });
  }

  static async openJournal(uuid) {
    let doc = await fromUuid(uuid);
    if (!doc) {
      await new Promise(r => setTimeout(r, 600));
      doc = await fromUuid(uuid);
    }
    if (doc?.documentName === "JournalEntryPage") doc = doc.parent;
    if (doc?.testUserPermission(game.user, "OBSERVER")) doc.sheet.render({ force: true });
  }

  /* -------------------------------------------------------------- */
  /*  Handout / Item generators                                      */
  /* -------------------------------------------------------------- */

  static async createHandout(puzzleId) {
    const pz = this.getPuzzle(puzzleId);
    if (!pz) return null;
    const flags = { [MODULE_ID]: { puzzleId } };
    const html = `<div class="kpa-handout" data-puzzle-id="${puzzleId}">
<p>Fragments of something torn, broken or cut apart. Each of you may be holding pieces the others cannot see.</p>
<p><button type="button" class="kpa-open" data-puzzle-id="${puzzleId}"><i class="fa-solid fa-puzzle-piece"></i> Open Puzzle Assembly Board</button></p>
<div class="kpa-fragments" data-puzzle-id="${puzzleId}"></div>
</div>`;
    const entry = await JournalEntry.create({
      name: `${pz.name} Fragments`,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      flags,
      pages: [{
        name: pz.name,
        type: "text",
        text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1 },
        flags
      }]
    });
    await this._mutate(all => { if (all[puzzleId]) all[puzzleId].handoutUuid = entry.uuid; });
    ui.notifications.info(`Created handout journal "${entry.name}".`);
    return entry;
  }

  static itemTypes() {
    const dm = CONFIG.Item?.dataModels;
    const dt = game.system?.documentTypes?.Item;
    const sources = [
      ...Object.keys(dm && Object.keys(dm).length ? dm : {}),
      ...(Array.isArray(dt) ? dt : Object.keys(dt ?? {})),
      ...(game.documentTypes?.Item ?? [])
    ];
    return [...new Set(sources)].filter(t => t && t !== "base" && t !== CONST.BASE_DOCUMENT_TYPE);
  }

  static async createItem(puzzleId) {
    const pz = this.getPuzzle(puzzleId);
    if (!pz) return null;
    const types = this.itemTypes();
    const preferred = ["item", "object", "equipment", "gear", "loot", "misc", "book"];
    const type = preferred.find(t => types.includes(t)) ?? types[0];
    if (!type) {
      ui.notifications.error("This game system defines no Item types, so an inventory item cannot be created.");
      return null;
    }
    const item = await Item.create({
      name: `${pz.name} Fragments`,
      type,
      img: pz.image,
      flags: { [MODULE_ID]: { puzzleId } }
    });
    await this._mutate(all => { if (all[puzzleId]) all[puzzleId].itemUuid = item.uuid; });
    ui.notifications.info(`Created item "${item.name}" (${type}). Drag it onto an Investigator sheet; use its "Inspect Puzzle" header button.`);
    return item;
  }

  /* -------------------------------------------------------------- */
  /*  Handout journal decoration (per-viewer filtered thumbnails)    */
  /* -------------------------------------------------------------- */

  static async decorateHandout(root) {
    if (!root?.querySelectorAll) return;
    for (const box of root.querySelectorAll(".kpa-handout[data-puzzle-id]")) {
      const puzzleId = box.dataset.puzzleId;
      const target = box.querySelector(".kpa-fragments");
      if (!target) continue;
      const pz = this.getPuzzle(puzzleId);
      if (!pz) {
        target.innerHTML = "<p><em>This puzzle is no longer available.</em></p>";
        continue;
      }
      const tex = await this.getTextures(pz);
      const me = game.user.id;
      const mine = pz.pieces.filter(p => p.ownerId === me || p.ownerId === "shared");
      target.replaceChildren();
      if (!mine.length) {
        const p = document.createElement("p");
        p.className = "kpa-none";
        p.textContent = "You are not holding any fragments.";
        target.append(p);
        continue;
      }
      for (const piece of mine) {
        const img = document.createElement("img");
        img.className = "kpa-thumb" + (piece.state === "board" ? " kpa-placed" : "") + (piece.ownerId === "shared" ? " kpa-shared" : "");
        img.src = tex[piece.id] ?? "";
        img.alt = "Fragment";
        img.title = piece.state === "board" ? "Already on the mat" : piece.ownerId === "shared" ? "Shared with the party" : "Only you can see this fragment";
        target.append(img);
      }
    }
  }

  /* -------------------------------------------------------------- */
  /*  Refresh                                                        */
  /* -------------------------------------------------------------- */

  static refresh() {
    this.apps.forEach(a => a.refreshSoon?.());
    for (const app of [...this.handoutApps]) {
      if (!app.rendered) { this.handoutApps.delete(app); continue; }
      const el = app.element instanceof HTMLElement ? app.element : app.element?.[0];
      this.decorateHandout(el);
    }
  }
}
