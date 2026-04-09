import { Grid } from './Grid.js'

/**
 * Factory for the density grid. Thin wrapper around the Grid class
 * so consumers always go through a stable functional entry point
 * and never depend on the class identity directly.
 *
 * @param {Object} options
 * @param {HTMLCanvasElement} options.container - canvas element to render into
 * @param {number} options.blockSize - block size in px
 * @param {number} options.countX - number of blocks on the X axis
 * @param {number} options.countY - number of blocks on the Y axis
 * @returns {Grid}
 */
export function createGrid(options) {
  return new Grid(options)
}
