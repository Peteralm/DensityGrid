import { Layout } from './Layout.js'
import { Renderer } from './Renderer.js'
import { Field, FieldStack } from './Field.js'

/**
 * Main grid class. Wires up Layout, FieldStack and Renderer and exposes the
 * public API described in CLAUDE.md §6.
 *
 * Instances are created through createGrid() in index.js — consumers
 * (e.g. gridBridge.js in the site project) should never new this
 * class directly.
 *
 * THERE IS ONE MODEL: fields PUSH cells. A producer calls `write()` for the
 * cells it occupies and the FieldStack resolves the contested ones. The
 * library used to carry a second, PULL model as well — a per-block animation
 * stack that the renderer walked every frame, asking each of ~25k block
 * descriptors what it looked like now — and it had been unreachable for some
 * time: registering a single Field switched the renderer onto the field path
 * and the block path was never taken again. It was removed rather than fixed,
 * because two models is the actual defect. Its cost was not hypothetical: a
 * descriptor array rebuilt on every resize, for a path nothing could run.
 *
 * Ownership:
 *   Grid owns Layout, FieldStack and Renderer. Layout owns its own
 *   ResizeObserver. Renderer owns the rAF loop. Grid just wires them
 *   together and surfaces the public API.
 */
export class Grid {
  /**
   * @param {Object} options
   * @param {HTMLCanvasElement} options.container
   * @param {number} options.blockSize
   * @param {number} [options.countX] - fixed column count (omit when using step)
   * @param {number} [options.countY] - fixed row count (omit when using step)
   * @param {number} [options.step] - block+gap target in px. When set, the
   *   grid re-tiles itself on window resize so block density stays roughly
   *   constant. Subscribe via `grid.onResize(cb)` to rebuild any buffers
   *   that are keyed by block.index or countX/countY.
   * @param {number} [options.minCountX]
   * @param {number} [options.minCountY]
   * @param {number} options.fieldHeight - REQUIRED. The document's full
   *   scroll height; the lattice spans it. See Layout.
   * @param {number} options.fieldWidth - REQUIRED. The page's content width.
   * @param {Object<string, HTMLCanvasElement>} [options.planes] - extra raster
   *   targets keyed by name, e.g. `{ over: canvasEl }`. A Field picks one via
   *   `plane`; anything not named lands on `container` ('base'). All planes
   *   share ONE Layout, so the lattice, its origin and its phase are identical
   *   across them — the split is purely about where in the page's stacking
   *   order the cells are painted, which is what lets DOM content be
   *   sandwiched between fields. The consumer positions the canvases and
   *   declares which band of the document each covers, via `setPlaneBox`.
   */
  constructor({ container, blockSize, countX, countY, step, fieldHeight, fieldWidth, minCountX, minCountY, cornerRadius = 0, planes = null }) {
    /** @private @type {Array<() => void>} */
    this._resizeCbs = []

    // Extra raster planes, keyed by name, so a Field can declare which canvas
    // it lands on. `container` is always 'base'. This exists for exactly one
    // reason: page content has to be able to sit BETWEEN two fields, and one
    // canvas cannot express that. See Field.plane. Layout no longer sees them:
    // planes do not share a size any more — each covers its own band — so
    // there is nothing left to mirror.

    /** @private @type {Layout} */
    this._layout = new Layout({
      container,
      blockSize,
      countX,
      countY,
      step,
      fieldHeight,
      fieldWidth,
      minCountX,
      minCountY,
    })
    // Layout may have derived counts from step + container size, so pull
    // the authoritative values back out.
    /** @type {number} block size in px */
    this.blockSize = this._layout.blockSize
    /** @type {number} number of blocks on the X axis */
    this.countX = this._layout.countX
    /** @type {number} number of blocks on the Y axis */
    this.countY = this._layout.countY
    /** @type {number} countX * countY */
    this.totalBlocks = this.countX * this.countY

    // Wire topology-change notifications from Layout → Grid so a window
    // resize (or DPR change that alters derived counts) refreshes the
    // public totals and fans out to subscribers.
    this._layout._onTopologyChange = () => this._handleTopologyChange()
    /** @private @type {FieldStack} */
    this._fields = new FieldStack()
    /** @private @type {Renderer} */
    this._renderer = new Renderer({
      container,
      layout: this._layout,
      fields: this._fields,
      cornerRadius,
      planes,
    })

    // Public debug namespace. Frozen so consumers can safely destructure.
    const fieldStack = this._fields
    /** @type {{ fields: () => Array<Object> }} */
    this.debug = Object.freeze({
      fields: () => fieldStack.list(),
    })

    // Start the render loop immediately. With no fields registered it draws
    // an empty frame, which is the correct picture of an empty lattice.
    this._renderer.start()
  }

  /**
   * Register a Field — a region of the lattice with its own producer,
   * stacking order and merge rule. See Field.js.
   *
   * @param {Object} params - see the Field constructor
   * @returns {Field}
   */
  addField(params) {
    const field = new Field(params)
    this._fields.add(field)
    return field
  }

  /**
   * @param {Field} field
   */
  removeField(field) {
    this._fields.remove(field)
  }

  /**
   * The lattice geometry fields need in order to place themselves. All of it
   * is DOCUMENT space: `originY` is measured from the top of the page, and a
   * row index means the same document position no matter what is on screen.
   * @returns {{cols:number, rows:number, step:number, blockSize:number, gap:number, originX:number, originY:number, docHeight:number}}
   */
  get lattice() {
    const l = this._layout
    return {
      cols: l.countX,
      rows: l.countY,
      step: l.step_,
      blockSize: l.blockSize,
      gap: l.gap,
      originX: l.originX,
      originY: l.originY,
      docHeight: l.fieldHeight,
    }
  }

  /**
   * Where a plane's canvas sits in the document, in CSS px. The renderer
   * translates by this, so a cell lands at its document position no matter
   * which band rasterises it — and sizes the canvas's backing store to match.
   *
   * A resize-time fact. It does not change when the page scrolls, which is
   * the entire reason the lattice moved into document space.
   *
   * @param {string} name plane name; 'base' is the container canvas
   * @param {{top: number, height: number}} box
   */
  setPlaneBox(name, box) {
    this._renderer.setPlaneBox(name, box)
  }

  /**
   * Snap a CSS-pixel box (canvas space) to whole cells. Use to keep a field
   * anchored to a DOM section across resize.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @returns {{col:number,row:number,cols:number,rows:number}}
   */
  cellRectFromPx(x, y, w, h) {
    return this._layout.cellRectFromPx(x, y, w, h)
  }

  /**
   * Re-solve the lattice. Fields are untouched: they are keyed by cell, so a
   * new topology simply means their producers write into a different number
   * of cells on the next frame. Anything the CONSUMER keys by cell has to
   * rebuild itself, which is what `onResize` is for.
   *
   * @param {Object} params
   * @param {number} [params.blockSize]
   * @param {number} [params.countX]
   * @param {number} [params.countY]
   * @param {number} [params.fieldWidth]
   * @param {number} [params.fieldHeight]
   */
  reconfigure(params) {
    const topologyChanged = this._layout.reconfigure(params)
    this.blockSize = this._layout.blockSize
    this.countX = this._layout.countX
    this.countY = this._layout.countY
    this.totalBlocks = this.countX * this.countY
    if (topologyChanged) {
      this._fireResize()
    }
    // A re-solved lattice resizes backing stores, and resizing a canvas
    // clears it. Draw a fresh frame synchronously so nobody sees a one-frame
    // blank while waiting for the next rAF.
    this.forceDraw()
  }

  /**
   * Start the internal rAF loop. It is already running after construction —
   * call this only after `stop()`.
   */
  start() {
    this._renderer.start()
  }

  /**
   * Stop the internal rAF loop and take over the cadence yourself, pairing
   * this with `forceDraw()`.
   *
   * A consumer that drives a camera has to: advance the camera, then project,
   * then draw — in that order, every frame. Leaving the grid on its own rAF
   * puts those in two independent callbacks, so the draw can run against the
   * previous frame's camera. That reads as a one-frame lag on every motion.
   */
  stop() {
    this._renderer.stop()
  }

  /** @type {number} block corner radius in px. 0 = square corners. */
  get cornerRadius() {
    return this._renderer.cornerRadius
  }

  set cornerRadius(px) {
    this._renderer.cornerRadius = px
  }

  /**
   * Draw one frame synchronously. Normally the render loop handles this on
   * its own rAF cadence — use this only when you've just resized the canvas
   * (which clears it) and want to avoid the gap before the next rAF fires.
   */
  forceDraw() {
    this._renderer._draw(typeof performance !== 'undefined' ? performance.now() : Date.now())
  }

  /**
   * Subscribe to topology changes (countX or countY changed). Fires when
   * the ResizeObserver detects a container size change that shifts
   * derived counts (step mode) or when reconfigure() changes the grid.
   * Does NOT fire for gap-only rebalances when counts stay the same.
   *
   * Use this to rebuild any per-block buffers that are keyed by
   * block.index (typed arrays, Maps, etc).
   *
   * @param {() => void} cb
   * @returns {() => void} unsubscribe
   */
  onResize(cb) {
    if (typeof cb !== 'function') return () => {}
    this._resizeCbs.push(cb)
    return () => {
      const i = this._resizeCbs.indexOf(cb)
      if (i >= 0) this._resizeCbs.splice(i, 1)
    }
  }

  /** @private */
  _handleTopologyChange() {
    this.blockSize = this._layout.blockSize
    this.countX = this._layout.countX
    this.countY = this._layout.countY
    this.totalBlocks = this.countX * this.countY
    this._fireResize()
    // Layout just resized canvas.width/height → canvas cleared. Redraw now
    // instead of waiting for the next rAF (visible gap during drag-resize).
    this.forceDraw()
  }

  /** @private */
  _fireResize() {
    const list = this._resizeCbs.slice()
    for (let i = 0; i < list.length; i++) {
      try {
        list[i]()
      } catch (_) {
        // Swallow: one bad subscriber shouldn't block the others.
      }
    }
  }
}
