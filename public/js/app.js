const API_URL = 'http://localhost:5000/api';  // Base URL for API
const CONTENT_URL = 'https://ordinals.com';  // Base URL for content

document.addEventListener('DOMContentLoaded', function () {
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
