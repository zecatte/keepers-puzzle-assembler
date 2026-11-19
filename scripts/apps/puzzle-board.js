/**
 * Keeper's Puzzle Assembler - the shared assembly table (ApplicationV2).
 */
import { MODULE_ID, SOCKET, PuzzleManager } from "../puzzle-manager.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const THUMB = 82;
const norm = deg => ((Math.round(deg) % 360) + 360) % 360;

export class PuzzleBoard extends HandlebarsApplicationMixin(ApplicationV2) {
  static instances = new Map();

  static DEFAULT_OPTIONS = {
    classes: ["kpa-app", "kpa-board-app"],
    window: { title: "Puzzle Assembly Board", icon: "fa-solid fa-puzzle-piece", resizable: true },
    position: { width: 1060, height: 740 },
    actions: {
      zoomIn: PuzzleBoard.onZoomIn,
      zoomOut: PuzzleBoard.onZoomOut,
      zoomFit: PuzzleBoard.onZoomFit,
      giveMenu: PuzzleBoard.onGiveMenu,
      sharePiece: PuzzleBoard.onSharePiece,
      takePiece: PuzzleBoard.onTakePiece,
      openReward: PuzzleBoard.onOpenReward,
      openCreator: PuzzleBoard.onOpenCreator
    }
  };

  static PARTS = {
    board: { template: `modules/${MODULE_ID}/templates/puzzle-board.hbs` }
  };

  static open(puzzleId) {
    if (!PuzzleManager.getPuzzle(puzzleId)) {
      ui.notifications.warn("That puzzle no longer exists.");
      return null;
    }
    let app = this.instances.get(puzzleId);
    if (!app) {
      app = new this({ id: `kpa-board-${puzzleId}`, puzzleId });
      this.instances.set(puzzleId, app);
    }
    app.render({ force: true });
    return app;
  }

  constructor(options = {}) {
    super(options);
    this.puzzleId = options.puzzleId;
    this.zoom = null;
    this._drag = null;
    this._hover = null;
    this._scroll = null;
    this._bound = false;
    this._refreshTimer = null;
    this._remoteDragTimers = new Map();
  }

  get puzzle() {
    return PuzzleManager.getPuzzle(this.puzzleId);
  }

  get title() {
    return this.puzzle?.name ?? "Puzzle Assembly Board";
  }

  /* -------------------------------------------------------------- */
  /*  Context                                                        */
  /* -------------------------------------------------------------- */

  _geometry(pz) {
    const pad = Math.round(Math.max(pz.width, pz.height) * 0.35);
    return { pad, matW: pz.width + pad * 2, matH: pz.height + pad * 2 };
  }

  async _prepareContext() {
    const pz = this.puzzle;
    if (!pz) return { missing: true };
    const tex = await PuzzleManager.getTextures(pz);
    const { pad, matW, matH } = this._geometry(pz);
    if (!this.zoom) {
      const z = Math.min(1, (this.position.width - 320) / matW, (this.position.height - 130) / matH);
      this.zoom = Math.max(0.25, Math.round(z * 100) / 100);
    }
    const isGM = game.user.isGM;
    const view = PuzzleManager.view(pz);

    const thumb = p => {
      const s = THUMB / Math.max(p.bbox.w, p.bbox.h);
      return {
        id: p.id,
        src: tex[p.id] ?? "",
        tw: Math.max(14, Math.round(p.bbox.w * s)),
        th: Math.max(14, Math.round(p.bbox.h * s)),
        rotation: p.rotation
      };
    };
    const onMat = p => ({
      id: p.id,
      src: tex[p.id] ?? "",
      left: pad + p.x,
      top: pad + p.y,
      w: p.bbox.w,
      h: p.bbox.h,
      rotation: p.rotation,
      locked: p.locked
    });

    const lockedCount = pz.pieces.filter(p => p.locked).length;
    return {
      puzzleId: pz.id,
      name: pz.name,
      isGM,
      completed: !!pz.completed,
      hasReward: !!pz.rewardUuid,
      allowRotation: pz.allowRotation,
      rotationStep: pz.rotationStep,
      locked: lockedCount,
      total: pz.pieces.length,
      percent: Math.round((lockedCount / pz.pieces.length) * 100),
      zoom: this.zoom,
      pad,
      matW,
      matH,
      sizerW: Math.round(matW * this.zoom),
      sizerH: Math.round(matH * this.zoom),
      frame: { left: pad, top: pad, w: pz.width, h: pz.height },
      showGhost: pz.showGhost,
      imageUrl: PuzzleManager.imageUrl(pz),
      myPieces: view.mine.map(thumb),
      sharedPieces: view.shared.map(thumb),
      boardPieces: view.board.map(onMat),
      holders: view.holders.map(h => ({ name: h.name, count: h.count, plural: h.count !== 1 })),
      overview: view.overview.map(g => ({ name: g.name, userId: g.userId, pieces: g.pieces.map(thumb) }))
    };
  }

  /* -------------------------------------------------------------- */
  /*  Render lifecycle                                               */
  /* -------------------------------------------------------------- */

  async _preRender(context, options) {
    await super._preRender?.(context, options);
    const wrap = this.element?.querySelector?.(".kpa-mat-wrap");
    const trays = this.element?.querySelector?.(".kpa-trays");
    this._scroll = {
      mat: wrap ? [wrap.scrollLeft, wrap.scrollTop] : null,
      trays: trays ? trays.scrollTop : 0
    };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    PuzzleManager.apps.add(this);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    if (this._scroll) {
      const wrap = el.querySelector(".kpa-mat-wrap");
      if (wrap && this._scroll.mat) [wrap.scrollLeft, wrap.scrollTop] = this._scroll.mat;
      const trays = el.querySelector(".kpa-trays");
      if (trays) trays.scrollTop = this._scroll.trays;
    }
    if (this._bound) return;
    this._bound = true;
    el.addEventListener("pointerdown", ev => this._onPointerDown(ev));
    el.addEventListener("contextmenu", ev => this._onContextMenu(ev));
    el.addEventListener("wheel", ev => this._onWheel(ev), { passive: false });
    el.addEventListener("pointerover", ev => {
      this._hover = ev.target.closest?.(".kpa-mat-piece")?.dataset.pieceId ?? null;
    });
    this._onKeyDown = ev => this._handleKey(ev);
    window.addEventListener("keydown", this._onKeyDown);
  }

  async _onClose(options) {
    PuzzleManager.apps.delete(this);
    PuzzleBoard.instances.delete(this.puzzleId);
    window.removeEventListener("keydown", this._onKeyDown ?? (() => {}));
    this._cancelDrag();
    return super._onClose?.(options);
  }

  refreshSoon() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      if (!this.rendered) return;
      if (!this.puzzle) { this.close(); return; }
      this.render({ parts: ["board"] });
    }, 40);
  }

  /* -------------------------------------------------------------- */
  /*  Zoom + toolbar actions                                         */
  /* -------------------------------------------------------------- */

  _setZoom(z) {
    this.zoom = Math.min(2, Math.max(0.2, Math.round(z * 100) / 100));
    const pz = this.puzzle;
    if (!pz) return;
    const { matW, matH } = this._geometry(pz);
    const mat = this.element.querySelector(".kpa-mat");
    const sizer = this.element.querySelector(".kpa-mat-sizer");
    if (mat) mat.style.transform = `scale(${this.zoom})`;
    if (sizer) {
      sizer.style.width = `${Math.round(matW * this.zoom)}px`;
      sizer.style.height = `${Math.round(matH * this.zoom)}px`;
    }
  }

  static onZoomIn() { this._setZoom(this.zoom * 1.15); }
  static onZoomOut() { this._setZoom(this.zoom / 1.15); }
  static onZoomFit() {
    const pz = this.puzzle;
    const wrap = this.element.querySelector(".kpa-mat-wrap");
    if (!pz || !wrap) return;
    const { matW, matH } = this._geometry(pz);
    this._setZoom(Math.min(wrap.clientWidth / matW, wrap.clientHeight / matH) * 0.98);
  }
  static onOpenCreator() {
    game.modules.get(MODULE_ID)?.api?.openCreator?.(this.puzzleId);
  }
  static onOpenReward() {
    const uuid = this.puzzle?.rewardUuid;
    if (uuid) PuzzleManager.openJournal(uuid);
  }

  /* -------------------------------------------------------------- */
  /*  Piece actions (tray buttons / menu)                            */
  /* -------------------------------------------------------------- */

  static onGiveMenu(event, target) {
    event.preventDefault();
    const pieceId = target.closest("[data-piece-id]")?.dataset.pieceId;
    if (pieceId) this._showGiveMenu(pieceId, event.clientX, event.clientY);
  }

  static onSharePiece(event, target) {
    const pieceId = target.closest("[data-piece-id]")?.dataset.pieceId;
    if (pieceId) PuzzleManager.request("TRANSFER_PIECE", { puzzleId: this.puzzleId, pieceId, toId: "shared" });
  }

  static onTakePiece(event, target) {
    const pieceId = target.closest("[data-piece-id]")?.dataset.pieceId;
    if (pieceId) PuzzleManager.request("TRANSFER_PIECE", { puzzleId: this.puzzleId, pieceId, toId: game.user.id });
  }

  _closeMenu() {
    this.element?.querySelectorAll(".kpa-menu").forEach(m => m.remove());
    if (this._menuCloser) window.removeEventListener("pointerdown", this._menuCloser, true);
    this._menuCloser = null;
  }

  _showGiveMenu(pieceId, x, y) {
    this._closeMenu();
    const menu = document.createElement("div");
    menu.className = "kpa-menu";
    const head = document.createElement("div");
    head.className = "kpa-menu-head";
    head.textContent = "Hand this fragment to…";
    menu.append(head);
    const add = (label, toId, icon) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<i class="fa-solid ${icon}"></i> `;
      b.append(document.createTextNode(label));
      b.addEventListener("click", () => {
        this._closeMenu();
        PuzzleManager.request("TRANSFER_PIECE", { puzzleId: this.puzzleId, pieceId, toId });
      });
      menu.append(b);
    };
    for (const u of PuzzleManager.players()) {
      if (u.id === game.user.id) continue;
      add(`${PuzzleManager.displayName(u.id)}${u.active ? "" : " (offline)"}`, u.id, "fa-user");
    }
    add("Share with everyone (Party Pool)", "shared", "fa-users");
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    document.body.append(menu);
    this._menuEl = menu;
    this._menuCloser = ev => {
      if (menu.contains(ev.target)) return;
      menu.remove();
      window.removeEventListener("pointerdown", this._menuCloser, true);
    };
    window.addEventListener("pointerdown", this._menuCloser, true);
  }

  /* -------------------------------------------------------------- */
  /*  Pointer handling                                               */
  /* -------------------------------------------------------------- */

  _matRect() {
    return this.element.querySelector(".kpa-mat")?.getBoundingClientRect();
  }

  _onPointerDown(ev) {
    if (ev.button !== 0) return;
    if (ev.target.closest("button, .kpa-menu, select, input, a")) return;
    const el = ev.target.closest(".kpa-piece");
    if (!el || el.classList.contains("kpa-locked")) return;
    ev.preventDefault();
    this._closeMenu();
    this._startDrag(el, ev);
  }

  _startDrag(el, ev) {
    const pz = this.puzzle;
    const piece = pz?.pieces.find(p => p.id === el.dataset.pieceId);
    if (!piece || piece.locked || pz.completed) return;
    const fromMat = el.classList.contains("kpa-mat-piece");
    const fromTray = el.closest("[data-tray]")?.dataset.tray ?? null;
    const zoom = this.zoom;
    const ghost = document.createElement("img");
    ghost.className = "kpa-ghost";
    ghost.src = el.querySelector("img")?.src ?? "";
    ghost.draggable = false;
    ghost.style.width = `${piece.bbox.w * zoom}px`;
    ghost.style.height = `${piece.bbox.h * zoom}px`;
    let offX = 0;
    let offY = 0;
    if (fromMat) {
      const r = el.getBoundingClientRect();
      offX = ev.clientX - (r.left + r.width / 2);
      offY = ev.clientY - (r.top + r.height / 2);
      el.classList.add("kpa-dragging");
    }
    this._drag = {
      pieceId: piece.id,
      w: piece.bbox.w,
      h: piece.bbox.h,
      rotation: piece.rotation,
      fromMat,
      fromTray,
      offX,
      offY,
      ghost,
      el,
      lastSend: 0,
      last: { x: ev.clientX, y: ev.clientY }
    };
    document.body.append(ghost);
    this._moveGhost(ev);
    this._dragMove = e => this._onDragMove(e);
    this._dragUp = e => this._onDragEnd(e);
    window.addEventListener("pointermove", this._dragMove);
    window.addEventListener("pointerup", this._dragUp);
    PuzzleManager.playSound(pz, "pickup", false);
  }

  _ghostCenter(d, ev) {
    return { cx: ev.clientX - d.offX, cy: ev.clientY - d.offY };
  }

  _moveGhost(ev) {
    const d = this._drag;
    if (!d) return;
    const { cx, cy } = this._ghostCenter(d, ev);
    d.last = { x: ev.clientX, y: ev.clientY };
    d.ghost.style.left = `${cx - (d.w * this.zoom) / 2}px`;
    d.ghost.style.top = `${cy - (d.h * this.zoom) / 2}px`;
    d.ghost.style.transform = `rotate(${d.rotation}deg)`;
  }

  /** Convert a screen-space centre to piece top-left in frame coordinates. */
  _toFrame(d, cx, cy) {
    const pz = this.puzzle;
    const rect = this._matRect();
    const { pad, matW, matH } = this._geometry(pz);
    let x = (cx - rect.left) / this.zoom - pad - d.w / 2;
    let y = (cy - rect.top) / this.zoom - pad - d.h / 2;
    x = Math.min(matW - pad - d.w, Math.max(-pad, x));
    y = Math.min(matH - pad - d.h, Math.max(-pad, y));
    return { x: Math.round(x), y: Math.round(y) };
  }

  _onDragMove(ev) {
    const d = this._drag;
    if (!d) return;
    this._moveGhost(ev);
    if (d.fromMat && ev.timeStamp - d.lastSend > 60) {
      d.lastSend = ev.timeStamp;
      this._sendDrag(d, ev);
    }
  }

  _sendDrag(d, ev) {
    const { cx, cy } = this._ghostCenter(d, ev);
    const { x, y } = this._toFrame(d, cx, cy);
    game.socket.emit(SOCKET, {
      type: "DRAG_PIECE",
      userId: game.user.id,
      puzzleId: this.puzzleId,
      pieceId: d.pieceId,
      x,
      y,
      rotation: d.rotation
    });
  }

  _onDragEnd(ev) {
    const d = this._drag;
    if (!d) return;
    const pz = this.puzzle;
    const { cx, cy } = this._ghostCenter(d, ev);
    d.ghost.style.pointerEvents = "none";
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const inApp = this.element.contains(target);
    const me = game.user.id;
    const base = { puzzleId: this.puzzleId, pieceId: d.pieceId };
    this._cancelDrag();
    if (!pz || !inApp) return;

    if (target.closest(".kpa-mat-wrap")) {
      const { x, y } = this._toFrame(d, cx, cy);
      PuzzleManager.request("PLACE_PIECE", { ...base, x, y, rotation: d.rotation });
    } else if (target.closest('[data-tray="private"]')) {
      if (d.fromMat) PuzzleManager.request("RETURN_PIECE", { ...base, toId: me });
      else if (d.fromTray !== "private") PuzzleManager.request("TRANSFER_PIECE", { ...base, toId: me });
    } else if (target.closest('[data-tray="shared"]')) {
      if (d.fromMat) PuzzleManager.request("RETURN_PIECE", { ...base, toId: "shared" });
      else if (d.fromTray !== "shared") PuzzleManager.request("TRANSFER_PIECE", { ...base, toId: "shared" });
    }
  }

  _cancelDrag() {
    const d = this._drag;
    if (!d) return;
    d.ghost.remove();
    d.el?.classList?.remove("kpa-dragging");
    window.removeEventListener("pointermove", this._dragMove);
    window.removeEventListener("pointerup", this._dragUp);
    this._drag = null;
  }

  /* -------------------------------------------------------------- */
  /*  Rotation (right-click / R / wheel)                             */
  /* -------------------------------------------------------------- */

  _rotateBy(dir) {
    const pz = this.puzzle;
    if (!pz?.allowRotation) return false;
    const step = pz.rotationStep || 45;
    if (this._drag) {
      this._drag.rotation = norm(this._drag.rotation + dir * step);
      this._moveGhost({ clientX: this._drag.last.x, clientY: this._drag.last.y });
      PuzzleManager.playSound(pz, "pickup", false);
      if (this._drag.fromMat) this._sendDrag(this._drag, { clientX: this._drag.last.x, clientY: this._drag.last.y });
      return true;
    }
    const piece = this._hover ? pz.pieces.find(p => p.id === this._hover) : null;
    if (!piece || piece.locked || piece.state !== "board") return false;
    PuzzleManager.playSound(pz, "pickup", false);
    PuzzleManager.request("ROTATE_PIECE", {
      puzzleId: pz.id,
      pieceId: piece.id,
      rotation: norm(piece.rotation + dir * step)
    });
    return true;
  }

  _onWheel(ev) {
    if (!this._drag && !ev.target.closest(".kpa-mat-piece")) return;
    if (this._rotateBy(ev.deltaY > 0 ? 1 : -1)) ev.preventDefault();
  }

  _handleKey(ev) {
    if (ev.key?.toLowerCase() !== "r" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t?.matches?.("input, textarea, select, [contenteditable]")) return;
    if (!this.rendered || (!this._drag && !this._hover)) return;
    if (this._rotateBy(ev.shiftKey ? -1 : 1)) ev.preventDefault();
  }

  _onContextMenu(ev) {
    const pieceEl = ev.target.closest(".kpa-piece");
    if (!this._drag && !pieceEl) return;
    ev.preventDefault();
    if (this._drag || pieceEl.classList.contains("kpa-mat-piece")) {
      if (pieceEl && !this._drag) this._hover = pieceEl.dataset.pieceId;
      this._rotateBy(1);
    } else {
      this._showGiveMenu(pieceEl.dataset.pieceId, ev.clientX, ev.clientY);
    }
  }

  /* -------------------------------------------------------------- */
  /*  Remote events                                                  */
  /* -------------------------------------------------------------- */

  applyRemoteDrag(msg) {
    if (msg.puzzleId !== this.puzzleId || !this.rendered) return;
    const el = this.element.querySelector(`.kpa-mat-piece[data-piece-id="${msg.pieceId}"]`);
    const pz = this.puzzle;
    if (!el || !pz || el.classList.contains("kpa-locked")) return;
    const { pad } = this._geometry(pz);
    el.style.left = `${pad + msg.x}px`;
    el.style.top = `${pad + msg.y}px`;
    el.style.transform = `rotate(${msg.rotation}deg)`;
    el.classList.add("kpa-remote-dragging");
    clearTimeout(this._remoteDragTimers.get(msg.pieceId));
    this._remoteDragTimers.set(msg.pieceId, setTimeout(() => el.classList.remove("kpa-remote-dragging"), 400));
  }

  flashSnap(msg) {
    if (msg.puzzleId !== this.puzzleId) return;
    setTimeout(() => {
      const el = this.element?.querySelector?.(`.kpa-mat-piece[data-piece-id="${msg.pieceId}"]`);
      if (!el) return;
      el.classList.add("kpa-snap-flash");
      setTimeout(() => el.classList.remove("kpa-snap-flash"), 900);
    }, 120);
  }

  celebrate(msg) {
    if (msg.puzzleId !== this.puzzleId) return;
    setTimeout(() => this.element?.querySelector?.(".kpa-mat")?.classList.add("kpa-solved", "kpa-solved-anim"), 160);
  }
}
