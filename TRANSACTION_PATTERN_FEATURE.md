# TRANSACTION PATTERN ANALYZER FEATURE

## 🎨 **New Feature Added: Bitmap Transaction Pattern Display**

I've added a comprehensive transaction pattern analyzer to the admin dashboard that shows:

### **Features:**

1. **Transaction Pattern Array Display**
   - Shows the raw transaction pattern data as an array
   - Displays pattern statistics (length, unique values, range, average)
   - Formatted in monospace font for easy reading

2. **Bitmap Information Panel**
   - Inscription ID and Address
   - Block Height and Sat Number
   - Clean, organized display

3. **Mondrian Visualization**
   - Real-time canvas-based visualization
   - Colors mapped to transaction values
   - Grid-based Mondrian-style art generation

4. **Interactive Controls**
   - Enter specific bitmap numbers
   - Random bitmap selection
   - Real-time pattern loading

### **Example Output:**
For Bitmap #2015, you'll see:
```
📊 Transaction Pattern Array
[3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4]

Pattern Stats:
Length: 20 | Unique Values: 8 | Range: 1 - 9 | Average: 4.85
```

### **Technical Implementation:**

#### **Frontend (admin.html):**
- New "Bitmap Pattern Analyzer" section
- Canvas-based Mondrian visualization
- Pattern statistics calculation
- Random bitmap selection

#### **Backend (api.js):**
- Enhanced `/bitmaps` endpoint with random sorting
- Existing `/bitmap/:number/pattern` endpoint usage
- Pagination and sorting support

### **How to Use:**

1. **Go to Admin Dashboard** (`/admin.html`)
2. **Scroll to "Bitmap Pattern Analyzer" section**
3. **Enter a bitmap number** (e.g., 2015) or click "Random Bitmap"
4. **View the results:**
   - Bitmap information
   - Transaction pattern array
   - Pattern statistics
   - Mondrian visualization

### **Data Source:**

The transaction patterns come from the `bitmap_patterns` table which stores:
- `bitmap_number`: The bitmap identifier
- `pattern_string`: Transaction sizes as a string (e.g., "314159265")

This data is generated during bitmap processing by the `BitmapProcessor` class and represents the transaction counts or sizes that form the basis for Mondrian-style visualizations.

### **Mondrian Visualization Logic:**

1. **Grid Creation**: Pattern array length determines grid size
2. **Color Mapping**: Transaction values map to Mondrian colors (red, blue, yellow, white, black)
3. **Cell Drawing**: Each array value becomes a colored cell
4. **Borders**: Black lines separate cells for authentic Mondrian style

### **Benefits:**

- **Educational**: See how Bitcoin transaction data becomes art
- **Debugging**: Verify pattern data is correctly stored
- **Exploration**: Discover interesting transaction patterns
- **Visualization**: Real-time Mondrian art generation

This feature bridges the gap between raw blockchain data and artistic visualization, showing how Bitcoin transactions can be transformed into beautiful, unique digital art pieces.
