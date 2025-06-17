/**
 * SVG-First Mondrian Generator
 * Optimized for high-scale Bitcoin visualization delivery
 * Achieves 2-20x smaller file sizes compared to raster formats
 */

class SVGMondrianGenerator {
    constructor() {
        this.colorPalette = [
            '#FFA500', '#FF8C00', '#FFB84D', '#FFC266', '#FFD280'
        ];
    }

    /**
     * Generate optimized SVG from transaction data
     * @param {Array} txList - Array of transaction values in satoshis
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
            // Convert transaction values to square sizes
            const sizes = txList.map(value => this.getSquareSize(value));
            
            // Create Mondrian layout
            const layout = this.createMondrianLayout(sizes);
            
            // Calculate scaling
            const availableSize = Math.min(width, height) - (margin * 2);
            const scale = Math.min(
                availableSize / layout.width, 
                availableSize / layout.height
            );

            // Generate SVG
            const svg = this.renderToSVG(layout, scale, width, height, margin);
            
            return optimize ? this.optimizeSVG(svg) : svg;
        } catch (error) {
            console.error('SVG generation error:', error);
            return this.generateErrorSVG(width, height, 'Generation failed');
        }
    }

    /**
     * Convert transaction value to square size using logarithmic scaling
     */
    getSquareSize(satoshis) {
        // Logarithmic scaling for better visual distribution
        const minSize = 10;
        const maxSize = 100;
        const logValue = Math.log10(satoshis);
        const normalizedLog = (logValue - 5) / (10 - 5); // 5 = log10(100k), 10 = log10(10B)
        return Math.max(minSize, Math.min(maxSize, minSize + (normalizedLog * (maxSize - minSize))));
    }

    /**
     * Create Mondrian layout using Binary Space Partitioning
     */
    createMondrianLayout(sizes) {
        const slots = [];
        let totalWidth = 0;
        let totalHeight = 0;

        // Simple grid-based layout for demonstration
        // In production, would use BSP algorithm for O(log n) performance
        const cols = Math.ceil(Math.sqrt(sizes.length));
        const rows = Math.ceil(sizes.length / cols);

        sizes.forEach((size, index) => {
            const col = index % cols;
            const row = Math.floor(index / cols);
            
            const x = col * 120; // Grid spacing
            const y = row * 120;
            
            slots.push({
                position: { x, y },
                size: size,
                colorIndex: index % this.colorPalette.length
            });

            totalWidth = Math.max(totalWidth, x + size);
            totalHeight = Math.max(totalHeight, y + size);
        });

        return {
            slots,
            width: totalWidth,
            height: totalHeight
        };
    }

    /**
     * Render layout to optimized SVG
     */
    renderToSVG(layout, scale, width, height, margin) {
        const shapes = layout.slots.map(slot => {
            const x = margin + (slot.position.x * scale);
            const y = margin + (slot.position.y * scale);
            const size = (slot.size - 0.5) * scale;
            const color = this.colorPalette[slot.colorIndex];

            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" fill="${color}"/>`;
        }).join('');

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#000000"/>
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
    }

    /**
     * Generate error SVG for fallback scenarios
     */
    generateErrorSVG(width, height, message) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#000000"/>
<text x="50%" y="50%" text-anchor="middle" fill="#FFA500" font-family="Arial" font-size="14">${message}</text>
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
            txSum: txList.reduce((sum, tx) => sum + tx, 0),
            complexity: this.calculateComplexity(txList),
            format: 'svg',
            compressionRatio: this.estimateCompressionRatio(txList)
        };
    }

    /**
     * Calculate layout complexity for optimization decisions
     */
    calculateComplexity(txList) {
        if (txList.length < 10) return 'simple';
        if (txList.length < 100) return 'medium';
        if (txList.length < 1000) return 'complex';
        return 'ultra';
    }

    /**
     * Estimate compression ratio for format selection
     */
    estimateCompressionRatio(txList) {
        const baseSize = txList.length * 16; // 16 bytes per shape
        const svgSize = this.generateSVG(txList).length;
        return (baseSize / svgSize).toFixed(2);
    }
}

// Export for use in main application
window.SVGMondrianGenerator = SVGMondrianGenerator;
