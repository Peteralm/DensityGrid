import { Layout } from './Layout.js'
import { Renderer } from './Renderer.js'
import { AnimationStack } from './AnimationStack.js'
import { AnimationController } from './AnimationController.js'
import { ScrollReveal } from './ScrollReveal.js'

/**
 * Main grid class. Wires up Layout, AnimationStack, and Renderer
 * and exposes the public API described in CLAUDE.md §6.
 *
 * Instances are created through createGrid() in index.js — consumers
 * (e.g. gridBridge.js in the site project) should never new this
 * class directly.
 *
 * Ownership:
 *   Grid owns Layout, AnimationStack, and Renderer. Layout owns its
 *   own ResizeObserver. Renderer owns the rAF loop. Grid just wires
 *   them together and surfaces the public API.
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
   */
  constructor({ container, blockSize, countX, countY, step, minCountX, minCountY }) {
    /** @private @type {Array<() => void>} */
    this._resizeCbs = []

    /** @private @type {Layout} */
    this._layout = new Layout({
      container,
      blockSize,
      countX,
      countY,
      step,
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
    // public totals, re-inits ScrollReveal, and fans out to subscribers.
    this._layout._onTopologyChange = () => this._handleTopologyChange()
    /** @private @type {AnimationStack} */
    this._stack = new AnimationStack()
    /** @private @type {Renderer} */
    this._renderer = new Renderer({
      container,
      layout: this._layout,
      stack: this._stack,
    })

    // Public debug namespace. Frozen so consumers can safely
    // destructure (e.g. const { list, filter } = grid.debug).
    const stack = this._stack
    /** @type {{ list: () => Array<{name:string,status:string}>, filter: (names: string[]|null) => void }} */
    this.debug = Object.freeze({
      list: () => stack.list(),
      filter: (names) => stack.setFilter(names),
    })

    // Start the render loop immediately. An empty stack still
    // produces a valid base-state frame (opaque white blocks).
    this._renderer.start()
  }

  /**
   * Register a new animation. Returns a controller in IDLE state —
   * call controller.play() to start it.
   *
   * @param {string} name
   * @param {(block: Object, time: number) => Object} fn
   * @returns {AnimationController}
   */
  registerAnimation(name, fn) {
    return new AnimationController({ name, fn, stack: this._stack })
  }

  /**
   * Change grid parameters (blockSize, countX, countY) without
   * destroying running animations. Positions are recalculated,
   * the canvas is resized, but the AnimationStack keeps running
   * — time continues, PAUSED caches stay valid for blocks that
   * still exist, and new blocks appear at base state.
   *
   * If totalBlocks changed and ScrollReveal is active, it
   * reinitializes its row metadata (unseen rows will re-reveal
   * on scroll; already-revealed rows stay revealed).
   *
   * @param {Object} params
   * @param {number} [params.blockSize]
   * @param {number} [params.countX]
   * @param {number} [params.countY]
   */
  reconfigure(params) {
    const topologyChanged = this._layout.reconfigure(params)
    this.blockSize = this._layout.blockSize
    this.countX = this._layout.countX
    this.countY = this._layout.countY
    this.totalBlocks = this.countX * this.countY
    if (topologyChanged) {
      if (this._scrollReveal) this._scrollReveal._onLayoutChange()
      this._fireResize()
    }
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
    if (this._scrollReveal) this._scrollReveal._onLayoutChange()
    this._fireResize()
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

  /**
   * Enable scroll-driven row reveal. Blocks start invisible and
   * animate in row-by-row as they enter the viewport, with a
   * left-to-right stagger per column.
   *
   * @param {Object} [options]
   * @param {number} [options.staggerDelay=6] - ms delay between columns
   * @param {number} [options.riseDuration=35] - ms per block rise
   * @param {number} [options.slideRatio=0.55] - horizontal slide factor
   * @returns {ScrollReveal}
   */
  enableScrollReveal(options) {
    if (this._scrollReveal) this._scrollReveal.destroy()
    this._scrollReveal = new ScrollReveal(this, options)
    return this._scrollReveal
  }
}
