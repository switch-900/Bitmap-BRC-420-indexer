// Dynamically determine API URL based on current host
const API_URL = `${window.location.protocol}//${window.location.host}/api`;

// Try to detect local Ordinals service, fallback to ordinals.com
let CONTENT_URL = 'https://ordinals.com';  // Default fallback

// Function to detect local Ordinals service
async function detectLocalOrdinals() {
    try {
        // First, try to get config from our own API
        const configResponse = await fetch(`${API_URL}/config`);
        if (configResponse.ok) {
            const config = await configResponse.json();
            if (config.localOrdinalsUrl) {
                // Test if the local Ordinals service is actually available
                try {
                    const testResponse = await fetch(`${config.localOrdinalsUrl}/status`, { 
                        method: 'GET', 
                        signal: AbortSignal.timeout(3000),
                        mode: 'cors'
                    });
                    if (testResponse.ok) {
                        CONTENT_URL = config.localOrdinalsUrl;
                        console.log('Local Ordinals service detected via config:', CONTENT_URL);
                        return;
                    }
                } catch (error) {
                    console.log('Config provided URL not accessible:', error.message);
                }
            }
        }
    } catch (error) {
        console.log('Could not fetch config:', error.message);
    }            // Fallback: Try common local hosts (prioritize umbrel.local)
            const localHosts = [
                'umbrel.local:4000',     // Umbrel's standard hostname
                `${window.location.hostname}:4000`,  // Same host as the indexer
                'localhost:4000',
                '127.0.0.1:4000'
            ];
    
    for (const host of localHosts) {
        try {
            const testUrl = `${window.location.protocol}//${host}`;
            const response = await fetch(`${testUrl}/status`, { 
                method: 'GET', 
                signal: AbortSignal.timeout(2000),
                mode: 'cors'
            });
            if (response.ok) {
                CONTENT_URL = testUrl;
                console.log('Local Ordinals service detected at:', CONTENT_URL);
                return;
            }
        } catch (error) {
            // Continue to next host
        }
    }
    console.log('No local Ordinals service found, using fallback:', CONTENT_URL);
}

document.addEventListener('DOMContentLoaded', async function () {
    // Try to detect local Ordinals service first
    await detectLocalOrdinals();
    loadDeploys();
});

function loadDeploys() {
    fetch(`${API_URL}/deploys/with-mints`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json();
        })
        .then(data => {
            const deployContainer = document.getElementById('deployContainer');
            deployContainer.innerHTML = '';
            data.forEach(deploy => {
                const deployElement = document.createElement('div');
                deployElement.className = 'deploy';
                deployElement.style.position = 'relative';  // Ensure relative positioning for overlay

                // Create the iframe with the correct content URL
                const iframe = document.createElement('iframe');
                iframe.src = `${CONTENT_URL}/preview/${deploy.source_id}`;
                iframe.frameBorder = '0';
                iframe.style.width = '100%';
                iframe.style.height = '100%';
                
                // Create the overlay
                const overlay = document.createElement('div');
                overlay.className = 'overlay';
                overlay.style.position = 'absolute';
                overlay.style.top = '0';
                overlay.style.left = '0';
                overlay.style.width = '100%';
                overlay.style.height = '100%';
                overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';  // Slightly transparent overlay
                overlay.style.cursor = 'pointer';
                
                // Click event to load the deploy details
                overlay.onclick = () => loadDeployDetails(deploy.id);

                // Append the iframe and overlay to the deploy element
                deployElement.appendChild(iframe);
                deployElement.appendChild(overlay);
                
                // Append the deploy element to the container
                deployContainer.appendChild(deployElement);
            });
        })
        .catch(error => console.error('Error loading deploys:', error));
}

function loadDeployDetails(deployId) {
    window.location.href = `deploy.html?id=${deployId}`;
}
function loadBitmaps(query = '') {
    if (isLoading) return;
    isLoading = true;
    lastQuery = query;

    const bitmapContainer = document.getElementById('bitmapContainer');
    const loadingElement = document.getElementById('loading');

    loadingElement.style.display = 'block';


    fetch(`${API_URL}/bitmaps?page=${currentPage}&limit=20`)
        .then(response => {
            if (!response.ok) {
                throw new Error(`Network response was not ok: ${response.statusText}`);
            }
            return response.text(); // Use text() to manually parse JSON
        })
        .then(text => {
            try {
                const data = JSON.parse(text); // Parse the text to JSON
                if (data.length === 0) {
                    loadingElement.textContent = 'No more bitmaps to load.';
                    isLoading = false;
                    return;
                }

                data.forEach(bitmap => {
                    const bitmapElement = document.createElement('div');
                    bitmapElement.className = 'bitmap';

                    bitmapElement.innerHTML = `
                        <div><strong>Bitmap Number:</strong> ${bitmap.bitmap_number}</div>
                        <div class="bitmap-content"><strong>Content:</strong> ${bitmap.content}</div>
                        <div><strong>Address:</strong> ${bitmap.address}</div>
                        <div><strong>Block Height:</strong> ${bitmap.block_height}</div>
                        <div><strong>Timestamp:</strong> ${new Date(bitmap.timestamp).toLocaleString()}</div>
                    `;

                    // Click event to display the bitmap content in the iframe
                    bitmapElement.onclick = () => loadBitmapInIframe(bitmap.inscription_id);

                    bitmapContainer.appendChild(bitmapElement);
                });

                isLoading = false;
                loadingElement.style.display = 'none';
                currentPage++;
            } catch (error) {
                throw new Error('Failed to parse JSON: ' + error.message);
            }
        })
        .catch(error => {
            console.error('Error loading bitmaps:', error);
            isLoading = false;
            loadingElement.style.display = 'none';
        });
}


function performSearch() {
    const query = document.getElementById('searchInput').value;
    fetch(`${API_URL}/deploys?name=${query}`)
        .then(response => response.json())
        .then(data => {
            const deployContainer = document.getElementById('deployContainer');
            deployContainer.innerHTML = '';
            data.forEach(deploy => {
                const deployElement = document.createElement('div');
                deployElement.className = 'deploy';
                deployElement.style.position = 'relative';  // Ensure relative positioning for overlay

                // Create the iframe with the correct content URL
                const iframe = document.createElement('iframe');
                iframe.src = `${CONTENT_URL}/preview/${deploy.source_id}`;
                iframe.frameBorder = '0';
                iframe.style.width = '100%';
                iframe.style.height = '100%';
                
                // Create the overlay
                const overlay = document.createElement('div');
                overlay.className = 'overlay';
                overlay.style.position = 'absolute';
                overlay.style.top = '0';
                overlay.style.left = '0';
                overlay.style.width = '100%';
                overlay.style.height = '100%';
                overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';  // Slightly transparent overlay
                overlay.style.cursor = 'pointer';
                
                // Click event to load the deploy details
                overlay.onclick = () => loadDeployDetails(deploy.id);

                // Append the iframe and overlay to the deploy element
                deployElement.appendChild(iframe);
                deployElement.appendChild(overlay);
                
                // Append the deploy element to the container
                deployContainer.appendChild(deployElement);
            });
        })
        .catch(error => console.error('Error performing search:', error));
}
