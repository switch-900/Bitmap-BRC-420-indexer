// Mondrian layout utilities for bitmap visualization
// Pattern data now comes from the database via the API endpoints:
// /api/bitmap/:bitmap_number/pattern - for specific bitmap patterns
// /api/bitmaps/search - for bitmap data with embedded pattern info

export const getSquareSize = (value) => {
    if (value / 100000000 === 0) return 1; // Transactions with a value of 0
    if (value / 100000000 <= 0.01) return 1;
    if (value / 100000000 <= 0.1) return 2;
    if (value / 100000000 <= 1) return 3;
    if (value / 100000000 <= 10) return 4;
    if (value / 100000000 <= 100) return 5;
    if (value / 100000000 <= 1000) return 6;
    if (value / 100000000 <= 10000) return 7;
    if (value / 100000000 <= 100000) return 8;
    if (value / 100000000 <= 1000000) return 9;
    return 9; // For values above 1000000 BTC
};

export class MondrianLayout {
    constructor(txList = []) {
        this.width = 0;
        this.height = 0;
        this.rowOffset = 0;
        this.rows = [];
        this.slots = [];

        let blockWeight = 0;
        for (const size of txList) {
            blockWeight += size * size;
        }

        this.length = Math.ceil(Math.sqrt(blockWeight));

        for (const size of txList) {
            this.place(size);
        }
    }

    getSize() {
        return {
            width: this.width,
            height: this.height
        };
    }

    getRow(position) {
        if (position.y - this.rowOffset < this.rows.length) {
            return this.rows[position.y - this.rowOffset];
        }
        return null;
    }

    getSlot(position) {
        const row = this.getRow(position);
        if (row !== null && row.map.has(position.x)) {
            return row.map.get(position.x);
        }
        return null;
    }

    addRow() {
        const newRow = {
            y: this.rows.length + this.rowOffset,
            slots: [],
            map: new Map(),
            max: 0
        };
        this.rows.push(newRow);
        return newRow;
    }

    addSlot(slot) {
        if (slot.size <= 0) {
            return null;
        }

        const existingSlot = this.getSlot(slot.position);
        if (existingSlot !== null) {
            existingSlot.size = Math.max(existingSlot.size, slot.size);
            return existingSlot;
        } else {
            const row = this.getRow(slot.position);
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
    }

    removeSlot(slot) {
        const row = this.getRow(slot.position);
        if (row !== null) {
            row.map.delete(slot.position.x);
            const index = row.slots.findIndex(s => s.position.x === slot.position.x);
            if (index !== -1) {
                row.slots.splice(index, 1);
            }
        }
    }

    fillSlot(slot, squareWidth) {
        const square = {
            left: slot.position.x,
            right: slot.position.x + squareWidth,
            bottom: slot.position.y,
            top: slot.position.y + squareWidth
        };

        this.removeSlot(slot);

        for (let rowIndex = slot.position.y; rowIndex < square.top; rowIndex++) {
            const row = this.getRow({x: slot.position.x, y: rowIndex});
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

                if (square.right < this.length && !row.map.has(square.right)) {
                    this.addSlot({
                        position: {x: square.right, y: rowIndex},
                        size: slot.size - squareWidth + maxExcess
                    });
                }

                for (let i = 0; i < collisions.length; i++) {
                    collisions[i].size = slot.position.x - collisions[i].position.x;

                    if (collisions[i].size === 0) {
                        this.removeSlot(collisions[i]);
                    }
                }
            } else {
                this.addRow();
                if (slot.position.x > 0) {
                    this.addSlot({
                        position: {x: 0, y: rowIndex},
                        size: slot.position.x
                    });
                }
                if (square.right < this.length) {
                    this.addSlot({
                        position: {x: square.right, y: rowIndex},
                        size: this.length - square.right
                    });
                }
            }
        }

        for (
            let rowIndex = Math.max(0, slot.position.y - squareWidth);
            rowIndex < slot.position.y;
            rowIndex++
        ) {
            const row = this.getRow({x: slot.position.x, y: rowIndex});
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
                            this.addSlot({
                                position: {x: remaining.x, y: remaining.y},
                                size: remaining.width
                            });
                            remaining.y += remaining.width;
                            remaining.height -= remaining.width;
                        } else {
                            this.addSlot({
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
    }

    place(size) {
        let found = false;
        let squareSlot = null;

        for (const row of this.rows) {
            for (const slot of row.slots) {
                if (slot.size >= size) {
                    found = true;
                    squareSlot = this.fillSlot(slot, size);
                    break;
                }
            }

            if (found) {
                break;
            }
        }

        if (!found) {
            const row = this.addRow();
            const slot = this.addSlot({position: {x: 0, y: row.y}, size: this.length});
            squareSlot = this.fillSlot(slot, size);
        }

        if (squareSlot.position.x + squareSlot.size > this.width) {
            this.width = squareSlot.position.x + squareSlot.size;
        }

        if (squareSlot.position.y + squareSlot.size > this.height) {
            this.height = squareSlot.position.y + squareSlot.size;
        }

        this.slots.push(squareSlot);

        return squareSlot;
    }

    fillEmptySpaces(bestSize = true) {
        let filledSlots = [];
        let occupied = Array.from({length: this.height}, () => Array(this.width).fill(false));

        for (let square of this.slots) {
            for (let i = 0; i < square.size; i++) {
                for (let j = 0; j < square.size; j++) {
                    occupied[square.position.y + i][square.position.x + j] = true;
                }
            }
        }

        if (bestSize) {
            const canPlaceSquare = (x, y, size) => {
                if (x + size > this.width || y + size > this.height) return false;
                for (let i = 0; i < size; i++) {
                    for (let j = 0; j < size; j++) {
                        if (occupied[y + i][x + j]) return false;
                    }
                }
                return true;
            };

            for (let size = Math.min(this.width, this.height); size > 1; size--) {
                for (let y = 0; y <= this.height - size; y++) {
                    for (let x = 0; x <= this.width - size; x++) {
                        if (canPlaceSquare(x, y, size)) {
                            filledSlots.push({position: {x: x, y: y}, size: size});
                            for (let i = 0; i < size; i++) {
                                for (let j = 0; j < size; j++) {
                                    occupied[y + i][x + j] = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Fill remaining spaces with 1x1 squares
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (!occupied[y][x]) {
                    filledSlots.push({position: {x: x, y: y}, size: 1});
                    occupied[y][x] = true;
                }
            }
        }

        return filledSlots;
    }
}

// Helper functions to work with pattern data

// Convert pattern string to array (e.g., "55443" to [5,5,4,4,3])
function getPatternArray(patternString) {
    if (!patternString || typeof patternString !== 'string') return [];
    return patternString.split('').map(Number);
}

// Get Mondrian layout from pattern array
function getMondrian(patternArray) {
    return new MondrianLayout(patternArray);
}

// Get Mondrian layout from bitmap data
function getMondrianFromBitmap(bitmap) {
    if (bitmap.pattern && typeof bitmap.pattern === 'string') {
        return getMondrian(getPatternArray(bitmap.pattern));
    } else if (bitmap.squareSizes && Array.isArray(bitmap.squareSizes)) {
        return getMondrian(bitmap.squareSizes);
    }
    return null;
}

// Generate random color for a square based on its size and position
function getSquareColor(size, position, saturation = 70, lightness = 50) {
    // Use position and size to generate deterministic but varied colors
    const hue = ((position.x * 73 + position.y * 97 + size * 139) % 360);
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

// Render Mondrian layout to canvas
function renderMondrianToCanvas(mondrian, canvas, options = {}) {
    const {
        cellSize = 20,
        strokeWidth = 2,
        backgroundColor = '#ffffff',
        strokeColor = '#000000',
        showEmptySpaces = true
    } = options;

    const ctx = canvas.getContext('2d');
    const { width, height } = mondrian.getSize();
    
    // Set canvas size
    canvas.width = width * cellSize;
    canvas.height = height * cellSize;
    
    // Clear canvas
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw transaction squares
    mondrian.slots.forEach((slot, index) => {
        const x = slot.position.x * cellSize;
        const y = slot.position.y * cellSize;
        const size = slot.size * cellSize;
        
        // Fill square with color
        ctx.fillStyle = getSquareColor(slot.size, slot.position);
        ctx.fillRect(x, y, size, size);
        
        // Draw border
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeWidth;
        ctx.strokeRect(x, y, size, size);
    });
    
    // Fill empty spaces if requested
    if (showEmptySpaces) {
        const emptySpaces = mondrian.fillEmptySpaces();
        emptySpaces.forEach(slot => {
            const x = slot.position.x * cellSize;
            const y = slot.position.y * cellSize;
            const size = slot.size * cellSize;
            
            // Fill with lighter color for empty spaces
            ctx.fillStyle = getSquareColor(slot.size, slot.position, 30, 80);
            ctx.fillRect(x, y, size, size);
            
            // Draw border
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = strokeWidth;
            ctx.strokeRect(x, y, size, size);
        });
    }
}

// API integration functions for database-driven patterns

// Fetch bitmap pattern from API
async function fetchBitmapPattern(bitmapNumber) {
    try {
        const response = await fetch(`/api/bitmap/${bitmapNumber}/pattern`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data.pattern;
    } catch (error) {
        console.error('Error fetching bitmap pattern:', error);
        return null;
    }
}

// Fetch bitmap data with pattern from search API
async function fetchBitmapsWithPatterns(searchParams = {}) {
    try {
        const queryString = new URLSearchParams(searchParams).toString();
        const response = await fetch(`/api/bitmaps/search?${queryString}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching bitmaps with patterns:', error);
        return { bitmaps: [], total: 0 };
    }
}

// Create Mondrian preview for bitmap card
async function createMondrianPreview(bitmapNumber, canvasId, options = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
        console.error(`Canvas with id ${canvasId} not found`);
        return;
    }

    const pattern = await fetchBitmapPattern(bitmapNumber);
    if (!pattern) {
        // Show placeholder or error state
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#666';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('No pattern', canvas.width / 2, canvas.height / 2);
        return;
    }

    const patternArray = getPatternArray(pattern);
    const mondrian = getMondrian(patternArray);
    
    const defaultOptions = {
        cellSize: 8,
        strokeWidth: 1,
        showEmptySpaces: false
    };
    
    renderMondrianToCanvas(mondrian, canvas, { ...defaultOptions, ...options });
}

// Make functions globally available (for browser usage)
if (typeof window !== 'undefined') {
    window.MondrianLayout = MondrianLayout;
    window.getSquareSize = getSquareSize;
    window.getPatternArray = getPatternArray;
    window.getMondrian = getMondrian;
    window.getMondrianFromBitmap = getMondrianFromBitmap;
    window.getSquareColor = getSquareColor;
    window.renderMondrianToCanvas = renderMondrianToCanvas;
    window.fetchBitmapPattern = fetchBitmapPattern;
    window.fetchBitmapsWithPatterns = fetchBitmapsWithPatterns;
    window.createMondrianPreview = createMondrianPreview;
}
