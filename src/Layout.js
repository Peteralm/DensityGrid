/**
 * Computes block positions, gap, and handles resize.
 * Knows nothing about rendering or animations.
 *
 * THE LATTICE IS DOCUMENT SPACE. `fieldWidth`/`fieldHeight` are the page's
 * content width and its full scroll height, and they are the only inputs to
 * the solve — no canvas is measured for geometry any more. The canvases that
 * rasterise the lattice each cover a BAND of the document, and the Renderer
 * translates into its band; sizing them is its job, not this class's.
 *
 * That is the whole point of the arrangement. A lattice defined against the
 * viewport has to be re-placed every frame from a scroll position the main
 * thread learns about a frame late, which is a visible slip between the cells
 * and the content they are locked to. Document coordinates have no scroll
 * term, so there is nothing to be late about.
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
   * @param {number} params.fieldHeight - REQUIRED. The document's full
   *   scroll height. The lattice spans it, so `countY` is a document row
   *   count, not a viewport one.
   * @param {number} params.fieldWidth - REQUIRED. The page's content width.
   * @param {number} [params.minCountX=8]
   * @param {number} [params.minCountY=8]
   */
  constructor({ container, blockSize, countX, countY, step, fieldHeight, fieldWidth, minCountX, minCountY }) {
    /**
     * Kept only so the ResizeObserver has something to watch. Nothing about
     * the lattice is derived from it.
     * @type {HTMLCanvasElement}
     */
    this.container = container
    /** @type {number} */
    this.blockSize = blockSize
    /** @type {number|undefined} auto-count driver (block+gap target) */
    this.step = step
    /** @type {number} the document extent the lattice spans (see ctor JSDoc) */
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
     * Grid so it can refresh its public totals and notify consumers on
     * resize-driven re-tiling.
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

    /** @type {number} current devicePixelRatio (clamped to 2) */
    const _initialDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    this.dpr = Math.min(_initialDpr, 2)

    // THERE IS NO BLOCK LIST. This class used to materialise one descriptor
    // object per cell here — 24,786 of them on a full page, rebuilt on every
    // resize — for a per-block pull model that the field path had already made
    // unreachable. A cell's position is `origin + index * step`, which is
    // cheaper to compute than to look up; the array was pure rent.

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
    // The container is NOT measured. It used to be, for a `width`/`height`
    // pair nothing reads any more — and measuring it here meant a forced
    // layout on every DPR event and every ResizeObserver tick, to fill two
    // fields that had already stopped being the lattice's authority.
    // DPR clamped to 2 to match prototype behavior — on 3x/4x displays the
    // cost of rendering at native density isn't worth the extra sharpness
    // for a field of 20px blocks, and canvas.width hits backing-store limits
    // on very large viewports.
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    this.dpr = Math.min(rawDpr, 2)

    // Canvas intrinsic size is NOT written here. Each plane's canvas covers a
    // band of the document and only the Renderer knows which band, so it sizes
    // them (Renderer.setPlaneBox). Writing an intrinsic size from a measured
    // one is also what made the old runaway loop possible — the warning that
    // guarded it moved to the Renderer with the write.

    // The lattice is document space, and these are its only inputs. No
    // fallback to the measured canvas: a canvas is a band now, and solving the
    // lattice against a band would make the lattice depend on which slice of
    // the page happens to be rasterised.
    const effW = this.fieldWidth
    const effH = this.fieldHeight
    if (!(effW > 0) || !(effH > 0)) return

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

    if (this.step && this.step > 0) {
      const fit = this.step_ > 0 ? Math.floor((effH - this.gap) / this.step_) : this.minCountY
      this.countY = Math.max(this.minCountY, fit)
    }
    const topologyChanged =
      this.countX !== prevCountX || this.countY !== prevCountY

    // Both origins are the gap, flat. The vertical remainder used to be split
    // as outer margin so a viewport-tall field would not sit bottom-biased;
    // there is no such thing as centring a field that is the whole document,
    // and a centring term would put row 0 at an offset that changes whenever
    // the page grows a paragraph. originY is a document coordinate: row 0 is
    // one gap below the top of the page, and stays there.
    this.originX = this.gap
    this.originY = this.gap

    // Notify Grid of topology change driven by ResizeObserver / DPR
    // events. `silent` is set by reconfigure() which routes the
    // notification through Grid.reconfigure() instead.
    if (topologyChanged && !opts.silent && typeof this._onTopologyChange === 'function') {
      this._onTopologyChange()
    }
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
   * The container is watched for DPR-adjacent churn and as a cheap signal
   * that the page reflowed. It is NOT how the lattice learns its size: the
   * document extent is not observable from one canvas, so the consumer pushes
   * it in with `reconfigure({ fieldWidth, fieldHeight })`.
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
