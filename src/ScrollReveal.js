/**
 * Scroll-driven row reveal animation.
 *
 * When enabled, all blocks start invisible. As rows scroll into the
 * viewport, they reveal with a left-to-right staggered animation:
 * each block slides in from the right and fades in, with a small
 * delay between columns creating a wave effect.
 *
 * Rows that are already inside the viewport when ScrollReveal is
 * created are pre-revealed synchronously in the constructor — they
 * appear at full opacity from the very first frame with no animation.
 *
 * Values derived from prototype.html visual specification:
 *   - staggerDelay: 6ms between columns
 *   - riseDuration: 35ms per block
 *   - slideRatio: 0.55 × step (blockSize + gap) horizontal offset
 *   - Easing: smoothstep (Hermite cubic)
 *
 * Total row reveal duration: (countX - 1) × staggerDelay + riseDuration
 * For an 80-column grid: (79 × 6) + 35 = 509ms
 */
export class ScrollReveal {
  /**
   * @param {import('./Grid.js').Grid} grid
   * @param {Object} [options]
   * @param {number} [options.staggerDelay=6] - ms delay between columns
   * @param {number} [options.riseDuration=35] - ms per block fade/slide
   * @param {number} [options.slideRatio=0.55] - horizontal slide as factor of step
   * @param {number} [options.rowStagger=30] - ms delay between rows entering on the same frame
   * @param {() => number} [options.getScrollY] - optional callback returning the current
   *   scroll offset (in px) to subtract from each block's document-space Y before
   *   testing viewport visibility. Required when the canvas is position:fixed and blocks
   *   live in document coordinates (fieldHeight mode). Omit for normal scrolling canvases.
   */
  constructor(grid, options = {}) {
    this._grid = grid
    this._layout = grid._layout
    this._staggerDelay = options.staggerDelay ?? 6
    this._riseDuration = options.riseDuration ?? 35
    this._slideRatio = options.slideRatio ?? 0.55
    this._rowStagger = options.rowStagger ?? 30
    /** @type {(() => number)|null} */
    this._getScrollY = options.getScrollY ?? null

    /** @type {Map<number, {seen:boolean, enteredAt:number, reveal:number, startCol:number}>} */
    this._rowMeta = new Map()
    /** @type {number} */
    this._lastFrameTime = -1
    /** @type {boolean} */
    this._allRevealed = false

    // Synchronously scan the viewport so rows already on-screen are
    // marked seen + reveal=1 before the first animation frame fires.
    // This guarantees no flash or stagger animation for initially-
    // visible blocks — they appear at full opacity from frame zero.
    this._initRows()

    this._controller = grid.registerAnimation('scroll-reveal', (block, time) => {
      return this._evaluate(block, time)
    })
    this._controller.play()
  }

  /**
   * Initialize per-row metadata. Rows currently in the viewport are
   * pre-revealed (seen=true, reveal=1) so they never animate in.
   * Rows below the fold start hidden (seen=false, reveal=0).
   * @private
   */
  _initRows() {
    this._rowMeta.clear()

    const rect = this._layout.container.getBoundingClientRect()
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0
    const scrollY = this._getScrollY ? this._getScrollY() : 0

    for (let row = 0; row < this._layout.countY; row++) {
      const blockY =
        this._layout.gapY + row * (this._layout.blockSize + this._layout.gapY)
      const screenY = rect.top + blockY - scrollY
      const inViewport =
        screenY + this._layout.blockSize >= 0 && screenY <= vh

      this._rowMeta.set(row, {
        seen: inViewport,
        enteredAt: 0,  // unused for pre-revealed rows (reveal=1 guard short-circuits)
        reveal: inViewport ? 1 : 0,
        startCol: 0,
      })
    }
  }

  /**
   * Per-block evaluation. Called by the animation stack every frame
   * for every block. Returns opacity and position offsets that make
   * unseen blocks invisible and animate them in when their row
   * enters the viewport.
   *
   * @param {Object} block
   * @param {number} time - local animation time (ms)
   * @returns {Object|null}
   * @private
   */
  _evaluate(block, time) {
    if (this._allRevealed) return null

    // Update row visibility once per frame (not per block).
    if (this._lastFrameTime !== time) {
      this._lastFrameTime = time
      this._updateVisibility(time)
    }

    const meta = this._rowMeta.get(block.row)
    if (!meta || !meta.seen) {
      return { opacityOffset: -1 }
    }

    // Pre-revealed rows (seen at construction time or fully animated)
    // contribute nothing — base state opacity is correct.
    if (meta.reveal >= 1) return null

    // Per-block stagger timing.
    const colOffset = block.col - meta.startCol
    const blockElapsed = time - meta.enteredAt - colOffset * this._staggerDelay
    const progress = smoothstep(0, this._riseDuration, blockElapsed)

    if (progress >= 1) return null

    const step = this._layout.blockSize + this._layout.gapX

    return {
      opacityOffset: -(1 - progress),
      offsetPosition: {
        x: (1 - progress) * step * this._slideRatio,
        y: 0,
      },
    }
  }

  /**
   * Check which rows are now in the viewport and update reveal
   * progress for animating rows. Called once per frame.
   *
   * @param {number} time - local animation time (ms)
   * @private
   */
  _updateVisibility(time) {
    let unseenCount = 0
    let animatingCount = 0

    const rect = this._layout.container.getBoundingClientRect()
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0
    const scrollY = this._getScrollY ? this._getScrollY() : 0
    const totalDuration = Math.max(
      1,
      (this._layout.countX - 1) * this._staggerDelay + this._riseDuration,
    )

    // Collect rows entering this frame so we can apply row stagger.
    const entering = []

    for (const [row, meta] of this._rowMeta) {
      if (!meta.seen) {
        const blockY =
          this._layout.gapY +
          row * (this._layout.blockSize + this._layout.gapY)
        const screenY = rect.top + blockY - scrollY

        if (
          screenY + this._layout.blockSize >= 0 &&
          screenY <= vh
        ) {
          entering.push(meta)
          meta.seen = true
          meta.startCol = 0
          // Sentinel so the reveal update below computes (time - ∞) → -∞,
          // not (time - 0) → >>1. The real enteredAt is set after the loop
          // with per-row stagger applied. Without this, any row entering after
          // the first ~509ms of animation time is instantly marked reveal=1
          // (no slide-in animation).
          meta.enteredAt = Infinity
        } else {
          unseenCount++
          continue
        }
      }

      if (meta.reveal < 1) {
        meta.reveal = Math.min(
          (time - meta.enteredAt) / totalDuration,
          1,
        )
        if (meta.reveal < 1) animatingCount++
      }
    }

    // Apply row stagger: when multiple rows enter on the same frame,
    // offset each successive row's enteredAt so they cascade top→bottom.
    for (let i = 0; i < entering.length; i++) {
      entering[i].enteredAt = time + i * this._rowStagger
    }

    this._allRevealed = unseenCount === 0 && animatingCount === 0
  }

  /**
   * Called by Grid.reconfigure() when totalBlocks changed (countX or
   * countY was modified). Reinitializes row metadata for the new row
   * count while preserving reveal state for rows that still exist.
   * New rows that are already in the viewport are pre-revealed
   * synchronously (no flash). Rows below the fold start hidden.
   */
  _onLayoutChange() {
    const oldMeta = this._rowMeta
    this._rowMeta = new Map()
    this._allRevealed = false

    const rect = this._layout.container.getBoundingClientRect()
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0
    const scrollY = this._getScrollY ? this._getScrollY() : 0

    for (let row = 0; row < this._layout.countY; row++) {
      const existing = oldMeta.get(row)
      if (existing && existing.seen) {
        // Row already revealed — keep its state.
        this._rowMeta.set(row, existing)
      } else {
        // New row or previously unseen: check viewport synchronously.
        const blockY =
          this._layout.gapY + row * (this._layout.blockSize + this._layout.gapY)
        const screenY = rect.top + blockY - scrollY
        const inViewport =
          screenY + this._layout.blockSize >= 0 && screenY <= vh

        this._rowMeta.set(row, {
          seen: inViewport,
          enteredAt: 0,
          reveal: inViewport ? 1 : 0,
          startCol: 0,
        })
      }
    }
  }

  /**
   * Cancel the animation and clean up.
   */
  destroy() {
    if (this._controller) {
      this._controller.cancel()
      this._controller = null
    }
  }
}

/**
 * Hermite cubic interpolation (standard smoothstep).
 * t = clamp((x - a) / (b - a), 0, 1) → t² × (3 - 2t)
 *
 * @param {number} a - lower edge
 * @param {number} b - upper edge
 * @param {number} x - input value
 * @returns {number} 0..1
 */
function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
