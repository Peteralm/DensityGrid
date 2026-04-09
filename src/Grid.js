import { Layout } from './Layout.js'
import { Renderer } from './Renderer.js'
import { AnimationStack } from './AnimationStack.js'
import { AnimationController } from './AnimationController.js'

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
   * @param {number} options.countX
   * @param {number} options.countY
   */
  constructor({ container, blockSize, countX, countY }) {
    /** @type {number} block size in px */
    this.blockSize = blockSize
    /** @type {number} number of blocks on the X axis */
    this.countX = countX
    /** @type {number} number of blocks on the Y axis */
    this.countY = countY
    /** @type {number} countX * countY */
    this.totalBlocks = countX * countY

    /** @private @type {Layout} */
    this._layout = new Layout({ container, blockSize, countX, countY })
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
}
