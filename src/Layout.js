/**
 * Computes block positions, gap, and handles resize.
 * Knows nothing about rendering or animations.
 *
 * Owns a ResizeObserver on the container so layout stays in sync
 * with the element's rendered size. Consumers (e.g. Renderer) just
 * read `blocks`, `width`, `height` each frame — no subscription
 * needed.
 */
export class Layout {
  /**
   * @param {Object} params
   * @param {HTMLCanvasElement} params.container
   * @param {number} params.blockSize
   * @param {number} [params.countX] - fixed column count (omit when using step)
   * @param {number} [params.countY] - fixed row count (omit when using step)
   * @param {number} [params.step] - target block+gap step in px. When set,
   *   countX/countY are derived from container size on every recalculate,
   *   so the grid re-tiles itself on window resize.
   * @param {number} [params.fieldHeight] - optional override for the
   *   vertical extent used to compute block positions + countY. Defaults
   *   to the container's CSS height. Set this when the consumer wants
   *   blocks to span beyond the visible canvas (e.g. covering the full
   *   document height so they scroll with the page). Does NOT change
   *   canvas intrinsic size — the renderer still draws only into the
   *   viewport-sized canvas.
   * @param {number} [params.fieldWidth] - same idea for the horizontal axis.
   * @param {number} [params.minCountX=8]
   * @param {number} [params.minCountY=8]
   */
  constructor({ container, blockSize, countX, countY, step, fieldHeight, fieldWidth, minCountX, minCountY, mirrors = [] }) {
    /** @type {HTMLCanvasElement} */
    this.container = container
    // Extra plane canvases. They are never measured — `container` alone is
    // the authority on size — they are only kept at the same backing-store
    // resolution, so one lattice rasterises identically onto all of them.
    /** @type {HTMLCanvasElement[]} */
    this.mirrors = mirrors
    /** @type {number} */
    this.blockSize = blockSize
    /** @type {number|undefined} auto-count driver (block+gap target) */
    this.step = step
    /** @type {number|undefined} field dim overrides (see ctor JSDoc) */
    this.fieldHeight = fieldHeight
    this.fieldWidth = fieldWidth
    /** @type {number} */
    this.minCountX = minCountX ?? 8
    /** @type {number} */
    this.minCountY = minCountY ?? 8
    /** @type {number} */
    this.countX = countX ?? this.minCountX
    /** @type {number} */
    this.countY = countY ?? this.minCountY

    /**
     * Fires after recalculate() when countX or countY changed. Set by
     * Grid so it can refresh its public totals and notify consumers
     * (ScrollReveal, gridBridge subscribers) on resize-driven re-tiling.
     * @type {(() => void)|null}
     */
    this._onTopologyChange = null

    /**
     * The single gap, in CSS px, used on BOTH axes and as the outer
     * margin. Solved so the columns fit `effW` exactly (see recalculate).
     * @type {number}
     */
    this.gap = 0
    /** @type {number} blockSize + gap. The lattice period on both axes. */
    this.step_ = 0
    /** @type {number} CSS px offset of the first block's top-left corner */
    this.originX = 0
    /** @type {number} */
    this.originY = 0

    /** @deprecated aliases of `gap` — the two axes can no longer diverge. */
    this.gapX = 0
    this.gapY = 0

    /** @type {number} CSS pixel width */
    this.width = 0
    /** @type {number} CSS pixel height */
    this.height = 0

    /** @type {number} current devicePixelRatio (clamped to 2) */
    const _initialDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    this.dpr = Math.min(_initialDpr, 2)

    /**
     * Flat array of block descriptors. Shape per CLAUDE.md §6.
     * Positions are in CSS pixels — the Renderer handles DPR scaling.
     * @type {Array<{
     *   col: number,
     *   row: number,
     *   x: number,
     *   y: number,
     *   index: number,
     *   distFromCenter: number,
     * }>}
     */
    this.blocks = []

    /** @type {ResizeObserver|null} */
    this._ro = null

    /** @type {MediaQueryList|null} */
    this._dprMql = null

    /** @type {(() => void)|null} */
    this._dprHandler = null

    this.recalculate()
    this._observeResize()
    this._observeDpr()
  }

  /**
   * Recompute container size, gap, and block positions. Also syncs
   * the canvas's intrinsic width/height to its rendered size so
   * pixel coordinates match 1:1.
   *
   * Gap formula (per task spec):
   *   gap = (containerSize - count * blockSize) / (count + 1)
   */
  /**
   * Update grid parameters and recalculate. Any parameter not provided
   * keeps its current value. Returns true if totalBlocks changed
   * (countX or countY was modified), false otherwise.
   *
   * @param {Object} [params]
   * @param {number} [params.blockSize]
   * @param {number} [params.countX]
   * @param {number} [params.countY]
   * @returns {boolean} whether totalBlocks changed
   */
  reconfigure(params = {}) {
    const prevCountX = this.countX
    const prevCountY = this.countY
    if (params.blockSize !== undefined) this.blockSize = params.blockSize
    if (params.countX !== undefined) this.countX = params.countX
    if (params.countY !== undefined) this.countY = params.countY
    if (params.step !== undefined) this.step = params.step
    if (params.fieldHeight !== undefined) this.fieldHeight = params.fieldHeight
    if (params.fieldWidth !== undefined) this.fieldWidth = params.fieldWidth
    this.recalculate({ silent: true })
    return this.countX !== prevCountX || this.countY !== prevCountY
  }

  recalculate(opts = {}) {
    const rect = this.container.getBoundingClientRect()
    this.width = rect.width
    this.height = rect.height
    // DPR clamped to 2 to match prototype behavior — on 3x/4x displays the
    // cost of rendering at native density isn't worth the extra sharpness
    // for a field of 20px blocks, and canvas.width hits backing-store limits
    // on very large viewports.
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    this.dpr = Math.min(rawDpr, 2)

    // Canvas intrinsic resolution = CSS size × DPR for sharp rendering
    // on high-density displays. Block positions stay in CSS pixels;
    // the Renderer applies the DPR scale transform before drawing.
    this.container.width = Math.round(this.width * this.dpr)
    this.container.height = Math.round(this.height * this.dpr)
    for (let i = 0; i < this.mirrors.length; i++) {
      const m = this.mirrors[i]
      if (!m) continue
      m.width = this.container.width
      m.height = this.container.height
    }

    // Runaway guard, once per Layout. <canvas> is a REPLACED element: with
    // `width: auto` its CSS size is its INTRINSIC size, so `position: fixed;
    // inset: 0` (or any absolute box) does NOT stretch it. Since the line above
    // writes the intrinsic size, an unconstrained canvas immediately reports a
    // larger rect to the ResizeObserver, which recalculates, which writes a
    // larger intrinsic size — the canvas grows by a factor of `dpr` every pass
    // until the cell count melts the frame. There is no exception thrown and
    // nothing in the output points at CSS, so detect it and say so.
    if (!this._sizeChecked) {
      this._sizeChecked = true
      const after = this.container.getBoundingClientRect()
      if (Math.abs(after.width - this.width) > 1 || Math.abs(after.height - this.height) > 1) {
        console.warn(
          '[densitygrid] The canvas has no CSS size, so it is sizing itself from ' +
          'its width/height attributes and will grow without bound. Give it an ' +
          'explicit CSS size (e.g. `width:100vw;height:100vh` or `width:100%;height:100%`) — ' +
          '`position:fixed;inset:0` alone is not enough for a replaced element. ' +
          `Measured ${this.width}x${this.height}, became ${after.width}x${after.height}.`
        )
      }
    }

    // When fieldWidth / fieldHeight are provided, use them for block
    // layout (count derivation + gap + block positions). Canvas
    // intrinsic size still follows the container rect above — consumers
    // use this to make blocks span a document-sized area while the
    // canvas stays pinned to the viewport (e.g. blocks scroll with the
    // page through an offsetPosition animation, while the canvas layer
    // stays position:fixed).
    const effW = this.fieldWidth != null ? this.fieldWidth : this.width
    const effH = this.fieldHeight != null ? this.fieldHeight : this.height

    // --- Lattice solve --------------------------------------------------
    // Requirements, in priority order: square cells · ONE gap value used on
    // both axes and as the outer margin · no block ever clipped.
    //
    // Those cannot all hold while also fitting both axes exactly: that is 2
    // equations in 2 unknowns (blockSize, gap) whose determinant is
    // (countX - countY), which collapses toward zero on near-square fields
    // and sends blockSize/gap to absurd values (a 1000x1100 field at step 28
    // solves to blockSize 233, gap -200). So exact fit is claimed on ONE axis
    // only.
    //
    // X is the authoritative axis — width is the designed dimension (content
    // is laid out against it; the vertical axis scrolls). The gap is solved so
    // the columns tile `effW` exactly; the rows then take as many whole steps
    // as fit inside `effH`, and whatever is left over becomes extra outer
    // margin, split evenly top and bottom. blockSize is NOT solved: it stays
    // exactly as configured, so it never drifts when the field height changes.
    const prevCountX = this.countX
    const prevCountY = this.countY
    if (this.step && this.step > 0) {
      // round(), not floor() — the gap solve below absorbs the difference, so
      // rounding lands closer to the requested step than truncating does.
      let derivedX = Math.max(this.minCountX, Math.round(effW / this.step))
      // Guard: rounding up on a field barely wider than countX*blockSize can
      // drive the solved gap negative (blocks would overlap). Back off until
      // it is non-negative.
      while (derivedX > this.minCountX && effW - derivedX * this.blockSize < 0) {
        derivedX--
      }
      this.countX = derivedX
    }

    this.gap = (effW - this.countX * this.blockSize) / (this.countX + 1)
    if (!(this.gap >= 0)) this.gap = 0 // NaN / negative guard
    this.step_ = this.blockSize + this.gap
    this.gapX = this.gap
    this.gapY = this.gap

    if (this.step && this.step > 0) {
      const fit = this.step_ > 0 ? Math.floor((effH - this.gap) / this.step_) : this.minCountY
      this.countY = Math.max(this.minCountY, fit)
    }
    const topologyChanged =
      this.countX !== prevCountX || this.countY !== prevCountY

    // Center the vertical remainder as outer margin so the field is not
    // bottom-biased. Horizontally the solve is exact, so the margin IS the gap.
    const usedH = this.countY * this.blockSize + (this.countY + 1) * this.gap
    this.originX = this.gap
    this.originY = this.gap + Math.max(0, (effH - usedH) / 2)

    const centerCol = (this.countX - 1) / 2
    const centerRow = (this.countY - 1) / 2
    const maxDist = Math.sqrt(centerCol * centerCol + centerRow * centerRow)

    const blocks = new Array(this.countX * this.countY)
    let i = 0
    for (let row = 0; row < this.countY; row++) {
      for (let col = 0; col < this.countX; col++) {
        const x = this.originX + col * this.step_
        const y = this.originY + row * this.step_

        const dx = col - centerCol
        const dy = row - centerRow
        const dist = Math.sqrt(dx * dx + dy * dy)
        const distFromCenter = maxDist > 0 ? dist / maxDist : 0

        blocks[i] = {
          col,
          row,
          x,
          y,
          index: i,
          distFromCenter,
        }
        i++
      }
    }
    this.blocks = blocks

    // Notify Grid of topology change driven by ResizeObserver / DPR
    // events. `silent` is set by reconfigure() which routes the
    // notification through Grid.reconfigure() instead.
    if (topologyChanged && !opts.silent && typeof this._onTopologyChange === 'function') {
      this._onTopologyChange()
    }
  }

  /**
   * @returns {number} total number of blocks (countX * countY)
   */
  getTotalBlocks() {
    return this.countX * this.countY
  }

  /**
   * CSS-pixel top-left of a cell. Inverse of `cellRectFromPx`.
   *
   * @param {number} col
   * @param {number} row
   * @returns {{x: number, y: number}}
   */
  cellToPx(col, row) {
    return { x: this.originX + col * this.step_, y: this.originY + row * this.step_ }
  }

  /**
   * Snap a CSS-pixel rectangle to the lattice, returning the cell range it
   * covers. Used to anchor a Field to a DOM element: the field's area is
   * always whole cells, so its contents stay phase-locked with the rest of
   * the grid no matter where the element happens to land.
   *
   * Clamped to the lattice, so an element partly off-field yields a clipped
   * (possibly empty, cols/rows = 0) range rather than out-of-range indices.
   *
   * @param {number} x CSS px
   * @param {number} y CSS px
   * @param {number} w CSS px
   * @param {number} h CSS px
   * @returns {{col: number, row: number, cols: number, rows: number}}
   */
  cellRectFromPx(x, y, w, h) {
    const s = this.step_ || 1
    const col0 = Math.round((x - this.originX) / s)
    const row0 = Math.round((y - this.originY) / s)
    const col1 = Math.round((x + w - this.originX) / s)
    const row1 = Math.round((y + h - this.originY) / s)
    const col = Math.max(0, Math.min(this.countX, col0))
    const row = Math.max(0, Math.min(this.countY, row0))
    return {
      col,
      row,
      cols: Math.max(0, Math.min(this.countX, col1) - col),
      rows: Math.max(0, Math.min(this.countY, row1) - row),
    }
  }

  /**
   * Stop observing resize and DPR changes. Call when grid is torn down.
   */
  destroy() {
    if (this._ro) {
      this._ro.disconnect()
      this._ro = null
    }
    if (this._dprMql && this._dprHandler) {
      this._dprMql.removeEventListener('change', this._dprHandler)
      this._dprMql = null
      this._dprHandler = null
    }
  }

  /**
   * @private
   */
  _observeResize() {
    if (typeof ResizeObserver === 'undefined') return
    this._ro = new ResizeObserver(() => this.recalculate())
    this._ro.observe(this.container)
  }

  /**
   * Watch for devicePixelRatio changes (e.g. moving the window to a
   * monitor with different scaling, or the user changing OS display
   * scaling). Uses matchMedia with a query that matches the current
   * DPR — when it stops matching, DPR has changed.
   * @private
   */
  _observeDpr() {
    if (typeof window === 'undefined' || typeof matchMedia === 'undefined') return

    const subscribe = () => {
      // Clean up previous listener if any
      if (this._dprMql && this._dprHandler) {
        this._dprMql.removeEventListener('change', this._dprHandler)
      }

      const dpr = window.devicePixelRatio || 1
      this._dprMql = matchMedia(`(resolution: ${dpr}dppx)`)
      this._dprHandler = () => {
        this.recalculate()
        // Re-subscribe with the new DPR value
        subscribe()
      }
      this._dprMql.addEventListener('change', this._dprHandler)
    }

    subscribe()
  }
}
