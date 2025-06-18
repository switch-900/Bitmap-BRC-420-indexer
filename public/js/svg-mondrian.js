/**
 * SVG-First Mondrian Generator
 * Uses the exact MondrianLayout algorithm from mondrian.js
 * NO COLOR PALETTE - follows original Mondrian pattern structure
 */

class SVGMondrianGenerator {
    constructor() {
        // No color palette - Mondrian patterns are structural, not colored
    }    /**
     * Generate optimized SVG from transaction data using exact MondrianLayout algorithm
     * @param {Array} txList - Array of transaction square sizes (1-9)
     * @param {Object} options - Generation options
     * @returns {String} Optimized SVG string
     */
    generateSVG(txList, options = {}) {
        const {
            width = 400,
            height = 400,
            margin = 20,
            optimize = true
        } = options;

        if (!txList || txList.length === 0) {
            return this.generateErrorSVG(width, height, 'No transaction data');
        }

        try {
            // Convert string format "554433221" to array [5,5,4,4,3,3,2,2,1] if needed
            let squareSizes;
            if (typeof txList === 'string') {
                squareSizes = txList.split('').map(Number);
            } else if (Array.isArray(txList)) {
                squareSizes = txList;
            } else {
                throw new Error('Invalid txList format');
            }
            
            // Use the exact MondrianLayout algorithm from mondrian.js
            const layout = this.createMondrianLayout(squareSizes);
            
            // Calculate scaling to fit within the SVG bounds
            const availableSize = Math.min(width, height) - (margin * 2);
            const scale = Math.min(
                availableSize / layout.width, 
                availableSize / layout.height
            );

            // Generate SVG with proper Mondrian squares (no colors)
            const svg = this.renderToSVG(layout, scale, width, height, margin);
            
            return optimize ? this.optimizeSVG(svg) : svg;
        } catch (error) {
            console.error('SVG generation error:', error);
            return this.generateErrorSVG(width, height, 'Generation failed');        }
    }

    /**
     * Create Mondrian layout using the exact algorithm from mondrian.js
     * This replicates the MondrianLayout class behavior in SVG form
     */
    createMondrianLayout(squareSizes) {
        // Initialize layout state
        let width = 0;
        let height = 0;
        let rowOffset = 0;
        let rows = [];
        let slots = [];

        // Calculate block weight and initial length (exact MondrianLayout algorithm)
        let blockWeight = 0;
        for (const size of squareSizes) {
            blockWeight += size * size;
        }
        const length = Math.ceil(Math.sqrt(blockWeight));

        // Helper functions (replicated from MondrianLayout)
        const getRow = (position) => {
            if (position.y - rowOffset < rows.length) {
                return rows[position.y - rowOffset];
            }
            return null;
        };

        const getSlot = (position) => {
            const row = getRow(position);
            if (row !== null && row.map.has(position.x)) {
                return row.map.get(position.x);
            }
            return null;
        };

        const addRow = () => {
            const newRow = {
                y: rows.length + rowOffset,
                slots: [],
                map: new Map(),
                max: 0
            };
            rows.push(newRow);
            return newRow;
        };

        const addSlot = (slot) => {
            if (slot.size <= 0) {
                return null;
            }

            const existingSlot = getSlot(slot.position);
            if (existingSlot !== null) {
                existingSlot.size = Math.max(existingSlot.size, slot.size);
                return existingSlot;
            } else {
                const row = getRow(slot.position);
                if (row === null) {
                    return null;
                }

                const insertAt = row.slots.findIndex(s => s.position.x > slot.position.x);
                if (insertAt === -1) {
                    row.slots.push(slot);
                } else {
                    row.slots.splice(insertAt, 0, slot);
                }

                row.map.set(slot.position.x, slot);
                return slot;
            }
        };

        const removeSlot = (slot) => {
            const row = getRow(slot.position);
            if (row !== null) {
                row.map.delete(slot.position.x);
                const index = row.slots.findIndex(s => s.position.x === slot.position.x);
                if (index !== -1) {
                    row.slots.splice(index, 1);
                }
            }
        };

        const fillSlot = (slot, squareWidth) => {
            const square = {
                left: slot.position.x,
                right: slot.position.x + squareWidth,
                bottom: slot.position.y,
                top: slot.position.y + squareWidth
            };

            removeSlot(slot);

            for (let rowIndex = slot.position.y; rowIndex < square.top; rowIndex++) {
                const row = getRow({x: slot.position.x, y: rowIndex});
                if (row !== null) {
                    const collisions = [];
                    let maxExcess = 0;
                    for (const testSlot of row.slots) {
                        if (
                            !(
                                testSlot.position.x + testSlot.size < square.left ||
                                testSlot.position.x >= square.right
                            )
                        ) {
                            collisions.push(testSlot);
                            const excess = Math.max(
                                0,
                                testSlot.position.x + testSlot.size - (slot.position.x + slot.size)
                            );
                            maxExcess = Math.max(maxExcess, excess);
                        }
                    }

                    if (square.right < length && !row.map.has(square.right)) {
                        addSlot({
                            position: {x: square.right, y: rowIndex},
                            size: slot.size - squareWidth + maxExcess
                        });
                    }

                    for (let i = 0; i < collisions.length; i++) {
                        collisions[i].size = slot.position.x - collisions[i].position.x;

                        if (collisions[i].size === 0) {
                            removeSlot(collisions[i]);
                        }
                    }
                } else {
                    addRow();
                    if (slot.position.x > 0) {
                        addSlot({
                            position: {x: 0, y: rowIndex},
                            size: slot.position.x
                        });
                    }
                    if (square.right < length) {
                        addSlot({
                            position: {x: square.right, y: rowIndex},
                            size: length - square.right
                        });
                    }
                }
            }

            // Handle vertical adjustments
            for (
                let rowIndex = Math.max(0, slot.position.y - squareWidth);
                rowIndex < slot.position.y;
                rowIndex++
            ) {
                const row = getRow({x: slot.position.x, y: rowIndex});
                if (row === null || row === undefined) continue;

                for (let i = 0; i < row.slots.length; i++) {
                    const testSlot = row.slots[i];

                    if (
                        testSlot.position.x < slot.position.x + squareWidth &&
                        testSlot.position.x + testSlot.size > slot.position.x &&
                        testSlot.position.y + testSlot.size >= slot.position.y
                    ) {
                        const oldSlotWidth = testSlot.size;
                        testSlot.size = slot.position.y - testSlot.position.y;

                        const remaining = {
                            x: testSlot.position.x + testSlot.size,
                            y: testSlot.position.y,
                            width: oldSlotWidth - testSlot.size,
                            height: testSlot.size
                        };

                        while (remaining.width > 0 && remaining.height > 0) {
                            if (remaining.width <= remaining.height) {
                                addSlot({
                                    position: {x: remaining.x, y: remaining.y},
                                    size: remaining.width
                                });
                                remaining.y += remaining.width;
                                remaining.height -= remaining.width;
                            } else {
                                addSlot({
                                    position: {x: remaining.x, y: remaining.y},
                                    size: remaining.height
                                });
                                remaining.x += remaining.height;
                                remaining.width -= remaining.height;
                            }
                        }
                    }
                }
            }

            return {position: slot.position, size: squareWidth};
        };

        const place = (size) => {
            let found = false;
            let squareSlot = null;

            for (const row of rows) {
                for (const slot of row.slots) {
                    if (slot.size >= size) {
                        found = true;
                        squareSlot = fillSlot(slot, size);
                        break;
                    }
                }

                if (found) {
                    break;
                }
            }

            if (!found) {
                const row = addRow();
                const slot = addSlot({position: {x: 0, y: row.y}, size: length});
                squareSlot = fillSlot(slot, size);
            }

            if (squareSlot.position.x + squareSlot.size > width) {
                width = squareSlot.position.x + squareSlot.size;
            }

            if (squareSlot.position.y + squareSlot.size > height) {
                height = squareSlot.position.y + squareSlot.size;
            }

            slots.push(squareSlot);
            return squareSlot;
        };

        // Place each square using the exact MondrianLayout algorithm
        for (const size of squareSizes) {
            place(size);
        }

        return {
            slots,
            width,
            height
        };
    }

    /**
     * Render layout to optimized SVG (no color palette - just black squares on white)
     */
    renderToSVG(layout, scale, width, height, margin) {
        const shapes = layout.slots.map(slot => {
            const x = margin + (slot.position.x * scale);
            const y = margin + (slot.position.y * scale);
            const size = slot.size * scale;

            // Simple black squares (no color palette)
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" fill="#000000" stroke="#ffffff" stroke-width="0.5"/>`;
        }).join('');

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
${shapes}
</svg>`;
    }

    /**
     * Apply SVGO-style optimizations for geometric content
     */
    optimizeSVG(svg) {
        return svg
            // Remove unnecessary whitespace
            .replace(/>\s+</g, '><')
            // Round coordinates to 1 decimal place
            .replace(/(\d+\.\d{2,})/g, (match) => parseFloat(match).toFixed(1))
            // Remove redundant attributes
            .replace(/fill="([^"]+)"\s+fill="\1"/g, 'fill="$1"')
            .trim();
    }    /**
     * Generate error SVG for fallback scenarios
     */
    generateErrorSVG(width, height, message) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="50%" y="50%" text-anchor="middle" fill="#000000" font-family="Arial" font-size="14">${message}</text>
</svg>`;
    }

    /**
     * Generate compressed binary metadata for caching
     */
    generateMetadata(txList, layoutId) {
        return {
            id: layoutId,
            version: '1.0',
            timestamp: Date.now(),
            txCount: txList.length,
            complexity: this.calculateComplexity(txList),
            format: 'svg',
            algorithm: 'mondrian-layout'
        };
    }

    /**
     * Calculate layout complexity for optimization decisions
     */    calculateComplexity(txList) {
        if (txList.length < 10) return 'simple';
        if (txList.length < 100) return 'medium';
        if (txList.length < 1000) return 'complex';
        return 'ultra';
    }
}

// Export for use in main application
window.SVGMondrianGenerator = SVGMondrianGenerator;
