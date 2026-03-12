const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables (set these in Render dashboard)
const API_BASE = process.env.API_BASE; // No default - must be set in Render
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 30000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Proxy endpoint - all URLs are constructed server-side
app.post('/proxy', async (req, res) => {
    const { endpoint, method, headers, data } = req.body;
    
    if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint is required' });
    }

    // Construct full URL server-side using environment variable
    const url = `${API_BASE}${endpoint}`;
    
    // Validate that we're only calling API
    if (!url.startsWith(API_BASE)) {
        return res.status(403).json({ error: 'Invalid endpoint' });
    }

    // Prepare headers
    const proxyHeaders = {
        ...headers,
        'User-Agent': 'Card-Crafter/1.0',
    };

    // Remove headers that might cause issues
    delete proxyHeaders['host'];
    delete proxyHeaders['origin'];
    delete proxyHeaders['referer'];

    try {
        const response = await axios({
            url: url,
            method: method || 'GET',
            headers: proxyHeaders,
            data: data,
            timeout: REQUEST_TIMEOUT,
            validateStatus: null
        });

        console.log(`[${new Date().toISOString()}] ${method} ${endpoint} -> ${response.status}`);
        res.status(response.status).json(response.data);
    } catch (error) {
        console.error(`Proxy error:`, error.message);
        
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({ error: 'Request timeout' });
        }
        
        res.status(500).json({ error: 'Proxy error', message: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        apiConfigured: !!API_BASE
    });
});

// Redirect root to crafter
app.get('/', (req, res) => {
    res.redirect('/crafter');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API Base: ${API_BASE}`);
});