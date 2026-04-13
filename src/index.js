import { Grid } from './Grid.js'

/**
 * Factory for the density grid. Thin wrapper around the Grid class
 * so consumers always go through a stable functional entry point
 * and never depend on the class identity directly.
 *
 * @param {Object} options
 * @param {HTMLCanvasElement} options.container - canvas element to render into
 * @param {number} options.blockSize - block size in px
 * @param {number} [options.countX] - fixed column count (omit when using step)
 * @param {number} [options.countY] - fixed row count (omit when using step)
 * @param {number} [options.step] - block+gap target in px; enables auto-count
 *   mode where countX/countY are derived from container size on resize.
 * @param {number} [options.minCountX] - floor for step-derived countX
 * @param {number} [options.minCountY] - floor for step-derived countY
 * @returns {Grid}
 */
export function createGrid(options) {
  return new Grid(options)
}
